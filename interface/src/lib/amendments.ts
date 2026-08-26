import { getAbiItem, type Address, type Hex } from "viem";
import { legalManagerAbi } from "@/lib/legalManagerAbi";

/** `0n` literals need an ES2020 target; this package compiles to ES2017, like the rest of it. */
const ZERO = BigInt(0);

/** Hashes come off logs, off the API and out of the contract; only their VALUE is comparable. */
export function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Which amendment hashes the guardian's card must ask the CONTRACT about.
 *
 * Two sources, and they answer different questions. The `AmendmentScheduled` log scan DISCOVERS
 * hashes — including the ones the platform is not talking about, which is the whole reason the
 * card reads the chain instead of the backend. The API's `pendingHash` is a hash we already know
 * the identity of; what we do not know is whether it is actually scheduled.
 *
 * So the API's hash is ALWAYS in the list, whether or not a log turned it up. Deriving the reads
 * from the logs alone made the card's most consequential sentence — "the schedule transaction has
 * not confirmed yet, nothing to veto" — conditional on the log query having succeeded over the
 * full history. On an RPC that caps log ranges (the case the card already handles by falling back
 * to a bounded window), a genuinely live amendment older than that window produced exactly that
 * reassurance. `scheduledAt(hash)` is a point read against a mapping: it costs one call, needs no
 * range at all, and is the authority the contract itself checks.
 */
export function collectAmendmentHashes(
  fromLogs: readonly Hex[],
  apiPendingHash: string | null,
): Hex[] {
  const out: Hex[] = [];
  const seen = new Set<string>();
  const push = (hash: Hex) => {
    const key = hash.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(hash);
  };
  for (const hash of fromLogs) push(hash);
  if (apiPendingHash) push(apiPendingHash as Hex);
  return out;
}

/* ------------------------------------------------------------------ */
/* Chain reads                                                         */
/* ------------------------------------------------------------------ */

/** One amendment hash, joined with what the chain says about it NOW. */
export type Amendment = {
  hash: Hex;
  /** From `scheduledAt(hash)` — unix seconds, 0 when nothing is live for this hash. This is the
   *  authority, not the log's `executableAt`: a reschedule resets the clock and the mapping is
   *  what the contract will actually check. */
  scheduledAt: bigint;
  /** Sticky. Set by `cancelOperatingAgreementUpdate`, cleared only by `liftVeto`. */
  vetoed: boolean;
};

/**
 * How much of the `AmendmentScheduled` history the RPC actually let us read.
 *
 * Three outcomes, and the card says which one it got rather than presenting all three as a clean
 * bill of health. `unavailable` is not an error state: point reads are unaffected by it, so the
 * hash the platform reports is still checked against the contract.
 */
export type LogDiscovery =
  | { status: "full" }
  | { status: "partial"; window: bigint }
  | { status: "unavailable"; reason: string | null };

export type ChainState = {
  amendments: Amendment[];
  /** The hash the contract currently carries — read here, not taken from the API. */
  anchored: Hex;
  discovery: LogDiscovery;
};

export const SCHEDULED_EVENT = getAbiItem({ abi: legalManagerAbi, name: "AmendmentScheduled" });

/**
 * Descending block windows to try after a full-history scan is refused.
 *
 * Public Arc RPC (`rpc.testnet.arc.network`) measured: `fromBlock: 0` answers
 * `pruned history unavailable`, 100k and 200k answer `requested range too large`, 1M answers
 * `rate limit exceeded`, and 10k answers with the logs. A SINGLE 200k fallback — which is what
 * this used to be — therefore failed on the exact RPC the app ships pointed at, and because that
 * one retry was unguarded its failure took the whole card down with it.
 *
 * Descending rather than ascending: the widest window an RPC will accept is the most history, and
 * the first one that answers wins. These are NOT safe windows — an amendment timelock can be set
 * to 365 days and no fixed block count covers that on a sub-second chain — which is why a window
 * that answers is reported as `partial` and named in the UI copy rather than passed off as
 * complete history.
 */
export const LOG_WINDOW_LADDER: readonly bigint[] = [
  BigInt(50_000),
  BigInt(10_000),
  BigInt(2_000),
];

