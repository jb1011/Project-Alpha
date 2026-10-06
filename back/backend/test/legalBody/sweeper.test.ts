/**
 * The legal-body sweeper: the loop that, each tick, settles the due reserved orders, checks the due
 * bindings and, on the first tick and every 120th after it, abandons expired drafts and runs the
 * customer-company housekeeping. Each row is worked under its order's lock and in its own
 * try/catch; a row whose pass throws moves back in its listing instead of staying first; and the
 * loop takes no token from any budget.
 *
 * The database is real (in memory, or on disk for the restart). The chain is a fake whose answers
 * each test steers; any member it does not fake throws when read. The process clock is injected
 * and starts at the wall clock, because a row's `createdAt` is written by the database's own clock;
 * the fake head's time follows the injected clock. Every name, company and filing number is an
 * invention, and every key is one of anvil's published test accounts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type Address, type Hex, getAddress, keccak256, toHex } from "viem";
import { type Mock, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LegalBodyChainPort, LegalBodyCreated } from "../../src/adapters/arc/legalBodyChain";
import { DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS, loadConfig } from "../../src/config/env";
import { type LegalBodyOrderDeps, createOrder, orderLockKey } from "../../src/legalBody/orders";
import {
  HOUSEKEEPING_BATCH,
  HOUSEKEEPING_EVERY_N_TICKS,
  LEGAL_BODY_SWEEP_MAX_PER_TICK,
  LegalBodySweeper,
  type LegalBodySweeperDeps,
} from "../../src/legalBody/sweeper";
import { withKeyedLock } from "../../src/payments/keyedMutex";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { ANVIL_ACCOUNT_2, recordHuman } from "../helpers/customerCompanyFixtures";
import {
  IDENTITY_OWNER,
  LINK_HEAD,
  type LegalBodyStores,
  asChainPort,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

const tenant = ANVIL_ACCOUNT_2.address;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let db: Database.Database;
let s: LegalBodyStores;
let chain: FakeChain;
let lines: string[];
/** The process clock the deps read, in unix milliseconds. */
let clock: number;
let filings = 0;
let agents = 1_000;
let links = 0;
let submissions = 0;
/** The bodies the fake factory has created (lower-case), and each create's record by its hash. */
let createdBodies: Set<string>;
let creations: Map<Hex, LegalBodyCreated>;
/** The body each identity's pointer names, by agentId. */
let pointers: Map<string, Address>;
let expireEvidence: Mock<() => number>;
let expireStaleCompanies: Mock<() => number>;
/** Every sweeper a test built, stopped after it. */
let built: LegalBodySweeper[];

const nowSeconds = () => Math.floor(clock / 1_000);

/**
 * Every read the resolver and the binding check make, beside the link door's fakes. By default the
 * head is at the clock's time, no body is created, no hash has a receipt, the platform key has
 * mined nothing and holds every recorded nonce in the node's pool (so a reserved order with a
 * recorded create answers `waiting`), and no identity's pointer names a body.
 */
function fakeChain() {
  return {
    ...fakeLinkChainMembers(),
    head: vi.fn<LegalBodyChainPort["head"]>(async () => ({
      number: LINK_HEAD.number,
      timestamp: BigInt(nowSeconds()),
    })),
    createdState: vi.fn<LegalBodyChainPort["createdState"]>(async ({ bodyAddress }) =>
      createdBodies.has(bodyAddress.toLowerCase()) ? "created" : "absent",
    ),
    createOutcome: vi.fn<LegalBodyChainPort["createOutcome"]>(async (txHash) => {
      const created = creations.get(txHash);
      return created ? { status: "created", created } : { status: "absent" };
    }),
    findCreation: vi.fn<LegalBodyChainPort["findCreation"]>(async () => undefined),
    rebroadcastCreate: vi.fn<LegalBodyChainPort["rebroadcastCreate"]>(async () => {}),
    executorNonce: vi.fn<LegalBodyChainPort["executorNonce"]>(async () => 0),
    executorPendingNonce: vi.fn<LegalBodyChainPort["executorPendingNonce"]>(async () => 100),
    linkedLegalBody: vi.fn<LegalBodyChainPort["linkedLegalBody"]>(async (agentId) =>
      pointers.get(agentId.toString()),
    ),
    bodyStatus: vi.fn<LegalBodyChainPort["bodyStatus"]>(async () => "active"),
  };
}
type FakeChain = ReturnType<typeof fakeChain>;

