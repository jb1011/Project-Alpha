import type { Context, Hono } from "hono";
import { getAddress, isAddress } from "viem";
import type { AuthVars } from "../../auth/middleware";
import type { FormationSummary } from "../../formation/status";
import { opsLog } from "../../observability/opsLog";
import type { LegalBodyResolution, LegalBodyResolver } from "../../payments/legalBody";
import type { EntityRecord } from "../../types";
import type { ApiDeps } from "../app";
import { TokenBucket } from "./agentBook";

/**
 * GET /legal-bodies/:address — "is this address the payment address of a Novi legal body in good
 * standing?" (design 2026-09-10 D3).
 *
 * PUBLIC and unauthenticated by design: the caller is a seller on someone else's stack who has
 * never heard of us and holds nothing but the address that is about to pay it. AgentBook answers
 * "is there a human?"; this answers the second question, and a seller that has to sign up for an
 * API key before it can ask is a seller that will not ask.
 *
 * Nothing here is new information about the ENTITY (§4): every one that resolves is already
 * listed on `/transparency` with its treasury, its agent id and its name. The payer→entity link is
 * the one new association — `/transparency` never publishes a pocket address — and it costs the
 * caller the address to obtain, which is an address AgentBook already binds in public.
 *
 * What this route DOES NOT answer, and must never (D7): who the guardian is, whether a human
 * vouched, anything from AgentBook, the EIN, the filing number, the tenant. The legal-body
 * question only — and in the vocabulary the chain actually carries: "a registered legal body in
 * good standing", never "verified company", "KYC'd" or "licensed".
 */

/** The lookup's own dependencies. Optional on `ApiDeps` as a whole, so a deployment that never
 *  wires a resolver simply has no such route (404) rather than a route that answers dishonestly. */
export interface LegalBodyLookupDeps {
  /** The ONE resolver (D1) — the same instance the buyer dial and the seller policy hold, so a
   *  suspension cannot mean one thing here and another there. It caches nothing. */
  resolver: LegalBodyResolver;
  /** The route's own read allowance, spent only on a MEMO MISS: two Arc reads per miss, and this
   *  is an unauthenticated surface where nothing else bounds the volume (§4, RPC drain). */
  readBudget: TokenBucket;
  links: {
    /** Absolute url of the human-readable transparency page. */
    transparency: string;
    /** Base the per-entity metadata url is composed from — `<base>/metadata/<publicId>`, exactly
     *  the shape `workflow/onboarding.ts` bakes on chain as the entity's `metadataURI`. */
    metadataBase: string;
  };
  /** The SHARED formation projection (`formation/status.ts`), keyed by company. Optional: absent,
   *  every answer's `formation` is null — the honest shape for a box that cannot read filings,
   *  and the same rule `/transparency` and `/metadata` apply. */
  formationSummary?: (companyId: string) => FormationSummary | null;
  /** Which Arc the entities in this deployment live on. Derived exactly as the AgentBook status
   *  route derives it, so the two public surfaces cannot name different chains. */
  network: "testnet" | "mainnet";
}

/**
 * The memo (D3): the LAST DEFINITIVE answer per address, for 15 seconds.
 *
 * A judge refreshing a page, or a seller's dashboard polling, must not be able to drain the RPC —
 * but a guardian suspension has to become visible fast, so the window is seconds and not minutes.
 * `unknown` is NEVER stored (D8): a read that failed is not an answer, and remembering it would
 * turn one RPC blip into fifteen seconds of "we cannot tell" for an address that is fine.
 */
const MEMO_TTL_MS = 15_000;
/**
 * …and the SAME window stated on the wire (R1).
 *
 * Every other public read route sets `Cache-Control` explicitly (`/transparency` and `/metadata`
 * 300 s, `/ensgateway` 30 s), and this one has to: the CORS `*` exists so a seller's browser page
 * can ask, and a shared cache left to its own heuristics would serve `standing: "active"` for a
 * body the guardian has since suspended. 15 seconds matches the memo, so the worst case is a
 * downstream cache holding an answer this process had already memoised — 30 s of staleness, the
 * cost D3's window was chosen against. Everything that is NOT a definitive answer — `unknown`, a
 * 400, a 429, a 503 — is `no-store`: none of them may be reused for anything.
 */
