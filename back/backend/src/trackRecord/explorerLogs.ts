import { type Address, type Hex, keccak256, pad, toHex } from "viem";
import { safeFetch } from "../payments/ssrfGuard";
import { readCappedText } from "../util/readStreamCapped";
import { NEW_FEEDBACK_TOPIC0 } from "./reputationRead";

/** What one explorer query asks for, and what every log it returns must match. */
export interface ExplorerLogsQuery {
  /** The explorer's etherscan-style API, e.g. `https://explorer.testnet.arc.io/api`. */
  explorerApi: string;
  registry: Address;
  agentId: bigint;
  poster: Address;
  tag1: string;
  fromBlock: bigint;
}

/** The answer could not be read as a list of logs: the explorer did not answer, for this code. */
export class ExplorerAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplorerAnswerError";
  }
}

/** A topic as the explorer spells it: 32 bytes, lowercase hex. */
function topicOf(value: Hex): string {
  return pad(value, { size: 32 }).toLowerCase();
}

/**
 * The one explorer request for the poster's `NewFeedback` logs on this agent (design 4.1.3).
 *
 * The RPC's `eth_getLogs` ceiling (5,000 blocks) at about 170,000 blocks a day rules out a walk
 * from a start block per request; the explorer filters on three topics in one call. Every part of
 * the URL is config or hex built here: nothing read from the chain or from another service.
 */
export function explorerLogsUrl(q: ExplorerLogsQuery): string {
  const u = new URL(q.explorerApi);
  const params: Record<string, string> = {
    module: "logs",
    action: "getLogs",
    fromBlock: q.fromBlock.toString(),
    toBlock: "latest",
    address: q.registry,
    topic0: NEW_FEEDBACK_TOPIC0,
    topic1: topicOf(toHex(q.agentId)),
    topic2: topicOf(q.poster),
    topic0_1_opr: "and",
    topic0_2_opr: "and",
    topic1_2_opr: "and",
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,16}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The date of the latest post, from an explorer answer: ISO 8601 UTC, or null when no log
 * qualifies.
 *
 * The backend trusts nothing it did not ask for: a log counts only when its address and its four
 * topics are exactly the ones queried (the fourth is `keccak256(tag1)`, checked here because the
 * query does not filter on it), and its block, timestamp and hash parse. Anything else is
 * dropped. The explorer's count of logs is never a count of calls: a revoked post keeps its log,
 * and the chain view is the count.
 *
 * Throws `ExplorerAnswerError` when the answer is not a list of logs at all, which the caller
 * reads as "the explorer did not answer". "No logs found" is an empty list, not a failure.
 */
export function lastGradedAtFromLogs(answer: unknown, q: ExplorerLogsQuery): string | null {
  if (typeof answer !== "object" || answer === null)
    throw new ExplorerAnswerError("explorer answer is not an object");
  const result = (answer as { result?: unknown }).result;
  if (!Array.isArray(result)) throw new ExplorerAnswerError("explorer answer has no log list");

  const expected = [
    NEW_FEEDBACK_TOPIC0.toLowerCase(),
    topicOf(toHex(q.agentId)),
    topicOf(q.poster),
    keccak256(toHex(q.tag1)).toLowerCase(),
  ];
  const registry = q.registry.toLowerCase();

  let latest: number | null = null;
  for (const log of result) {
    if (typeof log !== "object" || log === null) continue;
    const l = log as Record<string, unknown>;
    if (typeof l.address !== "string" || l.address.toLowerCase() !== registry) continue;
    const topics = l.topics;
    if (!Array.isArray(topics) || topics.length !== expected.length) continue;
    if (!topics.every((t, i) => typeof t === "string" && t.toLowerCase() === expected[i])) continue;
    if (typeof l.blockNumber !== "string" || !HEX_QUANTITY.test(l.blockNumber)) continue;
    if (typeof l.timeStamp !== "string" || !HEX_QUANTITY.test(l.timeStamp)) continue;
    if (typeof l.transactionHash !== "string" || !TX_HASH.test(l.transactionHash)) continue;
    const seconds = Number.parseInt(l.timeStamp, 16);
    if (!Number.isSafeInteger(seconds)) continue;
    if (latest === null || seconds > latest) latest = seconds;
  }
  return latest === null ? null : new Date(latest * 1000).toISOString();
}

/** An explorer answer for a handful of logs is a few kilobytes. */
export const EXPLORER_BODY_CAP_BYTES = 1024 * 1024;
/** The explorer's share of the route's 8 s bound (design 4.2.9). */
export const EXPLORER_TIMEOUT_MS = 4_000;

/**
 * Fetch and parse one explorer answer. Any failure (refused URL, timeout, non-2xx, oversized or
 * non-JSON body) is an `ExplorerAnswerError`: for the card it only means "date unavailable".
 */
export async function fetchExplorerJson(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await safeFetch(
      fetchImpl,
      url,
      { headers: { accept: "application/json" } },
      { timeoutMs: EXPLORER_TIMEOUT_MS },
    );
  } catch {
    throw new ExplorerAnswerError("explorer request failed");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ExplorerAnswerError(`explorer answered ${res.status}`);
  }
  const onAbort = () => {
    res.body?.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const text = await readCappedText(
      {
        body: res.body,
        contentLength: res.headers.get("content-length"),
        readAll: async () => Buffer.from(await res.arrayBuffer()),
      },
      EXPLORER_BODY_CAP_BYTES,
      {
        declared: () => new ExplorerAnswerError("explorer answer declared too large"),
        streamed: () => new ExplorerAnswerError("explorer answer too large"),
      },
    );
    return JSON.parse(text) as unknown;
  } catch (e) {
    if (e instanceof ExplorerAnswerError) throw e;
    throw new ExplorerAnswerError("explorer answer could not be read");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