/** The stores over `handle`, with the tenant recorded as a verified human. */
function useDatabase(handle: Database.Database): void {
  db = handle;
  s = openLegalBodyStores(db);
}

beforeEach(() => {
  const handle = openDatabase(":memory:");
  migrate(handle);
  useDatabase(handle);
  recordHuman(s.store, tenant, "4001", Date.now());
  clock = Date.now();
  chain = fakeChain();
  createdBodies = new Set();
  creations = new Map();
  pointers = new Map();
  expireEvidence = vi.fn(() => 0);
  expireStaleCompanies = vi.fn(() => 0);
  built = [];
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  for (const sweeper of built) sweeper.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (db.open) db.close();
});

function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, { chain: asChainPort(chain), now: () => clock, ...over });
}

/** A sweeper over the test's stores, on the test's clock, five rows per listing per tick. */
function sweeper(over: Partial<LegalBodySweeperDeps> = {}): LegalBodySweeper {
  const made = new LegalBodySweeper({
    ...orderDeps(),
    intervalMs: 30_000,
    maxPerTick: LEGAL_BODY_SWEEP_MAX_PER_TICK,
    housekeeping: { expireEvidence, expireStaleCompanies },
    ...over,
  });
  built.push(made);
  return made;
}

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A draft of the tenant, placed through the order door for a company of its own. */
function draft(): LegalBodyRecord {
  const companyId = customerCompany(s, tenant, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const view = createOrder(
    orderDeps({ maxOpenPerTenant: 50, maxOrdersPerTenantPerDay: 50 }),
    tenant,
    {
      companyId,
    },
  );
  return rowOf(view.id);
}

/** An order reserved through the repository for its own identity and body, first due at
 *  `firstCheckAt`. The signature is a placeholder: no test here submits a create again. */
function reservedOrder(firstCheckAt: number): LegalBodyRecord {
  const row = draft();
  const n = ++links;
  expect(
    s.repo.reserve(row.legalBodyId, {
      agentId: String(++agents),
      identityOwner: IDENTITY_OWNER.address,
      linkDigest: keccak256(toHex(`sweeper-link-${n}`)),
      linkDeadline: nowSeconds() + 3_600,
      linkSignature: `0x${"ab".repeat(65)}` as Hex,
      bodyAddress: getAddress(`0x${keccak256(toHex(`sweeper-body-${n}`)).slice(-40)}`),
      observedAtBlock: 8_000,
      firstCheckAt,
    }),
  ).toBe("reserved");
  return rowOf(row.legalBodyId);
}

/** Records a create sent for a reserved order at `nonce`, and returns its hash. */
function recordCreate(row: LegalBodyRecord, nonce: number): Hex {
  const txHash = keccak256(toHex(`sweeper-create-${++submissions}`));
  expect(
    s.repo.recordDeploySubmission(row.legalBodyId, {
      txHash,
      rawTx: `0x02cd${submissions.toString(16).padStart(6, "0")}` as Hex,
      nonce,
    }),
  ).toBe(true);
  return txHash;
}

/** The fake factory created the row's body with `txHash`: its state reads `created` and that
 *  hash's receipt names it. */
function createdOnChain(row: LegalBodyRecord, txHash: Hex): void {
  if (!row.bodyAddress || !row.agentId || !row.identityOwner || !row.linkDigest)
    throw new Error(`order ${row.legalBodyId} holds no link`);
  createdBodies.add(row.bodyAddress.toLowerCase());
  creations.set(txHash, {
    legalBody: row.bodyAddress,
    agentId: BigInt(row.agentId),
    identityOwner: row.identityOwner,
    guardian: row.guardian,
    linkDigest: row.linkDigest,
    txHash,
    blockNumber: Number(LINK_HEAD.number) - 1,
    deployedAt: nowSeconds() - 5,
  });
}

/** A body created on chain, its binding next checked at `nextAt`, every minute. */
function deployedOrder(nextAt: number): LegalBodyRecord {
  const id = reservedOrder(clock + HOUR).legalBodyId;
  expect(
    s.repo.markDeployed(id, {
      txHash: keccak256(toHex(`sweeper-deployed-${id}`)),
      deployedAt: nowSeconds() - 60,
    }),
  ).toBe(true);
  expect(s.repo.scheduleBindingCheck(id, nextAt, MINUTE)).toBe(true);
  return rowOf(id);
}

/** The identity's pointer names the row's body. */
function pointAt(row: LegalBodyRecord): void {
  if (!row.agentId || !row.bodyAddress) throw new Error(`order ${row.legalBodyId} holds no body`);
  pointers.set(row.agentId, row.bodyAddress);
}

const opsLines = () =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return "opslog" in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });

