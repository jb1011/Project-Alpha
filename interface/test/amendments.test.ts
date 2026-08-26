/**
 * Which hashes the guardian's veto card asks the CONTRACT about (design §8, audit H4).
 *
 * The bug this encodes: the card derived its `scheduledAt`/`vetoed` reads from the
 * `AmendmentScheduled` log scan alone. That scan falls back to a bounded window whenever an RPC
 * refuses `fromBlock: 0`, and an amendment timelock can be set to a year — so a genuinely live
 * amendment older than the window simply did not appear, and the card told the guardian "nothing
 * with that hash is scheduled on this contract… nothing to veto until it does".
 *
 * A point read against a mapping needs no range at all.
 */
import { expect, test } from "vitest";
import type { Address, Hex } from "viem";
import {
  LOG_WINDOW_LADDER,
  classifyAmendments,
  collectAmendmentHashes,
  readAmendments,
  sameHash,
  type Amendment,
  type AmendmentChainClient,
} from "@/lib/amendments";

const A = "0xaaaa000000000000000000000000000000000000000000000000000000000001" as const;
const B = "0xbbbb000000000000000000000000000000000000000000000000000000000002" as const;

test("G3: the API's pending hash is read even when NO log turned it up", () => {
  // The truncated-window case, and the one that produced the false reassurance.
  expect(collectAmendmentHashes([], A)).toEqual([A]);
  expect(collectAmendmentHashes([B], A)).toEqual([B, A]);
});

test("G3: discovered hashes still come from the logs — the API does not gate them", () => {
  // The other half of the point: the log scan finds hashes the platform is not talking about,
  // which is the superseded/abandoned amendment a guardian most wants to see.
  expect(collectAmendmentHashes([A, B], null)).toEqual([A, B]);
});

test("G3: a hash reported by both sources is read once", () => {
  expect(collectAmendmentHashes([A, B], A)).toEqual([A, B]);
  // …including when the two sources disagree on casing, which they do: logs come back lowercase
  // and the API's column is whatever was written into it.
  expect(collectAmendmentHashes([A], A.toUpperCase().replace("0X", "0x"))).toEqual([A]);
});

test("G3: duplicate log entries collapse — a rescheduled hash appears once", () => {
  expect(collectAmendmentHashes([A, A, B, A], null)).toEqual([A, B]);
});

test("G3: hashes compare by value, never by identity or case", () => {
  expect(sameHash(A, A.toUpperCase().replace("0X", "0x"))).toBe(true);
  expect(sameHash(A, B)).toBe(false);
});

/* ------------------------------------------------------------------ */
/* Read orchestration against a limited RPC                            */
/* ------------------------------------------------------------------ */

/**
 * The LIVE bug, measured against `https://rpc.testnet.arc.network`: `eth_getLogs` from block 0 is
 * refused (`pruned history unavailable`), a 200k window is refused (`requested range too large`),
 * and the card's single unguarded 200k fallback therefore threw. That throw escaped the read
 * function and errored the entire card — including the `scheduledAt`/`vetoed` point reads, which
 * that same RPC answers perfectly well. A guardian looking at a genuinely live amendment saw
 * "Could not read the amendment state from the chain — RPC Request failed" and could not veto.
 *
 * So the invariant these tests hold down is a control-flow one: log discovery is best-effort and
 * can never abort the point reads. It is only testable because the client is an argument.
 */

const PROXY = "0x1111111111111111111111111111111111111111" as Address;
const ANCHORED = "0xdddd000000000000000000000000000000000000000000000000000000000009" as Hex;
const LATEST = BigInt(5_000_000);
const ZERO = BigInt(0);
const EXECUTABLE_AT = BigInt(1_787_744_919);

type HashState = { scheduledAt: bigint; vetoed: boolean };

type FakeSpec = {
  latest?: bigint;
  blockNumberError?: Error;
  /** One call per attempt. Throw to simulate an RPC refusing that range. */
  logs?: (fromBlock: bigint, toBlock: bigint) => readonly Hex[];
  states?: Record<string, HashState>;
  stateError?: Error;
  metaError?: Error;
  multicall3?: boolean;
  multicallError?: Error;
};