const FRESH_CACHE_CONTROL = "public, max-age=15";
const NO_STORE = "no-store";
/**
 * The PER-CLIENT budget, in front of the shared one (R2).
 *
 * The shared bucket protects the RPC; on an unauthenticated route it protects it from everyone at
 * once, so one scanner walking random addresses at a couple of requests a second could hold it
 * empty and every honest seller's lookup would 429 — which the copy-ready checker (D6) reads as
 * `null`, i.e. our own agents refused by every seller using it. A small budget per caller means a
 * scanner exhausts ITS OWN allowance first.
 *
 * Keyed by the first `X-Forwarded-For` entry because that is what the reverse proxy in front of
 * this API sets. It is spoofable and this is best-effort by construction: the shared bucket below
 * is the backstop that holds whatever the key does not.
 */
const CLIENT_BURST = 10;
const CLIENT_REFILL_PER_SECOND = 0.5;
/** Bounded like the memo, and for the same reason: the key is caller-supplied. */
const CLIENT_MAX_KEYS = 2000;
/** A throttle is an ops signal, not a per-request log line: one line per window, whatever the
 *  volume, so a scanner cannot turn journald into its second victim. */
const THROTTLE_LOG_WINDOW_MS = 60_000;
/** Bounded so a walk over random addresses cannot grow this map without limit. Oldest first —
 *  insertion order, re-inserted on every refresh, so the entry evicted is the coldest one. */
const MEMO_MAX_ENTRIES = 1000;

/** The filing facts this surface reports (D1: reported, never gating). */
interface FormationFacts {
  /** The STATE has filed the company: it legally exists. */
  filed: boolean;
  /** The IRS has issued the EIN. The EIN ITSELF is never on a public surface. */
  einIssued: boolean;
  status: FormationSummary["status"];
  environment: FormationSummary["environment"];
}

type LookupAnswer =
  | { address: string; legalBody: false; standing: null; checkedAt: string }
  | {
      address: string;
      legalBody: true;
      standing: "active" | "inactive" | "unknown";
      agentId: string | null;
      publicId: string | null;
      name: string;
      network: "testnet" | "mainnet";
      links: { transparency: string; metadata: string | null };
      formation: FormationFacts | null;
      checkedAt: string;
    };