const linesNamed = (event: string) => opsLines().filter((line) => line.opslog === event);

/** The bodies whose created state was asked, and the identities whose pointer was read. */
const bodiesAsked = () =>
  chain.createdState.mock.calls.map(([p]) => p.bodyAddress.toLowerCase()).sort();
const agentsAsked = () => chain.linkedLegalBody.mock.calls.map(([agentId]) => agentId.toString());

/** A fault that is not the chain's, with a message that must never reach a log line. */
class DiskFault extends Error {
  constructor() {
    super("disk fault while reading /example/hidden-location/bodies.db");
    this.name = "DiskFault";
  }
}

/** Lets every pending promise and timer callback of the current turn run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── One tick ────────────────────────────────────────────────────────────────────────────────

describe("one tick", () => {
  test("resolves a due reserved order and checks a due binding, leaves the rows not yet due alone, and takes no token", async () => {
    const dueReserved = reservedOrder(clock);
    createdOnChain(dueReserved, recordCreate(dueReserved, 0));
    const dueBinding = deployedOrder(clock);
    pointAt(dueBinding);
    const laterReserved = reservedOrder(clock + MINUTE);
    createdOnChain(laterReserved, recordCreate(laterReserved, 1));
    const laterBinding = deployedOrder(clock + MINUTE);
    pointAt(laterBinding);
    const before = [laterReserved, laterBinding].map((row) => rowOf(row.legalBodyId));
    // Every budget is empty, and any take would be seen.
    const take = vi.fn(() => false);

    await sweeper({
      doorBudget: { take },
      tenantBucket: () => ({ take }),
      identityBucket: () => ({ take }),
    }).tick();

    expect(rowOf(dueReserved.legalBodyId).bindingState).toBe("deployed");
    expect(rowOf(dueReserved.legalBodyId).createTxHash).toBe(
      s.repo.listDeploySubmissions(dueReserved.legalBodyId)[0]?.txHash,
    );
    expect(rowOf(dueBinding.legalBodyId).bindingState).toBe("linked");
    expect(rowOf(dueBinding.legalBodyId).nextBindingCheckAt).toBe(clock + 24 * HOUR);
    // Not due: as they were, and the chain was asked nothing about them.
    expect([laterReserved, laterBinding].map((row) => rowOf(row.legalBodyId))).toEqual(before);
    expect(bodiesAsked()).toEqual([dueReserved.bodyAddress?.toLowerCase()]);
    // The body created this tick is due for its first binding check at once, so the binding leg
    // that follows checks it too.
    expect(agentsAsked().sort()).toEqual([dueReserved.agentId, dueBinding.agentId].sort());
    expect(take).not.toHaveBeenCalled();
  });

  test("six rows that all answer waiting do not stop a seventh from being resolved on a later tick: their schedules back off", async () => {
    const waiting = Array.from({ length: 6 }, (_, i) => {
      const row = reservedOrder(clock - 7_000 + i * 1_000);
      recordCreate(row, i);
      return row;
    });
    const seventh = reservedOrder(clock - 1_000);
    createdOnChain(seventh, recordCreate(seventh, 6));
    const sw = sweeper();

    // The first five, soonest first: each waits, and its next check is 30 seconds away.
    await sw.tick();
    for (const row of waiting.slice(0, 5)) {
      expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
      expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 30_000);
    }
    expect(rowOf(seventh.legalBodyId).bindingState).toBe("reserved");
    expect(bodiesAsked()).not.toContain(seventh.bodyAddress?.toLowerCase());

    // A tick at the same time: the five are not due any more, so the sixth and the seventh are.
    await sw.tick();
    expect(rowOf(seventh.legalBodyId).bindingState).toBe("deployed");
    for (const row of waiting) {
      expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
      expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBeGreaterThan(clock);
    }
  });

  test("a row a door holds the lock of is worked only once the door lets go", async () => {
    const row = reservedOrder(clock);
    createdOnChain(row, recordCreate(row, 0));
    let release: () => void = () => {};
    const door = withKeyedLock(
      orderLockKey(row.legalBodyId),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const ticking = sweeper().tick();
    await settle();
    expect(chain.head).not.toHaveBeenCalled();
    expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");

    release();
    await door;
    await ticking;
    expect(rowOf(row.legalBodyId).bindingState).toBe("deployed");
  });
});

// ── A row that throws ───────────────────────────────────────────────────────────────────────

describe("a row whose pass throws", () => {
  test("a reserved order that throws does not stop the next; it moves back 30 seconds, stays on the schedule, and one line names the error, never its message", async () => {
    const throwing = reservedOrder(clock - 2_000);
    recordCreate(throwing, 0);
    const next = reservedOrder(clock - 1_000);
    createdOnChain(next, recordCreate(next, 1));
    const read = s.repo.listDeploySubmissions.bind(s.repo);
    const reads = vi.spyOn(s.repo, "listDeploySubmissions").mockImplementation((id) => {
      if (id === throwing.legalBodyId) throw new DiskFault();
      return read(id);
    });
    const sw = sweeper();

    await sw.tick();

    expect(rowOf(next.legalBodyId).bindingState).toBe("deployed");
    const after = rowOf(throwing.legalBodyId);
    expect(after.bindingState).toBe("reserved");
    expect(after.nextBindingCheckAt).toBe(clock + 30_000);
    expect(after.bindingCheckIntervalMs).toBe(throwing.bindingCheckIntervalMs);
    expect(linesNamed("legal_body_sweep_row_failed")).toEqual([
      expect.objectContaining({
        level: "warn",
        orderId: throwing.legalBodyId,
        leg: "resolve",
        errorName: "DiskFault",
        rescheduled: true,
      }),
    ]);
    expect(lines.join("\n")).not.toContain("hidden-location");

    // At the same time, the row is not due: the next tick does not reach it.
    const passes = reads.mock.calls.filter(([id]) => id === throwing.legalBodyId).length;
    await sw.tick();
    expect(reads.mock.calls.filter(([id]) => id === throwing.legalBodyId)).toHaveLength(passes);
  });

  test("with one row per tick, a row that throws on every pass moves behind the next instead of starving it", async () => {
    const throwing = reservedOrder(clock - 2_000);
    recordCreate(throwing, 0);
    const next = reservedOrder(clock - 1_000);
    createdOnChain(next, recordCreate(next, 1));
    const read = s.repo.listDeploySubmissions.bind(s.repo);
    vi.spyOn(s.repo, "listDeploySubmissions").mockImplementation((id) => {
      if (id === throwing.legalBodyId) throw new DiskFault();
      return read(id);
    });
    const sw = sweeper({ maxPerTick: 1 });

    await sw.tick();
    expect(rowOf(next.legalBodyId).bindingState).toBe("reserved");
    await sw.tick();
    expect(rowOf(next.legalBodyId).bindingState).toBe("deployed");
    expect(rowOf(throwing.legalBodyId).bindingState).toBe("reserved");
  });

  test("a binding check that throws does not stop the next; it moves back by the row's own interval, and one line names the error", async () => {
    const throwing = deployedOrder(clock - 2_000);
    pointAt(throwing);
    const next = deployedOrder(clock - 1_000);
    pointAt(next);
    const read = s.repo.latestBrokenReason.bind(s.repo);
    vi.spyOn(s.repo, "latestBrokenReason").mockImplementation((id) => {
      if (id === throwing.legalBodyId) throw new DiskFault();
      return read(id);
    });

    await sweeper().tick();

    expect(rowOf(next.legalBodyId).bindingState).toBe("linked");
    const after = rowOf(throwing.legalBodyId);
    // The check's own transaction rolled back: the row is as it was, only later.
    expect(after.bindingState).toBe("deployed");
    expect(after.nextBindingCheckAt).toBe(clock + MINUTE);
    expect(after.bindingCheckIntervalMs).toBe(MINUTE);
    expect(linesNamed("legal_body_sweep_row_failed")).toEqual([
      expect.objectContaining({
        orderId: throwing.legalBodyId,
        leg: "binding",
        errorName: "DiskFault",
        rescheduled: true,
      }),
    ]);
    expect(lines.join("\n")).not.toContain("hidden-location");
  });
});

// ── Overlapping ticks ───────────────────────────────────────────────────────────────────────

describe("overlapping ticks", () => {
  test("a tick asked for while one runs returns at once and does nothing; the running one finishes", async () => {
    const row = reservedOrder(clock);
    recordCreate(row, 0);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    chain.head.mockImplementationOnce(async () => {
      await gate;
      return { number: LINK_HEAD.number, timestamp: BigInt(nowSeconds()) };
    });
    const sw = sweeper();

    const running = sw.tick();
    await vi.waitFor(() => expect(chain.head).toHaveBeenCalledTimes(1));
    await sw.tick();
    expect(chain.head).toHaveBeenCalledTimes(1);
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock);

    release();
    await running;
    expect(chain.head).toHaveBeenCalledTimes(1);
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 30_000);
    expect(expireEvidence).toHaveBeenCalledTimes(1);
    expect(expireStaleCompanies).toHaveBeenCalledTimes(1);
  });
});

// ── Housekeeping ────────────────────────────────────────────────────────────────────────────

describe("housekeeping", () => {
  test("the first tick and every 120th after it run it: tick 120 abandons a 25-hour-old draft under its lock, as the system, then expires evidence and stale companies", async () => {
    const old = draft();
    const order: string[] = [];
    expireEvidence.mockImplementation(() => {
      order.push(`evidence, the draft ${rowOf(old.legalBodyId).bindingState}`);
      return 0;
    });
    expireStaleCompanies.mockImplementation(() => {
      order.push("stale companies");
      return 0;
    });
    const listed = vi.spyOn(s.repo, "listExpiredDrafts");
    const sw = sweeper();

    // Tick 0, the boot reconcile: the draft is fresh.
    await sw.tick();
    expect(order).toEqual(["evidence, the draft draft", "stale companies"]);

    // A day and an hour later, ticks 1 to 119 leave it alone.
    clock += 25 * HOUR;
    for (let tick = 1; tick < HOUSEKEEPING_EVERY_N_TICKS; tick++) await sw.tick();
    expect(rowOf(old.legalBodyId).bindingState).toBe("draft");
    expect(expireEvidence).toHaveBeenCalledTimes(1);
    expect(expireStaleCompanies).toHaveBeenCalledTimes(1);

    // Tick 120, while a door holds the draft's lock: nothing moves until the door lets go.
    let release: () => void = () => {};
    const door = withKeyedLock(
      orderLockKey(old.legalBodyId),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const ticking = sw.tick();
    await settle();
    expect(listed).toHaveBeenCalledTimes(2);
    expect(listed).toHaveBeenLastCalledWith(clock, HOUSEKEEPING_BATCH);
    expect(rowOf(old.legalBodyId).bindingState).toBe("draft");
    expect(expireEvidence).toHaveBeenCalledTimes(1);

    release();
    await door;
    await ticking;
    expect(rowOf(old.legalBodyId).bindingState).toBe("abandoned");
    const abandoned = s.repo.listEvents(old.legalBodyId).filter((e) => e.kind === "abandoned");
    expect(abandoned).toEqual([
      expect.objectContaining({ actor: "system", detail: { reason: "expired" } }),
    ]);
    expect(order.slice(2)).toEqual(["evidence, the draft abandoned", "stale companies"]);
    expect(linesNamed("legal_body_housekeeping")).toEqual([
      expect.objectContaining({ draftsAbandoned: 1, evidenceExpired: 0, companiesAbandoned: 0 }),
    ]);
  });

  test("a housekeeping call that throws does not stop the other one, nor the next tick", async () => {
    expireEvidence.mockImplementation(() => {
      throw new DiskFault();
    });
    expireStaleCompanies.mockReturnValue(2);
    const row = reservedOrder(clock + 10_000);
    createdOnChain(row, recordCreate(row, 0));
    const sw = sweeper();

    await sw.tick();
    expect(expireStaleCompanies).toHaveBeenCalledTimes(1);
    expect(linesNamed("legal_body_sweep_failed")).toEqual([
      expect.objectContaining({ level: "warn", leg: "evidence", errorName: "DiskFault" }),
    ]);
    expect(linesNamed("legal_body_housekeeping")).toEqual([
      expect.objectContaining({ draftsAbandoned: 0, evidenceExpired: 0, companiesAbandoned: 2 }),
    ]);
    expect(lines.join("\n")).not.toContain("hidden-location");

    clock += 10_000;
    await sw.tick();
    expect(rowOf(row.legalBodyId).bindingState).toBe("deployed");
  });
});

// ── The loop ────────────────────────────────────────────────────────────────────────────────

describe("the loop", () => {
  test("start() ticks at once, then once each interval after a tick ends, a throwing tick included; stop() ends it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sw = sweeper({ intervalMs: 30_000 });
    const tick = vi.spyOn(sw, "tick");
    tick.mockRejectedValueOnce(new DiskFault());

    sw.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(linesNamed("legal_body_sweep_failed")).toEqual([
      expect.objectContaining({ level: "warn", errorName: "DiskFault" }),
    ]);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(3);

    sw.stop();
    await vi.advanceTimersByTimeAsync(5 * 30_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});

// ── A restart ───────────────────────────────────────────────────────────────────────────────

describe("a restart", () => {
  test("a new sweeper over the same database resolves an order that was reserved with a recorded create when the first process stopped", async () => {
    db.close();
    const dir = mkdtempSync(join(tmpdir(), "legal-body-sweeper-"));
    const path = join(dir, "bodies.db");
    try {
      const first = openDatabase(path);
      migrate(first);
      useDatabase(first);
      recordHuman(s.store, tenant, "4001", Date.now());
      const row = reservedOrder(clock);
      const txHash = recordCreate(row, 0);

      // The first process: its sweeper's first tick finds the create in the node's pool, and then
      // the process stops.
      const before = sweeper();
      before.start();
      await vi.waitFor(() =>
        expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 30_000),
      );
      before.stop();
      first.close();

      // While no process runs, the create is mined.
      createdOnChain(row, txHash);
      clock += 30_000;

      // The new process: a new connection, new stores, a new sweeper. Its first tick runs at once
      // and does not hold up start().
      useDatabase(openDatabase(path));
      const after = sweeper();
      after.start();
      expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
      await vi.waitFor(() => expect(rowOf(row.legalBodyId).bindingState).toBe("deployed"));
      after.stop();
      expect(rowOf(row.legalBodyId).createTxHash).toBe(txHash);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The values ──────────────────────────────────────────────────────────────────────────────

describe("the values", () => {
  test("five rows per listing per tick, housekeeping every 120 ticks, 50 rows per housekeeping call", () => {
    expect(LEGAL_BODY_SWEEP_MAX_PER_TICK).toBe(5);
    expect(HOUSEKEEPING_EVERY_N_TICKS).toBe(120);
    expect(HOUSEKEEPING_BATCH).toBe(50);
  });

  test("LEGAL_BODY_SWEEP_INTERVAL_MS: 30 seconds when unset or blank, a whole number of milliseconds a timer can hold, and anything else refuses boot naming it", () => {
    const BASE = {
      ARC_TESTNET_RPC_URL: "https://rpc.example",
      PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
    };
    expect(DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS).toBe(30_000);
    expect(loadConfig(BASE).legalBodySweepIntervalMs).toBe(30_000);
    for (const blank of ["", "  "])
      expect(
        loadConfig({ ...BASE, LEGAL_BODY_SWEEP_INTERVAL_MS: blank }).legalBodySweepIntervalMs,
      ).toBe(30_000);
    for (const ok of ["1", "45000", "2147483647"])
      expect(
        loadConfig({ ...BASE, LEGAL_BODY_SWEEP_INTERVAL_MS: ok }).legalBodySweepIntervalMs,
      ).toBe(Number(ok));
    for (const bad of ["0", "-30000", "1.5", "soon", "2147483648"])
      expect(() => loadConfig({ ...BASE, LEGAL_BODY_SWEEP_INTERVAL_MS: bad }), bad).toThrow(
        /LEGAL_BODY_SWEEP_INTERVAL_MS/,
      );
  });
});
