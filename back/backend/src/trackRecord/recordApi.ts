import type { Address } from "viem";
import { z } from "zod";
import { SsrfError, safeFetch } from "../payments/ssrfGuard";
import { CappedReadAbortedError, readCappedText } from "../util/readStreamCapped";

/** The record body is a few kilobytes; anything near this is not the answer we asked for. */
export const RECORD_BODY_CAP_BYTES = 256 * 1024;
/** The provider's share of the route's 8 s bound (design 4.2.9). */
export const RECORD_TIMEOUT_MS = 4_000;

export type RecordFailure = "http" | "timeout" | "malformed" | "too_large";

/** Why the provider's record could not be read. The reason is served; the message is not. */
export class RecordSourceError extends Error {
  constructor(
    readonly reason: RecordFailure,
    message: string,
  ) {
    super(message);
    this.name = "RecordSourceError";
  }
}

const count = z.number().int().nonnegative().max(1_000_000);
/** Prices and targets arrive as numbers, numeric strings or null. Tolerated, never read. */
const numberish = z.union([z.number(), z.string().max(64), z.null()]).optional();

const MarketCall = z.object({
  asset: z.string().max(64).optional(),
  direction: z.string().max(64).optional(),
  priceAtLock: numberish,
  priceAtClose: numberish,
  target: numberish,
  priceChangeBps: numberish,
  moveBps: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
  gradedBy: z.string().max(64).optional(),
});

/** Every item field is optional: the card reads `marketCall.moveBps` and nothing else. */
const Item = z.object({
  id: z.number().int().nonnegative().optional(),
  lockedAt: z.string().max(40).optional(),
  windowEnd: z.string().max(40).optional(),
  status: z.string().max(32).optional(),
  result: z.string().max(16).nullable().optional(),
  certificateId: z.number().int().nonnegative().nullable().optional(),
  marketCall: MarketCall.nullable().optional(),
});

/**
 * The provider's record, as far as this code reads it (design 4.3.11). Unknown keys are
 * stripped, including the provider's `score` block, which is not agreed content.
 */
const RecordAnswer = z.object({
  /** The wallet the record is about, when the provider says: it must be the one asked for. */
  address: z.string().max(64).optional(),
  summary: z.object({
    total: count.optional(),
    verified: count.optional(),
    running: count.optional(),
    abandoned: count.optional(),
    marketCalls: z.object({ correct: count, wrong: count, void: count.optional() }),
  }),
  items: z.array(Item).max(500),
  recordUrl: z.string().max(512).nullable().optional(),
});

export interface ParsedRecord {
  graded: number;
  correct: number;
  wrong: number;
  /** The most negative `moveBps` over items that carry one; null when none does. */
  worstMoveBps: number | null;
  /** Null unless it is an https URL on the provider's own host (design 4.3.12). */
  recordUrl: string | null;
}

/**
 * A link is kept only when it points at the provider's own host over https: exactly that host,
 * no port, no userinfo. Anything else is dropped and the card shows no link.
 */
export function safeRecordUrl(raw: string | null | undefined, providerHost: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.host !== providerHost || u.port !== "") return null;
  if (u.username !== "" || u.password !== "") return null;
  if (!u.pathname.startsWith("/")) return null;
  return u.toString();
}

/**
 * Parse the provider's body. Throws `RecordSourceError("malformed")` on anything unexpected,
 * including a record about another wallet than `wallet` (a cache keyed without the query string,
 * or a provider bug, would otherwise serve someone else's record as this agent's).
 */
export function parseRecordAnswer(
  text: string,
  providerHost: string,
  wallet: Address,
): ParsedRecord {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RecordSourceError("malformed", "record answer is not JSON");
  }
  const parsed = RecordAnswer.safeParse(json);
  if (!parsed.success) throw new RecordSourceError("malformed", "record answer has another shape");
  const { address, summary, items, recordUrl } = parsed.data;
  if (address !== undefined && address.toLowerCase() !== wallet.toLowerCase())
    throw new RecordSourceError("malformed", "record answer is about another wallet");

  let worst: number | null = null;
  for (const item of items) {
    const move = item.marketCall?.moveBps;
    if (typeof move !== "number") continue;
    if (worst === null || move < worst) worst = move;
  }
  return {
    graded: summary.marketCalls.correct + summary.marketCalls.wrong,
    correct: summary.marketCalls.correct,
    wrong: summary.marketCalls.wrong,
    worstMoveBps: worst,
    recordUrl: safeRecordUrl(recordUrl, providerHost),
  };
}

/** The one URL built at runtime: config, a fixed path, a checksummed address (design 4.3.13). */
export function recordUrlFor(apiBase: string, address: Address): string {
  const u = new URL("/api/record", apiBase);
  u.searchParams.set("address", address);
  return u.toString();
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/**
 * Fetch the provider's record body for one wallet: public https only (no redirects, DNS
 * checked), a 4 s bound on the request, the body capped at 256 KiB. Every failure becomes a
 * `RecordSourceError` naming one reason.
 *
 * `signal` covers the body read: `safeFetch` installs its own timer for the request and clears it
 * once the headers arrive, so a body that trickles is cancelled through this signal instead (the
 * capped reader holds the stream's lock, so the signal goes to it).
 */
export async function fetchRecordText(
  fetchImpl: typeof fetch,
  apiBase: string,
  address: Address,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await safeFetch(
      fetchImpl,
      recordUrlFor(apiBase, address),
      { headers: { accept: "application/json" } },
      { timeoutMs: RECORD_TIMEOUT_MS },
    );
  } catch (e) {
    if (isAbort(e)) throw new RecordSourceError("timeout", "record request timed out");
    if (e instanceof SsrfError) throw new RecordSourceError("http", e.message);
    throw new RecordSourceError("http", "record request failed");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new RecordSourceError("http", `record answered ${res.status}`);
  }
  try {
    return await readCappedText(
      {
        body: res.body,
        contentLength: res.headers.get("content-length"),
        readAll: async () => Buffer.from(await res.arrayBuffer()),
      },
      RECORD_BODY_CAP_BYTES,
      {
        declared: () => new RecordSourceError("too_large", "record answer declared too large"),
        streamed: () => new RecordSourceError("too_large", "record answer too large"),
      },
      signal,
    );
  } catch (e) {
    if (e instanceof RecordSourceError) throw e;
    if (e instanceof CappedReadAbortedError || signal?.aborted || isAbort(e))
      throw new RecordSourceError("timeout", "record body timed out");
    throw new RecordSourceError("http", "record body could not be read");
  }
}
