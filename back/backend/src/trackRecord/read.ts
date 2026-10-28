import type { Address, Hex } from "viem";
import type { ExternalRecordConfig } from "../config/env";
import { DeadlineExceededError, withDeadline } from "../util/deadline";
import { parseLockingWallet } from "./caip10";
import { type FeedbackCounts, type FeedbackFilter, classifyFeedback } from "./classify";
import { EXPLORER_TIMEOUT_MS, explorerLogsUrl, lastGradedAtFromLogs } from "./explorerLogs";
import { RECORD_TIMEOUT_MS, RecordSourceError, parseRecordAnswer } from "./recordApi";
import { type ReadAllFeedbackResult, feedbackEntries } from "./reputationRead";
import type { ExternalRecordView } from "./types";

/** The four reads, injected so the composition stays testable without a network. */
export interface ExternalRecordSources {
  readFeedback(agentId: bigint, filter: FeedbackFilter): Promise<ReadAllFeedbackResult>;
  readMetadata(agentId: bigint, key: string): Promise<Hex>;
  readExplorerLogs(url: string, signal: AbortSignal): Promise<unknown>;
  readRecord(address: Address, signal: AbortSignal): Promise<string>;
}

export interface ExternalRecordReadDeps {
  config: ExternalRecordConfig;
  /** The ERC-8004 Reputation registry (proxy). */
  registry: Address;
  sources: ExternalRecordSources;
  now?: () => number;
}

/** The chain reads' share of the route's bound: the whole of it (design 4.2.9). */
export const CHAIN_TIMEOUT_MS = 8_000;
/** The metadata read runs before the record fetch, so the two share the 8 s. */
export const METADATA_TIMEOUT_MS = 4_000;

export interface ExternalRecordAnswer {
  view: ExternalRecordView;
  /**
   * Whether every source answered, so the answer may be memoised. Never true when any half is
   * unavailable or the explorer did not answer: a retry has to reach the sources again.
   */
  definitive: boolean;
}

type ChainHalf = ExternalRecordView["chain"];
type RecordHalf = ExternalRecordView["record"];

async function readChainCounts(
  deps: ExternalRecordReadDeps,
  agentId: bigint,
  filter: FeedbackFilter,
): Promise<{ ok: true; counts: FeedbackCounts } | { ok: false; reason: "rpc" | "decode" }> {
  let result: ReadAllFeedbackResult;
  try {
    result = await withDeadline(CHAIN_TIMEOUT_MS, () => deps.sources.readFeedback(agentId, filter));
  } catch {
    return { ok: false, reason: "rpc" };
  }
  try {
    return { ok: true, counts: classifyFeedback(feedbackEntries(result), filter) };
  } catch {
    // `FeedbackDecodeError`, or a column holding something other than what viem promised.
    return { ok: false, reason: "decode" };
  }
}

async function readLastGradedAt(
  deps: ExternalRecordReadDeps,
  agentId: bigint,
): Promise<{ answered: boolean; at: string | null }> {
  const query = {
    explorerApi: deps.config.explorerApi,
    registry: deps.registry,
    agentId,
    poster: deps.config.poster,
    tag1: deps.config.tag1,
    fromBlock: BigInt(deps.config.fromBlock),
  };
  try {
    const answer = await withDeadline(EXPLORER_TIMEOUT_MS, (signal) =>
      deps.sources.readExplorerLogs(explorerLogsUrl(query), signal),
    );
    return { answered: true, at: lastGradedAtFromLogs(answer, query) };
  } catch {
    return { answered: false, at: null };
  }
}

/** The record half, and the link the provider's answer carried (served on `provider`). */
interface RecordRead {
  half: RecordHalf;
  recordUrl: string | null;
}

async function readRecordHalf(deps: ExternalRecordReadDeps, agentId: bigint): Promise<RecordRead> {
  let bytes: Hex;
  try {
    bytes = await withDeadline(METADATA_TIMEOUT_MS, () =>
      deps.sources.readMetadata(agentId, deps.config.metadataKey),
    );
  } catch {
    return { half: { status: "unavailable", reason: "rpc", lockingWallet: null }, recordUrl: null };
  }
  const lockingWallet = parseLockingWallet(bytes);
  if (!lockingWallet) return { half: { status: "not_linked" }, recordUrl: null };

  let text: string;
  try {
    text = await withDeadline(RECORD_TIMEOUT_MS, (signal) =>
      deps.sources.readRecord(lockingWallet, signal),
    );
  } catch (e) {
    const reason =
      e instanceof RecordSourceError
        ? e.reason
        : e instanceof DeadlineExceededError
          ? "timeout"
          : "http";
    return { half: { status: "unavailable", reason, lockingWallet }, recordUrl: null };
  }
  try {
    const parsed = parseRecordAnswer(text, new URL(deps.config.apiBase).host);
    return {
      half: {
        status: "ok",
        lockingWallet,
        graded: parsed.graded,
        correct: parsed.correct,
        wrong: parsed.wrong,
        worstMoveBps: parsed.worstMoveBps,
      },
      recordUrl: parsed.recordUrl,
    };
  } catch (e) {
    const reason = e instanceof RecordSourceError ? e.reason : "malformed";
    return { half: { status: "unavailable", reason, lockingWallet }, recordUrl: null };
  }
}

/**
 * Read one agent's external record (design 4.1 and 4.2.9).
 *
 * The three branches run in parallel and degrade on their own: the counts from the registry, the
 * date from the explorer, the record from the provider through the wallet the identity names.
 * Nothing here throws on a source failure; a failed half is served as `unavailable` with its
 * reason, and never as a zero.
 */
export async function readExternalRecord(
  deps: ExternalRecordReadDeps,
  agentId: bigint,
): Promise<ExternalRecordAnswer> {
  const filter: FeedbackFilter = {
    poster: deps.config.poster,
    tag1: deps.config.tag1,
    tag2: deps.config.tag2,
  };
  const [counts, date, { half: record, recordUrl }] = await Promise.all([
    readChainCounts(deps, agentId, filter),
    readLastGradedAt(deps, agentId),
    readRecordHalf(deps, agentId),
  ]);

  const chain: ChainHalf = counts.ok
    ? { status: "ok", ...counts.counts, lastGradedAt: date.at }
    : { status: "unavailable", reason: counts.reason };

  const agreement: ExternalRecordView["agreement"] =
    chain.status === "ok" && record.status === "ok"
      ? chain.graded === record.graded
        ? "match"
        : "differ"
      : "unknown";

  const now = deps.now ?? Date.now;
  return {
    view: {
      provider: { name: deps.config.providerName, recordUrl },
      agentId: agentId.toString(),
      chain,
      record,
      agreement,
      network: "testnet",
      checkedAt: new Date(now()).toISOString(),
    },
    definitive:
      chain.status === "ok" &&
      date.answered &&
      (record.status === "ok" || record.status === "not_linked"),
  };
}
