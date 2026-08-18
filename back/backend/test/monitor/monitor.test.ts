import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { noviControllerAbi } from "../../src/abis/generated";
import type { Alert, AlertSink } from "../../src/monitor/alerts";
import type { EntityLookup, MonitoredEntity } from "../../src/monitor/entityLookup";
import { EntityLookupError } from "../../src/monitor/errors";
import { WILDCARD_ROLE } from "../../src/monitor/events";
import { Monitor, type MonitorConfig } from "../../src/monitor/monitor";
import type { LogQuery, MonitorRpc, RawLog } from "../../src/monitor/rpc";
import { SqliteMonitorStore } from "../../src/monitor/store";
import { ADDR, entity, makeLog } from "./helpers";

const BASE_CFG: MonitorConfig = {
  controller: ADDR.controller,
  registry: ADDR.registry,
  factories: [ADDR.factory],
  beacons: [],
  executor: ADDR.executor,
  pollMs: 30_000,
  grantTtlMs: 15 * 60_000,
  lookbackBlocks: 5000,
};

function collectingSink() {
  const alerts: Alert[] = [];
  const sink: AlertSink = { emit: async (a) => void alerts.push(a) };
  return { sink, alerts };
}

function lookup(entities: MonitoredEntity[] = [entity()]): EntityLookup {
  return { all: () => entities, close: () => {} };
}

function failingLookup(): EntityLookup {
  return {
    all: () => {
      throw new EntityLookupError("database is locked");
    },
    close: () => {},
  };
}

interface RpcStub extends MonitorRpc {
  queries: LogQuery[];
}

function rpcStub(over: {
  head?: bigint;
  logsFor?: (q: LogQuery) => RawLog[];
  failLogs?: boolean;
  blockTimestamp?: bigint;
  payout?: Address;
}): RpcStub {
  const queries: LogQuery[] = [];
  return {
    queries,
    getBlockNumber: async () => over.head ?? 1000n,
    getLogs: async (q) => {
      queries.push(q);
      if (over.failLogs) throw new Error("requested range too large");
      return over.logsFor?.(q) ?? [];
    },
    getBlockTimestamp: async () => over.blockTimestamp ?? 1_700_000_000n,
    readContract: async () => over.payout ?? ADDR.operator,
  };
}

function wildcardGrant(block: bigint, logIndex = 0): RawLog {
  return makeLog({
    abi: noviControllerAbi,
    eventName: "RoleGranted",
    args: { role: WILDCARD_ROLE, account: ADDR.helper, sender: ADDR.admin },
    address: ADDR.controller,
    blockNumber: block,
    transactionHash: `0x${"cd".repeat(32)}`,
    logIndex,
  });
}

describe("cold start", () => {
  test("scans back MONITOR_LOOKBACK_BLOCKS, never genesis", async () => {
    const rpc = rpcStub({ head: 57_731_006n });
    const store = SqliteMonitorStore.open(":memory:");
    const { sink } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    }).tick();

    expect(rpc.queries[0]?.fromBlock).toBe(57_726_006n);
    expect(store.getCursor()).toBe(57_731_006n);
  });
});

