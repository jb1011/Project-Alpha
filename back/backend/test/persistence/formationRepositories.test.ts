/**
 * The two formation sub-saga repositories (design §3/§7). The keystone property both share:
 * every state move is a COMPARE-AND-SET, so when two drivers meet on one row exactly one wins.
 * The sweeper is the first unattended periodic driver in this codebase and `withKeyedLock` is
 * single-process by its own doc — correctness has to be DB-level (audit M13/20).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteOaAnchorRepository } from "../../src/persistence/oaAnchorRepository";

let db: Database.Database;
let formation: SqliteFormationRepository;
let anchors: SqliteOaAnchorRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  formation = new SqliteFormationRepository(db);
  anchors = new SqliteOaAnchorRepository(db);
});
afterEach(() => db.close());

// ── formation_requests ────────────────────────────────────────────────────────────────────

test("claimStep is a claim, not an upsert: the second caller loses and nothing is overwritten", () => {
  expect(formation.claimStep("ent", "create_provider")).toBe(true);
  formation.transition("ent", "create_provider", "pending", "submitted", { providerRef: "cmp_1" });
  expect(formation.claimStep("ent", "create_provider")).toBe(false);
  const row = formation.find("ent", "create_provider");
  expect(row?.state).toBe("submitted");
  expect(row?.providerRef).toBe("cmp_1"); // a losing claim must not reset the row to pending
});

test("transition is compare-and-set: exactly ONE of two concurrent drivers moves the row", () => {
  formation.claimStep("ent", "await_filing");
  const first = formation.transition("ent", "await_filing", "pending", "confirmed");
  const second = formation.transition("ent", "await_filing", "pending", "confirmed");
  expect([first, second]).toEqual([true, false]);
  expect(formation.find("ent", "await_filing")?.state).toBe("confirmed");
});

test("a transition from the WRONG state is refused (no side effect may follow a false)", () => {
  formation.claimStep("ent", "await_ein");
  expect(formation.transition("ent", "await_ein", "submitted", "confirmed")).toBe(false);
  expect(formation.find("ent", "await_ein")?.state).toBe("pending");
});

test("optional fields are COALESCEd — a later transition never wipes an earned provider_ref", () => {
  formation.claimStep("ent", "create_provider");
  formation.transition("ent", "create_provider", "pending", "submitted", {
    providerRef: "cmp_42",
    detail: JSON.stringify({ customerId: "cus_1" }),
  });
  formation.transition("ent", "create_provider", "submitted", "confirmed");
  const row = formation.find("ent", "create_provider");
  expect(row?.providerRef).toBe("cmp_42");
  expect(row?.detail).toBe(JSON.stringify({ customerId: "cus_1" }));
});

test("a success transition CLEARS a previous error (a healthy step must not report a stale one)", () => {
  formation.claimStep("ent", "create_provider");
  formation.transition("ent", "create_provider", "pending", "failed", { error: "doola 503" });
  expect(formation.find("ent", "create_provider")?.error).toBe("doola 503");
  const attempt = formation.bumpAttempt("ent", "create_provider", "failed");
  expect(attempt).toBe(1);
  formation.transition("ent", "create_provider", "pending", "confirmed");
  expect(formation.find("ent", "create_provider")?.error).toBeNull();
});

test("bumpAttempt is CAS-guarded and drives a FRESH idempotency key per attempt", () => {
  formation.claimStep("ent", "create_provider");
  formation.transition("ent", "create_provider", "pending", "failed", { error: "boom" });
  expect(formation.bumpAttempt("ent", "create_provider", "failed")).toBe(1);
  // The second (concurrent) bump sees state='pending', not 'failed' -> loses, so attempts are
  // never double-counted and no attempt number is skipped.
  expect(formation.bumpAttempt("ent", "create_provider", "failed")).toBeUndefined();
  expect(formation.find("ent", "create_provider")?.attempt).toBe(1);
  // Keys must differ per attempt: doola RELEASES a failed create's key, and reuse-with-a-
  // different-body comes back 409 E_IDEMPOTENCY_KEY_REUSED.
  expect(SqliteFormationRepository.idempotencyKey("ent", "create_provider", 0)).toBe(
    "formation:ent:create_provider:0",
  );
  expect(SqliteFormationRepository.idempotencyKey("ent", "create_provider", 1)).not.toBe(
    SqliteFormationRepository.idempotencyKey("ent", "create_provider", 0),
  );
});

test("stepsOf returns saga order; listByState is the sweeper's due-work query", () => {
  for (const s of ["await_ein", "create_provider", "fetch_documents"] as const)
    formation.claimStep("ent", s);
  expect(formation.stepsOf("ent").map((r) => r.step)).toEqual([
    "create_provider",
    "fetch_documents",
    "await_ein",
  ]);
  formation.claimStep("other", "create_provider");
  formation.transition("other", "create_provider", "pending", "failed", { error: "x" });
  expect(formation.listByState("failed").map((r) => r.entityKey)).toEqual(["other"]);
});

// ── oa_anchors ────────────────────────────────────────────────────────────────────────────

test("claimVersion adopts an existing cycle instead of restarting it with a different hash", () => {
  expect(anchors.claimVersion("ent", 2, "0xaa")).toBe(true);
  expect(anchors.claimVersion("ent", 2, "0xbb")).toBe(false);
  expect(anchors.find("ent", 2)?.manifestHash).toBe("0xaa");
});

test("two versions of one entity coexist; findPending returns the newest open cycle", () => {
  anchors.claimVersion("ent", 1, "0x01");
  anchors.transition("ent", 1, "pending", "executed", { executeTx: "0xexec1" });
  anchors.claimVersion("ent", 2, "0x02");
  expect(anchors.versionsOf("ent").map((r) => r.version)).toEqual([1, 2]);
  expect(anchors.findPending("ent")?.version).toBe(2);
  // An executed/superseded cycle is not "pending" for the single-pending rule.
  anchors.transition("ent", 2, "pending", "superseded");
  expect(anchors.findPending("ent")).toBeUndefined();
});

test("anchor transition is compare-and-set: the due-anchor executes exactly once", () => {
  anchors.claimVersion("ent", 1, "0x01");
  anchors.transition("ent", 1, "pending", "scheduled", {
    scheduleTx: "0xsched",
    executableAt: 1_800_000_000,
  });
  const a = anchors.transition("ent", 1, "scheduled", "executed", { executeTx: "0xexec" });
  const b = anchors.transition("ent", 1, "scheduled", "executed", { executeTx: "0xother" });
  expect([a, b]).toEqual([true, false]);
  const row = anchors.find("ent", 1)!;
  expect(row.state).toBe("executed");
  expect(row.executeTx).toBe("0xexec");
  // The schedule tx SURVIVES the execute transition — a crash resumes by adopting a persisted
  // broadcast, so losing it would mean re-broadcasting a tx that is already in flight.
  expect(row.scheduleTx).toBe("0xsched");
  expect(row.executableAt).toBe(1_800_000_000);
});

test("a vetoed row cannot be moved on by a from='scheduled' driver (the veto is a stop sign)", () => {
  anchors.claimVersion("ent", 3, "0x03");
  anchors.transition("ent", 3, "pending", "scheduled", { scheduleTx: "0xs" });
  expect(anchors.transition("ent", 3, "scheduled", "vetoed")).toBe(true);
  expect(anchors.transition("ent", 3, "scheduled", "executed", { executeTx: "0xe" })).toBe(false);
  expect(anchors.find("ent", 3)?.state).toBe("vetoed");
});

test("anchor bumpAttempt is CAS-guarded like its formation twin", () => {
  anchors.claimVersion("ent", 1, "0x01");
  anchors.transition("ent", 1, "pending", "failed", { error: "rpc timeout" });
  expect(anchors.bumpAttempt("ent", 1, "failed")).toBe(1);
  expect(anchors.bumpAttempt("ent", 1, "failed")).toBeUndefined();
  expect(anchors.find("ent", 1)?.attempt).toBe(1);
  expect(anchors.listByState("pending").map((r) => r.version)).toEqual([1]);
});

// ── H: one statement per bump, statements prepared once ─────────────────────────────────────

test("H1: bumpAttempt returns the number THIS update wrote, not a later read-back", () => {
  // The old UPDATE-then-SELECT could read a value another driver bumped in between and hand the
  // caller an attempt number it does not own — and that number IS the idempotency key doola's
  // create endpoints honor, so the two drivers would collide on one key with different bodies.
  // Simulated here by interleaving a second bump between the first caller's update and any
  // read-back it might have done: with UPDATE … RETURNING there is no gap to interleave into.
  formation.claimStep("ent", "await_ein");
  formation.transition("ent", "await_ein", "pending", "failed", { error: "irs" });
  const first = formation.bumpAttempt("ent", "await_ein", "failed");
  expect(first).toBe(1);
  // A concurrent driver now bumps again from the state THIS one left behind.
  formation.transition("ent", "await_ein", "pending", "failed", { error: "irs again" });
  const second = formation.bumpAttempt("ent", "await_ein", "failed");
  expect(second).toBe(2);
  // Each caller kept its own number; neither observed the other's.
  expect(first).not.toBe(second);
  expect(SqliteFormationRepository.idempotencyKey("ent", "await_ein", first!)).not.toBe(
    SqliteFormationRepository.idempotencyKey("ent", "await_ein", second!),
  );
});

test("H1: the anchor twin returns its own attempt number the same way", () => {
  anchors.claimVersion("ent", 7, "0x07");
  anchors.transition("ent", 7, "pending", "failed", { error: "rpc" });
  expect(anchors.bumpAttempt("ent", 7, "failed")).toBe(1);
  anchors.transition("ent", 7, "pending", "failed", { error: "rpc" });
  expect(anchors.bumpAttempt("ent", 7, "failed")).toBe(2);
  expect(anchors.find("ent", 7)?.attempt).toBe(2);
  // A lost race still returns undefined — the CAS is unchanged by the single-statement rewrite.
  expect(anchors.bumpAttempt("ent", 7, "failed")).toBeUndefined();
});

test("H2: statements are prepared once — a repo built on a fresh db serves every method", () => {
  // Constructor-time preparation means the tables must exist when the repo is built (they do:
  // `migrate(db)` runs first at every composition root). Pin that a freshly-built pair works
  // end to end, so a future statement added to the constructor cannot silently break boot.
  const f = new SqliteFormationRepository(db);
  const a = new SqliteOaAnchorRepository(db);
  expect(f.claimStep("fresh", "create_provider")).toBe(true);
  expect(f.find("fresh", "create_provider")?.state).toBe("pending");
  expect(f.stepsOf("fresh").map((r) => r.step)).toEqual(["create_provider"]);
  expect(f.listByState("pending").some((r) => r.entityKey === "fresh")).toBe(true);
  expect(f.transition("fresh", "create_provider", "pending", "failed", { error: "x" })).toBe(true);
  expect(f.bumpAttempt("fresh", "create_provider", "failed")).toBe(1);
  expect(a.claimVersion("fresh", 1, "0xaa")).toBe(true);
  expect(a.find("fresh", 1)?.manifestHash).toBe("0xaa");
  expect(a.versionsOf("fresh").map((r) => r.version)).toEqual([1]);
  expect(a.findPending("fresh")?.version).toBe(1);
  expect(a.listByState("pending").some((r) => r.entityKey === "fresh")).toBe(true);
  expect(a.transition("fresh", 1, "pending", "failed", { error: "y" })).toBe(true);
  expect(a.bumpAttempt("fresh", 1, "failed")).toBe(1);
});
