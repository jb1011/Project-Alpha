import type { Address, Hex } from "viem";
import { ScanError } from "./errors";
import { AGENT_WALLET_KEY, registryMetadataSetEvent, registryTransferEvent } from "./events";
import type { MonitorRpc, RawLog } from "./rpc";

/**
 * Chunked log scanning.
 *
 * HARD RPC CONSTRAINT (learned live, testnet rehearsal): Arc RPCs reject an `eth_getLogs` whose
 * block range is too wide, with `-32012 requested range too large`. Arc has sub-second blocks, so a
 * monitor that was down for two hours already needs several chunks — this is the normal path, not
 * an edge case.
 *
 * The ceiling is NOT the same on every endpoint. The box's token'd RPC accepts 100,000; the public
 * `rpc.testnet.arc.network` rejected 90,000 and 50,000 but served 5,000 (measured 2026-08-18). A
 * hardcoded chunk size therefore produces the worst possible failure on the wrong endpoint: a
 * process that is up, logging, and permanently unable to advance its cursor.
 *
 * So we start at 90,000 and HALVE on a range rejection down to MIN_LOG_RANGE (see
 * `isRangeTooLargeError` and Monitor's `currentRange`). Self-tuning beats a config var nobody
 * knows to set.
 */
export const MAX_LOG_RANGE = 90_000n;

/** Floor for the adaptive shrink. Below this, the problem is not the window size. */
export const MIN_LOG_RANGE = 1_000n;

/**
 * Is this failure "your window is too wide" rather than "the chain/RPC is unwell"? Matched on the
 * message because the error travels through viem as an RpcRequestError, and the JSON-RPC code for
 * this condition is not standardised (Arc uses -32012, others -32005/-32602/-32600).
 */
export function isRangeTooLargeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /range too large|block range|too many blocks|exceed(s|ed)? .*(range|blocks)|query returned more than/i.test(
    message,
  );
}

/** Next window size to try after a range rejection; undefined once the floor is reached. */
export function shrinkRange(current: bigint): bigint | undefined {
  if (current <= MIN_LOG_RANGE) return undefined;
  const next = current / 2n;
  return next < MIN_LOG_RANGE ? MIN_LOG_RANGE : next;
}

export interface BlockRange {
  from: bigint;
  to: bigint;
}

/** Split [from,to] (inclusive) into consecutive ranges of at most `max` blocks each. */
export function chunkRange(from: bigint, to: bigint, max: bigint = MAX_LOG_RANGE): BlockRange[] {
  if (max <= 0n) throw new ScanError(`chunkRange: max must be positive (got ${max})`);
  if (to < from) return [];
  const out: BlockRange[] = [];
  let cursor = from;
  while (cursor <= to) {
    // -1n because both ends are inclusive: [0, 89_999] is 90_000 blocks.
    const end = cursor + max - 1n;
    out.push({ from: cursor, to: end > to ? to : end });
    cursor = end + 1n;
  }
  return out;
}

/**
 * The first block of a cold start. Never genesis: the monitor is a live watcher, not an indexer,
 * and replaying 57M blocks would page the operator with every historical event at once.
 */
export function coldStartFrom(latest: bigint, lookbackBlocks: number): bigint {
  const back = BigInt(lookbackBlocks);
  return latest > back ? latest - back : 0n;
}

export interface WatchTargets {
  /** Our own contracts: controller, factories, beacons, treasuries. Low log volume — read whole. */
  own: Address[];
  /** The SHARED ERC-8004 registry. Never read unfiltered: it serves the entire chain. */
  registry: Address;
  /** agentIds (decimal strings) of our entities, for the ERC-721 Transfer topic filter. */
  agentIds: string[];
}

/**
 * One window's logs, from three queries.
 *
 * The split exists because the identity registry is not ours: it is a public, chain-wide contract,
 * and pulling every log it emits in a 90,000-block window would be both enormous and mostly other
 * people's agents. Both registry queries are therefore filtered SERVER-SIDE — by the indexed
 * metadata key for wallet binds, and by our own token ids for transfers.
 */
export async function fetchWindow(
  rpc: MonitorRpc,
  targets: WatchTargets,
  range: BlockRange,
): Promise<RawLog[]> {
  const queries: Promise<RawLog[]>[] = [];

  if (targets.own.length > 0)
    queries.push(rpc.getLogs({ address: targets.own, fromBlock: range.from, toBlock: range.to }));

  queries.push(
    rpc.getLogs({
      address: targets.registry,
      event: registryMetadataSetEvent,
      // Indexed string => topic1 is its keccak256; viem hashes this for us.
      args: { indexedMetadataKey: AGENT_WALLET_KEY },
      fromBlock: range.from,
      toBlock: range.to,
    }),
  );

  // No agents yet => no token ids to filter on. An UNFILTERED Transfer query here would return
  // every ERC-8004 mint on the chain, so we skip the query entirely instead.
  if (targets.agentIds.length > 0)
    queries.push(
      rpc.getLogs({
        address: targets.registry,
        event: registryTransferEvent,
        args: { tokenId: targets.agentIds.map((id) => BigInt(id)) },
        fromBlock: range.from,
        toBlock: range.to,
      }),
    );

  const results = await Promise.all(queries);
  const logs = results.flat();
  // Deterministic replay order: a Transfer and the MetadataSet that clears the binding land in the
  // same tx, and the operator reading the alert log should see them in on-chain order.
  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
  return logs;
}

/** Stable per-log dedup key: a chain log is uniquely identified by its tx hash + log index. */
export function logKey(rule: string, log: { transactionHash: Hex; logIndex: number }): string {
  return `${rule}:${log.transactionHash}:${log.logIndex}`;
}