describe("chunked scanning", () => {
  test("a window over the RPC ceiling is issued as consecutive chunks", async () => {
    // 200k blocks behind head => 3 chunks at the 90k cap.
    const rpc = rpcStub({ head: 200_000n });
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(0n);
    const { sink } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    }).tick();

    // Two queries per chunk here (own + registry metadata; no Transfer query would appear without
    // agentIds, but our fixture entity has one, so three).
    const ownQueries = rpc.queries.filter((q) => Array.isArray(q.address));
    expect(ownQueries.map((q) => [q.fromBlock, q.toBlock])).toEqual([
      [1n, 90_000n],
      [90_001n, 180_000n],
      [180_001n, 200_000n],
    ]);
    expect(store.getCursor()).toBe(200_000n);
  });

  test("the cursor advances per CHUNK, so a mid-window failure loses nothing", async () => {
    let call = 0;
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(0n);
    const rpc: MonitorRpc = {
      getBlockNumber: async () => 200_000n,
      getLogs: async (q) => {
        // Fail once the second chunk starts.
        if ((q.fromBlock as bigint) > 90_000n) throw new Error("RPC 502");
        call++;
        return [];
      },
      getBlockTimestamp: async () => 0n,
      readContract: async () => ADDR.operator,
    };
    const { sink } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    }).tick();
    expect(call).toBeGreaterThan(0);
    // First chunk committed; second did not, so the next tick re-reads from 90_001.
    expect(store.getCursor()).toBe(90_000n);
  });

  test("a REJECTED range halves the window so the next tick can make progress", async () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(0n);
    const seen: bigint[] = [];
    const rpc: MonitorRpc = {
      getBlockNumber: async () => 200_000n,
      getLogs: async (q) => {
        const width = (q.toBlock as bigint) - (q.fromBlock as bigint) + 1n;
        seen.push(width);
        if (width > 10_000n) throw new Error("Details: requested range too large");
        return [];
      },
      getBlockTimestamp: async () => 0n,
      readContract: async () => ADDR.operator,
    };
    const { sink } = collectingSink();
    const monitor = new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    });

    // 90k -> 45k -> 22.5k -> 11.25k -> 5625: five ticks to find a window this endpoint serves.
    for (let i = 0; i < 5; i++) await monitor.tick();
    expect(monitor.logRange()).toBe(5625n);
    expect(seen.at(-1)).toBeLessThanOrEqual(10_000n);
    // Nothing was committed while the queries were rejected; the tick that finally found a
    // workable window then walked the whole backlog in 5625-block chunks.
    expect(store.getCursor()).toBe(200_000n);
    // Four shrink steps, three parallel queries each (own + registry metadata + registry transfer).
    expect(seen.filter((w) => w > 10_000n)).toHaveLength(12);
  });

  test("shrinking stops at the floor rather than spinning to zero", async () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(0n);
    const rpc: MonitorRpc = {
      getBlockNumber: async () => 200_000n,
      getLogs: async () => {
        throw new Error("requested range too large");
      },
      getBlockTimestamp: async () => 0n,
      readContract: async () => ADDR.operator,
    };
    const { sink } = collectingSink();
    const monitor = new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    });
    for (let i = 0; i < 20; i++) await monitor.tick();
    expect(monitor.logRange()).toBe(1000n);
    expect(store.getCursor()).toBe(0n);
  });

  test("an ordinary RPC outage does NOT shrink the window", async () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(0n);
    const rpc: MonitorRpc = {
      getBlockNumber: async () => 200_000n,
      getLogs: async () => {
        throw new Error("ECONNRESET");
      },
      getBlockTimestamp: async () => 0n,
      readContract: async () => ADDR.operator,
    };
    const { sink } = collectingSink();
    const monitor = new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    });
    await monitor.tick();
    await monitor.tick();
    expect(monitor.logRange()).toBe(90_000n);
  });

  test("no new blocks since the last tick issues no query at all", async () => {
    const rpc = rpcStub({ head: 1000n });
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(1000n);
    const { sink } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    }).tick();
    expect(rpc.queries).toHaveLength(0);
  });

  test("a head-read failure is survived and leaves the cursor untouched", async () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(500n);
    const rpc: MonitorRpc = {
      getBlockNumber: async () => {
        throw new Error("ECONNRESET");
      },
      getLogs: async () => [],
      getBlockTimestamp: async () => 0n,
      readContract: async () => ADDR.operator,
    };
    const { sink } = collectingSink();
    await expect(
      new Monitor({ rpc, store, entities: lookup(), sink, cfg: BASE_CFG, log: () => {} }).tick(),
    ).resolves.toBeUndefined();
    expect(store.getCursor()).toBe(500n);
  });
});

