import { describe, expect, test, vi } from "vitest";
import { AGENT_WALLET_KEY } from "../../src/monitor/events";
import type { LogQuery, MonitorRpc, RawLog } from "../../src/monitor/rpc";
import {
  MAX_LOG_RANGE,
  MIN_LOG_RANGE,
  chunkRange,
  coldStartFrom,
  fetchWindow,
  isRangeTooLargeError,
  logKey,
  shrinkRange,
} from "../../src/monitor/scan";
import { ADDR } from "./helpers";

describe("chunkRange — the 100,000-block getLogs ceiling", () => {
  test("a window inside the cap is one query", () => {
    expect(chunkRange(1n, 90_000n)).toEqual([{ from: 1n, to: 90_000n }]);
  });

  test("a window one block over the cap splits in two, with no gap and no overlap", () => {
    const chunks = chunkRange(1n, 90_001n);
    expect(chunks).toEqual([
      { from: 1n, to: 90_000n },
      { from: 90_001n, to: 90_001n },
    ]);
  });

  test("a long outage splits into consecutive full chunks", () => {
    const chunks = chunkRange(0n, 250_000n);
    expect(chunks).toHaveLength(3);
    // Contiguity is the property that matters: a gap here is an unseen block forever.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.from).toBe(chunks[i - 1]!.to + 1n);
    expect(chunks.at(-1)?.to).toBe(250_000n);
    for (const c of chunks) expect(c.to - c.from + 1n).toBeLessThanOrEqual(MAX_LOG_RANGE);
  });

  test("every chunk is at most MAX_LOG_RANGE blocks INCLUSIVE (an off-by-one is an RPC error)", () => {
    const [first] = chunkRange(1000n, 1_000_000n);
    expect(first!.to - first!.from + 1n).toBe(MAX_LOG_RANGE);
  });

  test("an empty or inverted window yields nothing", () => {
    expect(chunkRange(50n, 49n)).toEqual([]);
  });

  test("a single block is a single one-block chunk", () => {
    expect(chunkRange(7n, 7n)).toEqual([{ from: 7n, to: 7n }]);
  });
});

describe("range-rejection detection", () => {
  test("recognises the Arc rejection verbatim, as viem wraps it", () => {
    expect(
      isRangeTooLargeError(
        new Error(
          'RPC Request failed.\n\nURL: https://rpc.testnet.arc.network\nRequest body: {"method":"eth_getLogs"}\n\nDetails: requested range too large\nVersion: viem@2.52.2',
        ),
      ),
    ).toBe(true);
  });

  test("recognises the phrasings other endpoints use", () => {
    for (const m of [
      "query returned more than 10000 results",
      "block range is too wide",
      "exceeds the max block range of 2000",
      "too many blocks requested",
    ])
      expect(isRangeTooLargeError(new Error(m))).toBe(true);
  });

  test("does NOT mistake an outage for a too-wide window (that would shrink forever)", () => {
    for (const m of ["ECONNRESET", "rate limit exceeded", "execution reverted", "502 Bad Gateway"])
      expect(isRangeTooLargeError(new Error(m))).toBe(false);
  });
});

describe("shrinkRange", () => {
  test("halves down toward the floor", () => {
    expect(shrinkRange(MAX_LOG_RANGE)).toBe(45_000n);
    expect(shrinkRange(45_000n)).toBe(22_500n);
  });

  test("clamps to MIN_LOG_RANGE instead of undershooting", () => {
    expect(shrinkRange(1_500n)).toBe(MIN_LOG_RANGE);
  });

  test("gives up at the floor — below this the window is not the problem", () => {
    expect(shrinkRange(MIN_LOG_RANGE)).toBeUndefined();
  });

  test("reaches the floor in a bounded number of steps", () => {
    let r: bigint | undefined = MAX_LOG_RANGE;
    let steps = 0;
    while (r !== undefined) {
      r = shrinkRange(r);
      steps++;
    }
    expect(steps).toBeLessThan(10);
  });
});