function makeClient(spec: FakeSpec) {
  /** `fromBlock` of every getLogs attempt, in order — the ladder's fingerprint. */
  const attempts: bigint[] = [];
  /** Every individual (non-batched) point read, as `functionName:hash`. */
  const pointReads: string[] = [];
  let multicallCalls = 0;

  const stateOf = (hash: unknown): HashState =>
    spec.states?.[String(hash).toLowerCase()] ?? { scheduledAt: ZERO, vetoed: false };

  const client: AmendmentChainClient = {
    chain: spec.multicall3
      ? { contracts: { multicall3: { address: PROXY } } }
      : undefined,

    async getBlockNumber() {
      if (spec.blockNumberError) throw spec.blockNumberError;
      return spec.latest ?? LATEST;
    },

    async getLogs({ fromBlock, toBlock }) {
      attempts.push(fromBlock);
      const hashes = spec.logs?.(fromBlock, toBlock) ?? [];
      return hashes.map((newHash) => ({ args: { newHash } }));
    },

    async readContract({ functionName, args }) {
      if (functionName === "meta") {
        if (spec.metaError) throw spec.metaError;
        return ["12-3456789", BigInt(0), ANCHORED, BigInt(1)];
      }
      if (spec.stateError) throw spec.stateError;
      pointReads.push(`${functionName}:${String(args?.[0]).toLowerCase()}`);
      const state = stateOf(args?.[0]);
      return functionName === "scheduledAt" ? state.scheduledAt : state.vetoed;
    },

    async multicall({ contracts }) {
      multicallCalls += 1;
      if (spec.multicallError) throw spec.multicallError;
      if (spec.stateError) throw spec.stateError;
      return (contracts as readonly { functionName: string; args: readonly unknown[] }[]).map(
        (c) => {
          const state = stateOf(c.args[0]);
          return c.functionName === "scheduledAt" ? state.scheduledAt : state.vetoed;
        },
      );
    },
  };

  return { client, attempts, pointReads, multicallCalls: () => multicallCalls };
}

const pruned = () => {
  throw new Error("pruned history unavailable");
};

test("R1/R2: no logs at ANY window — the API's hash is still read, and still vetoable", async () => {
  const { client, attempts } = makeClient({
    logs: pruned,
    states: { [A.toLowerCase()]: { scheduledAt: EXECUTABLE_AT, vetoed: false } },
  });

  const chain = await readAmendments(client, PROXY, A);

  // Degraded, NOT thrown. This is the whole fix: the old code let the second getLogs escape.
  expect(chain.discovery).toEqual({ status: "unavailable", reason: "pruned history unavailable" });
  // …and the point reads ran anyway, so the guardian sees the live amendment.
  expect(chain.amendments).toEqual([{ hash: A, scheduledAt: EXECUTABLE_AT, vetoed: false }]);
  expect(classifyAmendments(chain.amendments, A).live).toEqual([
    { hash: A, scheduledAt: EXECUTABLE_AT, vetoed: false },
  ]);
  // Emphatically not "the schedule transaction has not confirmed yet".
  expect(classifyAmendments(chain.amendments, A).apiClaimsPendingButChainDoesNot).toBe(false);
  expect(chain.anchored).toBe(ANCHORED);
  // Every rung was tried before giving up: full history + the ladder.
  expect(attempts).toHaveLength(1 + LOG_WINDOW_LADDER.length);
});

test("R2: a dead getBlockNumber degrades discovery instead of failing the card", async () => {
  // No height means no window can be computed — but a mapping read needs neither.
  const { client, attempts } = makeClient({
    blockNumberError: new Error("rate limit exceeded"),
    states: { [A.toLowerCase()]: { scheduledAt: EXECUTABLE_AT, vetoed: false } },
  });

  const chain = await readAmendments(client, PROXY, A);

  expect(chain.discovery).toEqual({ status: "unavailable", reason: "rate limit exceeded" });
  expect(attempts).toEqual([]);
  expect(chain.amendments[0]?.scheduledAt).toBe(EXECUTABLE_AT);
});

test("R3: the ladder descends and stops at the first window that answers", async () => {
  const third = LATEST - LOG_WINDOW_LADDER[2];
  const { client, attempts } = makeClient({
    // Mirrors the measured RPC: block 0 pruned, wide windows too large, a narrow one answers.
    logs: (fromBlock) => {
      if (fromBlock === ZERO) throw new Error("pruned history unavailable");
      if (fromBlock !== third) throw new Error("requested range too large");
      return [B];
    },
    states: {
      [A.toLowerCase()]: { scheduledAt: ZERO, vetoed: false },
      [B.toLowerCase()]: { scheduledAt: EXECUTABLE_AT, vetoed: false },
    },
  });

  const chain = await readAmendments(client, PROXY, A);

  // The window in the state is the one that actually worked — the UI copy prints this number, so
  // it must never be a constant the code no longer uses.
  expect(chain.discovery).toEqual({ status: "partial", window: LOG_WINDOW_LADDER[2] });
  expect(attempts).toEqual([
    ZERO,
    LATEST - LOG_WINDOW_LADDER[0],
    LATEST - LOG_WINDOW_LADDER[1],
    third,
  ]);
  // Stopped there: no rung after the one that answered.
  expect(attempts).toHaveLength(4);
  // Discovery found B; the API's A is in the batch regardless.
  expect(chain.amendments.map((a) => a.hash)).toEqual([B, A]);
});

