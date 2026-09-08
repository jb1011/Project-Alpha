import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type AgentBookRow,
  SqliteAgentBookRepository,
} from "../../src/persistence/agentBookRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  STALE_AFTER_MS,
  reconcileAgentBook,
  reconcileRow,
} from "../../src/workflow/agentBookReconcile";

let db: Database.Database;
let repo: SqliteAgentBookRepository;
let store: SqliteWorldStore;
const POCKET = "0x2222222222222222222222222222222222222222";
/** The real wall clock: rows are stamped by SQLite milliseconds after this, so a row created in a
 *  test is genuinely fresh against `now: () => T0`. A fixed far-future constant could not be. */
const T0 = Date.now();

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteAgentBookRepository(db);
  store = new SqliteWorldStore(db);
});
afterEach(() => db.close());

function submitted(over: { txHash?: string | null } = {}): AgentBookRow {
  repo.createSession({
    sessionId: "s1",
    entityKey: "agent-1",
    tenantId: "0xT",
    address: POCKET,
    nonce: "5",
    expiresAt: T0 + 300_000,
  });
  // Stored as the route received it from World: zero-padded. `lookupHuman` returns viem's minimal
  // hex for the same number, so the two are equal numerically and unequal as strings.
  repo.claimSubmit("s1", { nullifier: "0x0badf00d", rawTx: "0x02raw", submitterNonce: 9 });
  if (over.txHash) repo.setTxHash("s1", over.txHash);
  return repo.findBySession("s1")!;
}

/** Staleness is measured against the row's own `updated_at`, which SQLite stamps to the second.
 *  Deriving `now` from the row rather than from T0 makes "one millisecond past stale" exact
 *  instead of straddling the threshold by up to a second. */
const rowClock = (row: AgentBookRow) => Date.parse(`${row.updatedAt}Z`);

const registrar = (o: {
  nonce: bigint;
  human?: string | null;
  receipt?: "success" | "reverted" | null;
  chainNonce?: number;
}) => ({
  getNextNonce: vi.fn(async () => o.nonce),
  lookupHuman: vi.fn(async () => o.human ?? null),
  broadcast: vi.fn(async () => "0xrebroadcast" as `0x${string}`),
  receiptStatus: vi.fn(async () => o.receipt ?? null),
  submitterNonce: vi.fn(async () => o.chainNonce ?? 9),
});

test("nonce moved and lookupHuman equals ours -> confirmed, read at safe", async () => {
  const row = submitted({ txHash: "0xh" });
  const r = registrar({ nonce: 6n, human: "0xbadf00d", receipt: "success" });
  const out = await reconcileRow(row, { repo, registrar: r, store, now: () => T0 });
  expect(out.status).toBe("confirmed");
  expect(r.getNextNonce).toHaveBeenCalledWith(POCKET, "safe");
  expect(r.lookupHuman).toHaveBeenCalledWith(POCKET, "safe");
});

test("nonce moved and lookupHuman differs -> disputed, and the foreign id is cached", async () => {
  const row = submitted({ txHash: "0xh" });
  const out = await reconcileRow(row, {
    repo,
    registrar: registrar({ nonce: 6n, human: "0x5714a9e7" }),
    store,
    now: () => T0,
  });
  expect(out.status).toBe("disputed");
  expect(store.getCachedLookup(POCKET, T0, 60_000, 60_000)?.humanId).toBe("0x5714a9e7");
});

test("receipt reverted -> failed immediately", async () => {
  const row = submitted({ txHash: "0xh" });
  const out = await reconcileRow(row, {
    repo,
    registrar: registrar({ nonce: 5n, receipt: "reverted" }),
    store,
    now: () => T0,
  });
  expect(out).toMatchObject({ status: "failed", errorCode: "reverted" });
});

test("nonce unmoved, fresh -> unchanged", async () => {
  const row = submitted({ txHash: "0xh" });
  const r = registrar({ nonce: 5n });
  const out = await reconcileRow(row, { repo, registrar: r, store, now: () => T0 });
  expect(out.status).toBe("submitted");
  expect(r.broadcast).not.toHaveBeenCalled();
  expect(out.txHash).toBe("0xh");
});

test("nonce unmoved, stale, no tx hash, submitter nonce not passed -> re-broadcast the raw tx", async () => {
  const row = submitted({ txHash: null });
  const r = registrar({ nonce: 5n, chainNonce: 9 });
  const out = await reconcileRow(row, {
    repo,
    registrar: r,
    store,
    now: () => rowClock(row) + STALE_AFTER_MS + 1,
  });
  expect(r.broadcast).toHaveBeenCalledWith("0x02raw");
  expect(out.txHash).toBe("0xrebroadcast");
  expect(out.status).toBe("submitted");
});

test("nonce unmoved, stale, submitter nonce passed -> failed as replaced", async () => {
  const row = submitted({ txHash: "0xh" });
  const out = await reconcileRow(row, {
    repo,
    registrar: registrar({ nonce: 5n, chainNonce: 10 }),
    store,
    now: () => rowClock(row) + STALE_AFTER_MS + 1,
  });
  expect(out).toMatchObject({ status: "failed", errorCode: "replaced" });
});

test("a pending session past expiry -> expired", async () => {
  repo.createSession({
    sessionId: "s9",
    entityKey: "agent-1",
    tenantId: "0xT",
    address: POCKET,
    nonce: "1",
    expiresAt: T0 - 1,
  });
  const out = await reconcileRow(repo.findBySession("s9")!, {
    repo,
    registrar: registrar({ nonce: 1n }),
    store,
    now: () => T0,
  });
  expect(out.status).toBe("expired");
});

test("a transport failure leaves the row untouched", async () => {
  const row = submitted({ txHash: "0xh" });
  const r = registrar({ nonce: 5n });
  r.getNextNonce.mockRejectedValueOnce(new Error("rpc down"));
  const out = await reconcileRow(row, { repo, registrar: r, store, now: () => T0 });
  expect(out.status).toBe("submitted");
});

test("the sweep walks every in-flight row and counts the ones it moved", async () => {
  submitted({ txHash: "0xh" });
  repo.createSession({
    sessionId: "s9",
    entityKey: "agent-2",
    tenantId: "0xT",
    address: POCKET,
    nonce: "1",
    expiresAt: T0 - 1,
  });
  const out = await reconcileAgentBook({
    repo,
    registrar: registrar({ nonce: 6n, human: "0xbadf00d" }),
    store,
    now: () => T0,
  });
  expect(out).toEqual({ checked: 2, changed: 2 });
  expect(repo.findBySession("s1")?.status).toBe("confirmed");
  expect(repo.findBySession("s9")?.status).toBe("expired");
});