describe("coldStartFrom", () => {
  test("never genesis — a cold start looks back a bounded window", () => {
    expect(coldStartFrom(57_731_006n, 5000)).toBe(57_726_006n);
  });

  test("clamps at 0 on a short chain", () => {
    expect(coldStartFrom(10n, 5000)).toBe(0n);
  });
});

describe("fetchWindow", () => {
  function rpcSpy(logs: RawLog[] = []) {
    const calls: LogQuery[] = [];
    const rpc: MonitorRpc = {
      getBlockNumber: vi.fn(async () => 0n),
      getLogs: vi.fn(async (q: LogQuery) => {
        calls.push(q);
        return logs;
      }),
      getBlockTimestamp: vi.fn(async () => 0n),
      readContract: vi.fn(async () => undefined),
    };
    return { rpc, calls };
  }

  test("our own contracts are read unfiltered; the SHARED registry never is", async () => {
    const { rpc, calls } = rpcSpy();
    await fetchWindow(
      rpc,
      { own: [ADDR.controller, ADDR.treasury], registry: ADDR.registry, agentIds: ["881938"] },
      { from: 1n, to: 100n },
    );
    expect(calls).toHaveLength(3);

    const own = calls.find((c) => Array.isArray(c.address));
    expect(own?.event).toBeUndefined();

    const metadata = calls.find((c) => c.args && "indexedMetadataKey" in c.args);
    expect(metadata?.address).toBe(ADDR.registry);
    expect(metadata?.args?.indexedMetadataKey).toBe(AGENT_WALLET_KEY);

    const transfer = calls.find((c) => c.args && "tokenId" in c.args);
    expect(transfer?.args?.tokenId).toEqual([881938n]);
  });

  test("with no agents yet the Transfer query is SKIPPED, not left unfiltered", async () => {
    const { rpc, calls } = rpcSpy();
    await fetchWindow(
      rpc,
      { own: [ADDR.controller], registry: ADDR.registry, agentIds: [] },
      { from: 1n, to: 100n },
    );
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.args && "tokenId" in c.args)).toBe(false);
  });

  test("results are merged into on-chain order across the three queries", async () => {
    const mk = (blockNumber: bigint, logIndex: number): RawLog => ({
      address: ADDR.controller,
      topics: ["0x00"],
      data: "0x",
      blockNumber,
      transactionHash: "0xaa",
      logIndex,
    });
    const rpc: MonitorRpc = {
      getBlockNumber: vi.fn(async () => 0n),
      getLogs: vi
        .fn()
        .mockResolvedValueOnce([mk(5n, 2), mk(5n, 0)])
        .mockResolvedValueOnce([mk(3n, 9)])
        .mockResolvedValueOnce([mk(4n, 1)]),
      getBlockTimestamp: vi.fn(async () => 0n),
      readContract: vi.fn(async () => undefined),
    };
    const logs = await fetchWindow(
      rpc,
      { own: [ADDR.controller], registry: ADDR.registry, agentIds: ["1"] },
      { from: 1n, to: 100n },
    );
    expect(logs.map((l) => [Number(l.blockNumber), l.logIndex])).toEqual([
      [3, 9],
      [4, 1],
      [5, 0],
      [5, 2],
    ]);
  });

  test("an RPC failure propagates so the caller can hold the cursor back", async () => {
    const rpc: MonitorRpc = {
      getBlockNumber: vi.fn(async () => 0n),
      getLogs: vi.fn(async () => {
        throw new Error("requested range too large");
      }),
      getBlockTimestamp: vi.fn(async () => 0n),
      readContract: vi.fn(async () => undefined),
    };
    await expect(
      fetchWindow(rpc, { own: [], registry: ADDR.registry, agentIds: [] }, { from: 1n, to: 2n }),
    ).rejects.toThrow(/range too large/);
  });
});

describe("logKey", () => {
  test("is stable per (rule, tx, logIndex) and distinguishes two rules on one log", () => {
    const log = { transactionHash: "0xdead" as const, logIndex: 3 };
    expect(logKey("a", log)).toBe(logKey("a", log));
    expect(logKey("a", log)).not.toBe(logKey("b", log));
  });
});