test("R3/R4: a full-history scan reports `full`, and so does a window that reaches genesis", async () => {
  const full = makeClient({ logs: () => [B], states: {} });
  expect((await readAmendments(full.client, PROXY, null)).discovery).toEqual({ status: "full" });

  // A chain younger than the rung: every window clamps to genesis, so the scan covered everything
  // and calling it "partial" while naming a block count would understate what was actually read.
  let firstAttempt = true;
  const young = makeClient({
    latest: BigInt(500),
    logs: () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("transient");
      }
      return [B];
    },
    states: {},
  });
  const chain = await readAmendments(young.client, PROXY, null);
  expect(chain.discovery).toEqual({ status: "full" });
  expect(young.attempts).toEqual([ZERO, ZERO]);
});

test("R4: a failed point read is the ONLY thing that errors the card", async () => {
  const states = makeClient({ logs: () => [], stateError: new Error("RPC Request failed") });
  await expect(readAmendments(states.client, PROXY, A)).rejects.toThrow("RPC Request failed");

  // `meta()` is the same class of read — one eth_call, no range — so it shares their fate.
  const meta = makeClient({ logs: () => [], metaError: new Error("RPC Request failed") });
  await expect(readAmendments(meta.client, PROXY, A)).rejects.toThrow("RPC Request failed");
});

test("G3: a vetoed hash is parked, not 'not confirmed yet'", () => {
  // Veto DELETES `scheduledAt` and sets the sticky flag, so a parked hash and a hash the chain has
  // never heard of are both `scheduledAt == 0`. Reading only the former would tell a guardian that
  // the veto they just signed "has not confirmed yet".
  const vetoed: Amendment[] = [{ hash: A, scheduledAt: ZERO, vetoed: true }];
  const c = classifyAmendments(vetoed, A);
  expect(c.parked).toEqual(vetoed);
  expect(c.live).toEqual([]);
  expect(c.apiClaimsPendingButChainDoesNot).toBe(false);

  // The genuine "not confirmed yet" case, for contrast: zero AND never vetoed.
  const unknown: Amendment[] = [{ hash: A, scheduledAt: ZERO, vetoed: false }];
  const u = classifyAmendments(unknown, A);
  expect(u.parked).toEqual([]);
  expect(u.apiClaimsPendingButChainDoesNot).toBe(true);
});

test("multicall3 absent: the point reads fall back to individual eth_calls", async () => {
  const { client, pointReads, multicallCalls } = makeClient({
    logs: () => [],
    states: { [A.toLowerCase()]: { scheduledAt: EXECUTABLE_AT, vetoed: false } },
  });

  const chain = await readAmendments(client, PROXY, A);

  expect(multicallCalls()).toBe(0);
  expect(pointReads).toContain(`scheduledAt:${A.toLowerCase()}`);
  expect(pointReads).toContain(`vetoed:${A.toLowerCase()}`);
  expect(chain.amendments).toEqual([{ hash: A, scheduledAt: EXECUTABLE_AT, vetoed: false }]);
});

test("multicall3 present: the batch is used, and a failing batch still degrades to eth_calls", async () => {
  const states = { [A.toLowerCase()]: { scheduledAt: EXECUTABLE_AT, vetoed: false } };

  const batched = makeClient({ logs: () => [], states, multicall3: true });
  const viaBatch = await readAmendments(batched.client, PROXY, A);
  expect(batched.multicallCalls()).toBe(1);
  expect(batched.pointReads).toEqual([]);
  expect(viaBatch.amendments).toEqual([{ hash: A, scheduledAt: EXECUTABLE_AT, vetoed: false }]);

  const broken = makeClient({
    logs: () => [],
    states,
    multicall3: true,
    multicallError: new Error("multicall3 not deployed"),
  });
  const viaCalls = await readAmendments(broken.client, PROXY, A);
  expect(broken.multicallCalls()).toBe(1);
  expect(viaCalls.amendments).toEqual([{ hash: A, scheduledAt: EXECUTABLE_AT, vetoed: false }]);
});