describe("watch targets", () => {
  test("the configured factory's beacon is read once and then watched", async () => {
    const readBeacon = vi.fn(async () => ADDR.beacon);
    const rpc = rpcStub({ head: 1000n });
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(999n);
    const { sink } = collectingSink();
    const monitor = new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      beaconSource: ADDR.factory,
      readBeacon,
      log: () => {},
    });
    await monitor.tick();
    await monitor.tick();
    expect(readBeacon).toHaveBeenCalledTimes(1);
    const own = rpc.queries.find((q) => Array.isArray(q.address))?.address as Address[];
    expect(own).toContain(ADDR.beacon);
    expect(own).toContain(ADDR.controller);
    expect(own).toContain(ADDR.factory);
    expect(own).toContain(ADDR.treasury);
  });

  test("a failed beacon read is RETRIED next tick rather than silently disabling rule 6", async () => {
    const readBeacon = vi
      .fn<(f: Address) => Promise<Address>>()
      .mockRejectedValueOnce(new Error("RPC down"))
      .mockResolvedValueOnce(ADDR.beacon);
    const rpc = rpcStub({ head: 1000n });
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(999n);
    const { sink } = collectingSink();
    const monitor = new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      beaconSource: ADDR.factory,
      readBeacon,
      log: () => {},
    });
    await monitor.tick();
    await monitor.tick();
    expect(readBeacon).toHaveBeenCalledTimes(2);
  });
});

describe("entity lookup resilience", () => {
  test("a locked main DB does not stop the tick, and controller rules still fire", async () => {
    const rpc = rpcStub({ head: 1000n, logsFor: () => [wildcardGrant(1000n)] });
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(999n);
    const { sink, alerts } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: failingLookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    }).tick();
    expect(alerts.map((a) => a.rule)).toContain("controller_role_granted");
  });
});

describe("grant tracking and the TTL sweep", () => {
  let store: SqliteMonitorStore;
  beforeEach(() => {
    store = SqliteMonitorStore.open(":memory:");
    store.setCursor(999n);
  });

  test("a ceremony grant is stamped with the BLOCK time, not the observation time", async () => {
    const rpc = rpcStub({
      head: 1000n,
      logsFor: (q) => (Array.isArray(q.address) ? [wildcardGrant(1000n)] : []),
      blockTimestamp: 1_700_000_000n,
    });
    const { sink } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      // Observation clock is deliberately much later than the block clock.
      now: () => 9_999_999_999_999,
      log: () => {},
    }).tick();
    const [g] = store.listOpenGrants();
    expect(g?.grantedAtTs).toBe(1_700_000_000_000);
  });

  test("a grant older than the TTL pages on the very next tick", async () => {
    const rpc = rpcStub({
      head: 1000n,
      logsFor: (q) => (Array.isArray(q.address) ? [wildcardGrant(1000n)] : []),
      blockTimestamp: 1_700_000_000n,
    });
    const { sink, alerts } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      now: () => 1_700_000_000_000 + 16 * 60_000,
      log: () => {},
    }).tick();
    const ttl = alerts.filter((a) => a.rule === "controller_grant_ttl_exceeded");
    expect(ttl).toHaveLength(1);
    expect(ttl[0]?.severity).toBe("CRITICAL");
    expect(store.listOpenGrants()[0]?.alertedCount).toBe(1);
  });

  test("the same standing grant pages once per TTL interval, not once per tick", async () => {
    store.openGrant({
      role: WILDCARD_ROLE.toLowerCase(),
      account: ADDR.helper.toLowerCase(),
      grantedAtBlock: 1n,
      grantedAtTs: 0,
    });
    const rpc = rpcStub({ head: 1000n });
    const { sink, alerts } = collectingSink();
    let clock = 16 * 60_000;
    const monitor = new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      now: () => clock,
      log: () => {},
    });
    await monitor.tick();
    await monitor.tick(); // same interval — silent
    clock = 31 * 60_000; // next interval — pages again
    await monitor.tick();
    expect(alerts.filter((a) => a.rule === "controller_grant_ttl_exceeded")).toHaveLength(2);
  });

  test("a revoke closes the row and ends the paging", async () => {
    const revoke = makeLog({
      abi: noviControllerAbi,
      eventName: "RoleRevoked",
      args: { role: WILDCARD_ROLE, account: ADDR.helper, sender: ADDR.admin },
      address: ADDR.controller,
      blockNumber: 1000n,
      logIndex: 1,
    });
    const rpc = rpcStub({
      head: 1000n,
      logsFor: (q) => (Array.isArray(q.address) ? [wildcardGrant(1000n), revoke] : []),
      blockTimestamp: 1_700_000_000n,
    });
    const { sink, alerts } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      now: () => 1_700_000_000_000 + 60 * 60_000,
      log: () => {},
    }).tick();
    expect(store.listOpenGrants()).toHaveLength(0);
    expect(alerts.filter((a) => a.rule === "controller_grant_ttl_exceeded")).toHaveLength(0);
  });
});

