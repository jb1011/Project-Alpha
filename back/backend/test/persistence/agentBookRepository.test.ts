import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SqliteAgentBookRepository } from "../../src/persistence/agentBookRepository";
import { migrate, openDatabase } from "../../src/persistence/db";

let db: Database.Database;
let repo: SqliteAgentBookRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteAgentBookRepository(db);
});
afterEach(() => db.close());

const session = (over: Partial<Parameters<SqliteAgentBookRepository["createSession"]>[0]> = {}) =>
  repo.createSession({
    sessionId: over.sessionId ?? "s1",
    entityKey: "agent-1",
    tenantId: "0xTenant",
    address: "0x2222222222222222222222222222222222222222",
    nonce: "0",
    expiresAt: Date.now() + 300_000,
    ...over,
  });

test("a session is a pending row and is found by id", () => {
  session();
  expect(repo.findBySession("s1")).toMatchObject({ status: "pending", nonce: "0", attempt: 0 });
});

test("claimSubmit is a CAS: pending -> submitted once, a second claim loses", () => {
  session();
  expect(repo.claimSubmit("s1", { nullifier: "0xabc", rawTx: "0x02aa", submitterNonce: 7 })).toBe(
    "won",
  );
  expect(repo.claimSubmit("s1", { nullifier: "0xabc", rawTx: "0x02aa", submitterNonce: 7 })).toBe(
    "lost",
  );
  expect(repo.findBySession("s1")).toMatchObject({
    status: "submitted",
    nullifier: "0xabc",
    submitterNonce: 7,
  });
});

test("the partial unique index allows ONE in-flight submission per entity", () => {
  session({ sessionId: "s1" });
  session({ sessionId: "s2" });
  expect(repo.claimSubmit("s1", { nullifier: "0x1", rawTx: "0x02", submitterNonce: 1 })).toBe(
    "won",
  );
  expect(repo.claimSubmit("s2", { nullifier: "0x2", rawTx: "0x02", submitterNonce: 2 })).toBe(
    "inflight",
  );
  expect(repo.findBySession("s2")?.status).toBe("pending");
});

test("a confirmed row coexists with a new submitted row (lifetime count sees both)", () => {
  session({ sessionId: "s1" });
  repo.claimSubmit("s1", { nullifier: "0x1", rawTx: "0x02", submitterNonce: 1 });
  expect(repo.transition("s1", "submitted", "confirmed", { confirmedBlock: 100 })).toBe(true);
  session({ sessionId: "s2" });
  expect(repo.claimSubmit("s2", { nullifier: "0x1", rawTx: "0x02", submitterNonce: 2 })).toBe(
    "won",
  );
  expect(repo.countLifetime("agent-1")).toBe(2);
  expect(repo.countConfirmedForTenant("0xTenant")).toBe(1);
  expect(repo.countConfirmedForTenant("0xOther")).toBe(0);
});

test("transition reports whether this caller won", () => {
  session();
  expect(repo.transition("s1", "submitted", "confirmed")).toBe(false);
  expect(repo.transition("s1", "pending", "expired")).toBe(true);
});

test("per-tenant session count is windowed", () => {
  session({ sessionId: "s1" });
  session({ sessionId: "s2" });
  expect(repo.countSessionsSince("0xTenant", Date.now() - 3_600_000)).toBe(2);
  expect(repo.countSessionsSince("0xTenant", Date.now() + 1_000)).toBe(0);
});

test("latestForEntity and listInFlight", () => {
  session({ sessionId: "s1" });
  repo.claimSubmit("s1", { nullifier: "0x1", rawTx: "0x02", submitterNonce: 1 });
  repo.setTxHash("s1", "0xhash");
  expect(repo.latestForEntity("agent-1")).toMatchObject({ sessionId: "s1", txHash: "0xhash" });
  expect(repo.listInFlight().map((r) => r.sessionId)).toEqual(["s1"]);
  repo.bumpAttempt("s1", "InvalidProof");
  expect(repo.findBySession("s1")).toMatchObject({ attempt: 1, errorCode: "InvalidProof" });
});