/**
 * The subset of a viem `PublicClient` these reads use.
 *
 * Named as a port so the orchestration below can be exercised against a fake in the test suite —
 * the bug this file exists to prevent (an unguarded second `getLogs` taking down reads that would
 * have succeeded) is a control-flow bug, and control flow is only testable if the client is an
 * argument rather than a closed-over browser object.
 */
export type AmendmentChainClient = {
  chain?: { contracts?: { multicall3?: unknown } | undefined } | undefined;
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address;
    event: typeof SCHEDULED_EVENT;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly unknown[]>;
  readContract(args: {
    address: Address;
    abi: typeof legalManagerAbi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  multicall(args: { contracts: readonly unknown[]; allowFailure: false }): Promise<readonly unknown[]>;
};

/**
 * Everything the card needs from the chain, arranged so a limited RPC degrades instead of failing.
 *
 * The ordering is the whole point. Log discovery is best-effort and CANNOT throw — every attempt is
 * guarded and the worst case is an `unavailable` verdict — so the point reads under it always run.
 * That inverts the old behaviour: `scheduledAt`/`vetoed` are mapping reads that need no block range
 * and work fine on a pruned or range-capped node, yet a failed history scan used to abort them and
 * the guardian was told "Could not read the amendment state from the chain" about an amendment that
 * was sitting right there, readable, one `eth_call` away.
 *
 * `meta()` is in the same class as those point reads — one `eth_call`, no range — so it shares
 * their fate: if it throws, the card has no anchored hash to compare and the error is real.
 */
export async function readAmendments(
  client: AmendmentChainClient,
  proxy: Address,
  apiPendingHash: string | null,
): Promise<ChainState> {
  // Safe to race: `discoverAmendmentHashes` resolves on every path, so this cannot reject before
  // the point reads below get their turn.
  const [discovered, anchored] = await Promise.all([
    discoverAmendmentHashes(client, proxy),
    readAnchoredHash(client, proxy),
  ]);

  const amendments = await readAmendmentStates(
    client,
    proxy,
    collectAmendmentHashes(discovered.hashes, apiPendingHash),
  );

  return { amendments, anchored, discovery: discovered.result };
}

/** `meta()[2]` — the operating-agreement hash the contract itself carries. */
async function readAnchoredHash(client: AmendmentChainClient, proxy: Address): Promise<Hex> {
  const meta = (await client.readContract({
    address: proxy,
    abi: legalManagerAbi,
    functionName: "meta",
  })) as readonly unknown[];
  return meta[2] as Hex;
}

/**
 * Best-effort `AmendmentScheduled` discovery. Never throws — the verdict IS the return value.
 *
 * Full history is tried first because a live amendment older than any fixed window is exactly the
 * one worth catching, and an archive node answers it in a single call. A pruned node rejects it and
 * that costs one wasted round trip, which is cheap enough to keep paying for the chance of a
 * complete answer; the ladder then walks down until something answers.
 */
export async function discoverAmendmentHashes(
  client: AmendmentChainClient,
  proxy: Address,
): Promise<{ hashes: Hex[]; result: LogDiscovery }> {
  let latest: bigint;
  try {
    latest = await client.getBlockNumber();
  } catch (e) {
    // No height means no window can even be computed. Point reads do not care.
    return { hashes: [], result: { status: "unavailable", reason: errText(e) } };
  }

  let reason: string | null = null;
  // `null` is the full-history attempt; the rest are the ladder rungs.
  for (const window of [null, ...LOG_WINDOW_LADDER]) {
    const fromBlock = window == null ? ZERO : latest > window ? latest - window : ZERO;
    try {
      const logs = await client.getLogs({
        address: proxy,
        event: SCHEDULED_EVENT,
        fromBlock,
        toBlock: latest,
      });
      return {
        hashes: hashesFromLogs(logs),
        // A rung that reached genesis covered the entire chain, so calling it `partial` and naming
        // a window would understate what was actually scanned. (`window == null` is the
        // full-history attempt itself; it also narrows `window` to `bigint` for the other branch.)
        result:
          window == null || fromBlock === ZERO
            ? { status: "full" }
            : { status: "partial", window },
      };
    } catch (e) {
      // Pruning (code 4444), range-too-large, rate limits, timeouts — all the same here: try the
      // next rung, and if none answer say so honestly instead of failing the card.
      reason = errText(e);
    }
  }

  return { hashes: [], result: { status: "unavailable", reason } };
}

function hashesFromLogs(logs: readonly unknown[]): Hex[] {
  const out: Hex[] = [];
  for (const log of logs) {
    const hash = (log as { args?: { newHash?: Hex } }).args?.newHash;
    if (hash) out.push(hash);
  }
  return out;
}

function errText(e: unknown): string | null {
  return e instanceof Error ? e.message : null;
}

/**
 * `scheduledAt` + `vetoed` for every hash — batched where the chain offers a batcher.
 *
 * Multicall3 is not deployed on every chain this UI can be pointed at, and a card that threw
 * "chain does not support contract multicall3" would be a card that tells the guardian nothing at
 * all. So the batch is an optimisation with a plain fallback under it, never a requirement.
 */
export async function readAmendmentStates(
  client: AmendmentChainClient,
  proxy: Address,
  hashes: readonly Hex[],
): Promise<Amendment[]> {
  if (hashes.length === 0) return [];

  if (client.chain?.contracts?.multicall3) {
    try {
      const contracts = hashes.flatMap((hash) => [
        { address: proxy, abi: legalManagerAbi, functionName: "scheduledAt", args: [hash] } as const,
        { address: proxy, abi: legalManagerAbi, functionName: "vetoed", args: [hash] } as const,
      ]);
      const results = (await client.multicall({
        contracts,
        allowFailure: false,
      })) as unknown as (bigint | boolean)[];
      return hashes.map((hash, i) => ({
        hash,
        scheduledAt: results[i * 2] as bigint,
        vetoed: results[i * 2 + 1] as boolean,
      }));
    } catch {
      /* fall through to individual reads */
    }
  }

  return Promise.all(
    hashes.map(async (hash): Promise<Amendment> => {
      const [scheduledAt, vetoed] = await Promise.all([
        client.readContract({
          address: proxy,
          abi: legalManagerAbi,
          functionName: "scheduledAt",
          args: [hash],
        }),
        client.readContract({
          address: proxy,
          abi: legalManagerAbi,
          functionName: "vetoed",
          args: [hash],
        }),
      ]);
      return { hash, scheduledAt: scheduledAt as bigint, vetoed: vetoed as boolean };
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

export type AmendmentClassification = {
  /** Scheduled and not yet executed — the rows that carry a veto button. */
  live: Amendment[];
  /** Vetoed and parked, waiting on a `liftVeto`. */
  parked: Amendment[];
  /** What the contract says about the hash the API calls pending, if it was asked about at all. */
  pendingRead: Amendment | undefined;
  apiClaimsPendingButChainDoesNot: boolean;
};

/**
 * Sorting what the contract said into the three things the card renders.
 *
 * The subtlety is that a veto DELETES `scheduledAt`, so a parked hash and a hash the chain has
 * never heard of both read back as `scheduledAt == 0` and the sticky `vetoed` flag is the only
 * thing that separates them. Miss that and a hash the guardian personally vetoed gets filed under
 * "the schedule transaction has not confirmed yet" — the card congratulating them on an amendment
 * that is not coming, in the words it uses for one that still might.
 */
export function classifyAmendments(
  amendments: readonly Amendment[],
  apiPendingHash: string | null,
): AmendmentClassification {
  const live = amendments.filter((a) => a.scheduledAt !== ZERO);
  const parked = amendments.filter((a) => a.scheduledAt === ZERO && a.vetoed);
  const pendingRead = apiPendingHash
    ? amendments.find((a) => sameHash(a.hash, apiPendingHash))
    : undefined;
  const apiClaimsPendingButChainDoesNot =
    pendingRead != null && pendingRead.scheduledAt === ZERO && !pendingRead.vetoed;
  return { live, parked, pendingRead, apiClaimsPendingButChainDoesNot };
}