describe("failure isolation", () => {
  test("one undecodable log does not abort the rest of the window", async () => {
    const garbage: RawLog = {
      address: ADDR.controller,
      // A topic0 the controller ABI does not know is simply ignored; a MALFORMED one that matches
      // a known topic0 but carries no data is what actually throws.
      topics: [wildcardGrant(1000n).topics[0]!],
      data: "0x",
      blockNumber: 1000n,
      transactionHash: `0x${"ee".repeat(32)}`,
      logIndex: 0,
    };
    const rpc = rpcStub({
      head: 1000n,
      logsFor: (q) => (Array.isArray(q.address) ? [garbage, wildcardGrant(1000n, 5)] : []),
    });
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(999n);
    const { sink, alerts } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    }).tick();
    expect(alerts.map((a) => a.rule)).toContain("controller_role_granted");
    expect(store.getCursor()).toBe(1000n);
  });

  test("start() keeps polling after a tick that throws", async () => {
    vi.useFakeTimers();
    const store = SqliteMonitorStore.open(":memory:");
    let ticks = 0;
    const rpc: MonitorRpc = {
      getBlockNumber: async () => {
        ticks++;
        throw new Error("boom");
      },
      getLogs: async () => [],
      getBlockTimestamp: async () => 0n,
      readContract: async () => ADDR.operator,
    };
    const { sink } = collectingSink();
    const monitor = new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: { ...BASE_CFG, pollMs: 10 },
      log: () => {},
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(40);
    monitor.stop();
    expect(ticks).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});

describe("treasury payout read", () => {
  test("an unreadable payoutAddress degrades the alert instead of the tick", async () => {
    const scheduled = makeLog({
      abi: (await import("../../src/abis/generated")).agentTreasuryAbi,
      eventName: "PolicyUpdateScheduled",
      args: {
        policyId: `0x${"11".repeat(32)}`,
        cap: 1n,
        period: 2n,
        allowlistOn: false,
        payoutAddress: ADDR.attacker,
        executableAt: 1_700_003_600n,
      },
      address: ADDR.treasury,
      blockNumber: 1000n,
    });
    const rpc: MonitorRpc = {
      getBlockNumber: async () => 1000n,
      getLogs: async (q) => (Array.isArray(q.address) ? [scheduled] : []),
      getBlockTimestamp: async () => 0n,
      readContract: async () => {
        throw new Error("execution reverted");
      },
    };
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(999n);
    const { sink, alerts } = collectingSink();
    await new Monitor({
      rpc,
      store,
      entities: lookup(),
      sink,
      cfg: BASE_CFG,
      log: () => {},
    }).tick();
    const policy = alerts.find((a) => a.rule === "treasury_policy_update_scheduled");
    expect(policy?.severity).toBe("WARN");
    expect(policy?.detail.currentPayoutAddress).toBe("unreadable");
    expect(alerts.some((a) => a.rule === "treasury_guardian_notification")).toBe(true);
  });
});