export function mountLegalBodyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const lb = deps.legalBody;
  if (!lb) return;
  const now = () => (deps.now ?? Date.now)();
  const memo = new Map<string, { at: number; answer: LookupAnswer }>();
  /** One bucket per caller (R2), bounded and least-recently-used-first. */
  const clients = new Map<string, TokenBucket>();
  /** When the last throttle line was written, so a sustained drain costs one line per minute. */
  let throttleLoggedAt: number | undefined;

  /** Who is asking, as well as this route can know: the first `X-Forwarded-For` entry the proxy
   *  put there, or `"direct"` for a request that reached the process without one (localhost, a
   *  health check, a misconfigured proxy) — one shared bucket for all of those, deliberately. */
  const clientKey = (c: { req: { header(name: string): string | undefined } }): string => {
    const first = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    return first ? first : "direct";
  };

  const clientBucket = (key: string): TokenBucket => {
    const existing = clients.get(key);
    // Re-inserted on every use, so insertion order IS least-recently-used order and the entry
    // evicted below is the coldest one — never the scanner's own exhausted bucket.
    if (existing) {
      clients.delete(key);
      clients.set(key, existing);
      return existing;
    }
    const fresh = new TokenBucket(CLIENT_BURST, CLIENT_REFILL_PER_SECOND);
    clients.set(key, fresh);
    while (clients.size > CLIENT_MAX_KEYS) {
      const oldest = clients.keys().next().value;
      if (oldest === undefined) break;
      clients.delete(oldest);
    }
    return fresh;
  };

  /** The same refusal whichever budget ran out — a caller learns that it should slow down, never
   *  which of our limits it is standing in front of — plus at most one ops line per window. */
  const throttled = (c: Context, bucket: "client" | "shared") => {
    const at = now();
    if (throttleLoggedAt === undefined || at - throttleLoggedAt >= THROTTLE_LOG_WINDOW_MS) {
      throttleLoggedAt = at;
      // WHICH budget, never who: the address is the caller's, and the key is an IP.
      opsLog("legal_body_lookup_throttled", { bucket });
    }
    c.header("Cache-Control", NO_STORE);
    return c.json({ error: "rate_limited", message: "try again in a few seconds" }, 429);
  };

  /**
   * The filing, as much of it as is safe anywhere (D1: reported, never gating).
   *
   * Two booleans and the two fields `/transparency` publishes. Deliberately NOT here: the filing
   * number and doola's company id (the filing's own identifiers), the EIN (a tax identifier,
   * authenticated views only), and the open required-action codes (an operational detail of our
   * relationship with the provider, not a fact about the legal body).
   */
  const formationOf = (e: EntityRecord): FormationFacts | null => {
    if (!e.companyId || !lb.formationSummary) return null;
    const s = lb.formationSummary(e.companyId);
    if (!s) return null;
    return {
      filed: s.status === "filed" || s.status === "complete",
      einIssued: s.status === "complete",
      status: s.status,
      // Inseparable from the rest (the honesty invariant): a sandbox filing must never be
      // readable as a Wyoming company by omission.
      environment: s.environment,
    };
  };

  app.get("/legal-bodies/:address", async (c) => {
    const supplied = c.req.param("address");
    // EIP-55 or lowercase, and nothing else (D3). `getAddress` alone would NOT do it: viem
    // checksums without validating, so a caller's single mistyped case would silently become a
    // different address and come back as "not a legal body" — an answer they would act on.
    if (!isAddress(supplied, { strict: true })) {
      c.header("Cache-Control", NO_STORE);
      return c.json(
        {
          error: "validation_error",
          message:
            "address must be a 20-byte hex address, either all-lowercase or EIP-55 checksummed",
        },
        400,
      );
    }
    const address = getAddress(supplied);
    const key = address.toLowerCase();

    const hit = memo.get(key);
    if (hit) {
      if (now() - hit.at < MEMO_TTL_MS) {
        // A memo hit is a definitive answer by construction (`unknown` is never stored), so it
        // carries the same freshness as the read that produced it — and it costs a token from
        // NEITHER bucket, which is what lets a refreshing page ride the memo instead of a 429.
        c.header("Cache-Control", FRESH_CACHE_CONTROL);
        return c.json(hit.answer);
      }
      memo.delete(key);
    }
    // Both budgets are spent on a MISS ONLY, like the AgentBook status route's read budget: they
    // exist to bound the CHAIN READS, and a memo hit makes none. The caller's own allowance is
    // asked first, so a scanner runs itself out before it can touch the shared one.
    if (!clientBucket(clientKey(c)).take()) return throttled(c, "client");
    if (!lb.readBudget.take()) return throttled(c, "shared");

    let resolved: LegalBodyResolution;
    try {
      resolved = await lb.resolver.resolve(address);
    } catch {
      // Only the LOCAL read can throw: `readStanding` catches every chain failure and returns
      // `unknown` (payments/legalBody.ts). So this is the database being unavailable, and with it
      // we cannot tell whether the address is one of ours at all — which `standing` has no value
      // for, and `legalBody: false` would be a lie. 503, in this route's flat error shape rather
      // than the house envelope a thrown error would have produced.
      c.header("Cache-Control", NO_STORE);
      return c.json(
        { error: "unavailable", message: "could not check right now; try again shortly" },
        503,
      );
    }
    const checkedAt = new Date(now()).toISOString();
    const answer: LookupAnswer =
      resolved.kind === "none"
        ? { address, legalBody: false, standing: null, checkedAt }
        : {
            address,
            legalBody: true,
            standing: resolved.standing,
            // A DECIMAL STRING, as every other public surface serves it (`/transparency`,
            // `/metadata`): an agent id is a uint256 token id, and a JSON number silently loses
            // precision above 2^53. The design sketch's unquoted `843704` would have been a lie
            // for any id big enough to matter.
            agentId: resolved.entity.agentId ?? null,
            publicId: resolved.entity.publicId ?? null,
            name: resolved.entity.name,
            network: lb.network,
            links: {
              transparency: lb.links.transparency,
              metadata: resolved.entity.publicId
                ? `${lb.links.metadataBase.replace(/\/+$/, "")}/metadata/${resolved.entity.publicId}`
                : null,
            },
            formation: formationOf(resolved.entity),
            checkedAt,
          };

    // DEFINITIVE answers only (D8). "Not one of ours" is definitive too — it is a local read that
    // asked the chain nothing — so it is memoised like the rest; `unknown` never is.
    const definitive = !(resolved.kind === "body" && resolved.standing === "unknown");
    if (definitive) {
      memo.set(key, { at: now(), answer });
      while (memo.size > MEMO_MAX_ENTRIES) {
        const oldest = memo.keys().next().value;
        if (oldest === undefined) break;
        memo.delete(oldest);
      }
    }

    // One line per MISS (a hit costs nothing and says nothing new). No address: this is a
    // high-volume public route and the two fields that matter for ops — which index matched and
    // what the chain said — keep the line short and greppable.
    opsLog("legal_body_lookup", {
      matchedBy: resolved.kind === "body" ? resolved.matchedBy : "none",
      standing: resolved.kind === "body" ? resolved.standing : null,
    });
    // `unknown` is not an answer anything may reuse — it is the absence of one (D8).
    c.header("Cache-Control", definitive ? FRESH_CACHE_CONTROL : NO_STORE);
    return c.json(answer);
  });
}
