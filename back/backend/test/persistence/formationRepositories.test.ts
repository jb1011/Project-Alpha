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
    "company:ent:create_provider:0",
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
  expect(formation.listByState("failed").map((r) => r.companyId)).toEqual(["other"]);
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
  expect(f.listByState("pending").some((r) => r.companyId === "fresh")).toBe(true);
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

// ── PR 3: the anchor cycle's backoff, its open-work query and the veto acknowledgement ──────

test("A-repo-1: listOpen returns every in-flight cycle in ONE statement, ordered", () => {
  anchors.claimVersion("a", 1, "0x01");
  anchors.transition("a", 1, "pending", "executed", { executeTx: "0xe" });
  anchors.claimVersion("a", 2, "0x02");
  anchors.transition("a", 2, "pending", "scheduled", { scheduleTx: "0xs" });
  anchors.claimVersion("b", 4, "0x04");
  anchors.claimVersion("c", 9, "0x09");
  anchors.transition("c", 9, "pending", "vetoed");
  // Executed and vetoed cycles are not open work; the two states that ARE come back together,
  // so a cycle moving from pending to scheduled mid-tick cannot be seen twice or missed.
  expect(anchors.listOpen().map((r) => `${r.entityKey}v${r.version}`)).toEqual(["av2", "bv4"]);
});

test("A-repo-2: the backoff scalars are written together and CLEARED by the next pass", () => {
  anchors.claimVersion("ent", 2, "0x02");
  // Parked WITHOUT burning an attempt — a transport failure says nothing about whether the
  // amendment is going through, so it must never count toward abandonment.
  anchors.transition("ent", 2, "pending", "pending", {
    error: "rpc timeout",
    nextRetryAt: 1_800_000_000_000,
    retryIntervalMs: 120_000,
  });
  let row = anchors.find("ent", 2)!;
  expect(row.attempt).toBe(0);
  expect(row.nextRetryAt).toBe(1_800_000_000_000);
  expect(row.retryIntervalMs).toBe(120_000);
  // The success that follows must be able to clear it: an un-clearable schedule would keep a
  // healthy cycle parked forever. (Deliberately NOT coalesced, unlike the tx hashes.)
  anchors.transition("ent", 2, "pending", "scheduled", { scheduleTx: "0xs", error: null });
  row = anchors.find("ent", 2)!;
  expect(row.nextRetryAt).toBeNull();
  expect(row.retryIntervalMs).toBeNull();
  expect(row.error).toBeNull();
  expect(row.scheduleTx).toBe("0xs");
});

test("A-repo-3: acknowledgeHold is a CAS from the two HOLD states and nothing else", () => {
  anchors.claimVersion("ent", 3, "0x03");
  anchors.transition("ent", 3, "pending", "scheduled", { scheduleTx: "0xs" });
  // A scheduled cycle is not something an operator may wave through — only a held one.
  expect(anchors.acknowledgeHold("ent", 3)).toBe(false);
  anchors.transition("ent", 3, "scheduled", "vetoed");
  expect(anchors.acknowledgeHold("ent", 3)).toBe(true);
  const row = anchors.find("ent", 3)!;
  expect(row.state).toBe("superseded");
  expect(row.error).toMatch(/hold acknowledged by an operator/);
  // Idempotent by construction: the second ack has nothing to move.
  expect(anchors.acknowledgeHold("ent", 3)).toBe(false);

  // The other hold: a cycle whose scheduled manifest no longer re-hashes to its anchor.
  anchors.claimVersion("ent", 4, "0x04");
  anchors.transition("ent", 4, "pending", "failed", { error: "rehash mismatch" });
  expect(anchors.acknowledgeHold("ent", 4)).toBe(true);
  expect(anchors.find("ent", 4)?.state).toBe("superseded");
});

// ── 2026-08-26 §3: the anchor scheduler under N:1 ──────────────────────────────────────────

/** An entity attached to `companyId`, with a company row to attach to. */
function attach(entityKey: string, companyId: string): void {
  if (!db.prepare("SELECT 1 FROM companies WHERE company_id = ?").get(companyId))
    db.prepare(
      `INSERT INTO companies (company_id, tenant_id, status, provider, environment,
                              name_options, business_purpose, industry_label)
       VALUES (?, 't', 'ready', 'doola', 'sandbox', '[]', 'p', 'i')`,
    ).run(companyId);
  db.prepare(
    `INSERT INTO entities (idempotency_key, name, status, manager, guardian, amendment_delay,
                           ein, formation_date, company_id)
     VALUES (?, ?, 'bound', '0x1', '0x2', '86400', 'STUB', 0, ?)`,
  ).run(entityKey, entityKey, companyId);
}

test("a POLL does not move facts_updated_at — and so does not invalidate the anchor gate", () => {
  formation.claimStep("c1", "await_ein");
  const before = formation.find("c1", "await_ein")!;
  // What `persistPollBackoff` writes on EVERY pass over a waiting row: a schedule, in `detail`.
  formation.transition("c1", "await_ein", "pending", "pending", {
    detail: JSON.stringify({ nextPollAt: 1 }),
    nextPollAt: 1,
    touchFacts: false,
  });
  const polled = formation.find("c1", "await_ein")!;
  expect(polled.detail).toContain("nextPollAt");
  // The FACT clock did not move. An `await_ein` row waits four to six weeks for the IRS, and
  // bumping this on every poll made its entity re-read and re-hash its manifest on every tick.
  expect(polled.factsUpdatedAt).toBe(before.factsUpdatedAt);

  // …while a real transition does move it.
  formation.transition("c1", "await_ein", "pending", "confirmed");
  expect(formation.find("c1", "await_ein")!.state).toBe("confirmed");
});

test("an ATTEMPT BUMP is not a fact — it must not hold the entity in the anchor due-set", () => {
  formation.claimStep("c1", "create_provider");
  // Stamped in the past explicitly: both columns are CURRENT_TIMESTAMP at one-SECOND resolution,
  // so "unchanged" is only a real assertion against a value the clock cannot reproduce.
  const OLD = "2026-01-01 00:00:00";
  db.prepare("UPDATE formation_requests SET facts_updated_at = ? WHERE company_id = 'c1'").run(OLD);

  formation.transition("c1", "create_provider", "pending", "failed", {
    error: "doola 503",
    touchFacts: false,
  });
  expect(formation.find("c1", "create_provider")!.factsUpdatedAt).toBe(OLD);

  // The bump rotates an IDEMPOTENCY KEY. It says nothing about the world, and a step that fails
  // every tick would otherwise keep re-deriving and re-hashing a manifest that has not changed.
  expect(formation.bumpAttempt("c1", "create_provider", "failed")).toBe(1);
  expect(formation.find("c1", "create_provider")!.factsUpdatedAt).toBe(OLD);

  // …and a real state change still moves it.
  formation.transition("c1", "create_provider", "pending", "confirmed");
  expect(formation.find("c1", "create_provider")!.factsUpdatedAt).not.toBe(OLD);
});

test("the anchor due-set DEDUPES the facts arm per COMPANY, then expands after the limit", () => {
  // Ten agents on ONE company, and one agent on another. A page of one must not be all ten.
  for (let i = 0; i < 10; i++) attach(`busy-${i}`, "company-busy");
  attach("quiet-1", "company-quiet");
  for (const c of ["company-busy", "company-quiet"]) {
    formation.claimStep(c, "await_filing");
    formation.transition(c, "await_filing", "pending", "confirmed");
  }

  // ONE row of the pre-expansion page = ONE company, expanded to its ten agents afterwards.
  const first = anchors.listDue(1);
  expect(first.entityKeys).toHaveLength(10);
  expect(new Set(first.entityKeys.map((k) => k.split("-")[0]))).toEqual(new Set(["busy"]));
  // …and the cursor is what lets the OTHER company be reached at all.
  expect(first.nextCursor).toBe("company-busy");
  const second = anchors.listDue(1, first.nextCursor!);
  expect(second.entityKeys).toEqual(["quiet-1"]);
});

test("the cursor WRAPS: a short page reports null, and the next sweep starts over", () => {
  attach("a-1", "company-a");
  attach("b-1", "company-b");
  for (const c of ["company-a", "company-b"]) {
    formation.claimStep(c, "await_filing");
    formation.transition(c, "await_filing", "pending", "confirmed");
  }
  const page = anchors.listDue(50);
  expect(page.entityKeys.sort()).toEqual(["a-1", "b-1"]);
  // Fewer rows than the limit means the end of the set — the caller wraps rather than paging on.
  expect(page.nextCursor).toBeNull();
});

test("no key starves: a permanently HELD cycle does not occupy a slot forever", () => {
  // The starvation shape: a held cycle sorts first and would be re-read on every tick.
  attach("aaa-held", "company-held");
  anchors.claimVersion("aaa-held", 2, "0x02");
  anchors.transition("aaa-held", 2, "pending", "vetoed");
  attach("zzz-due", "company-due");
  formation.claimStep("company-due", "await_filing");
  formation.transition("company-due", "await_filing", "pending", "confirmed");

  const first = anchors.listDue(1);
  expect(first.entityKeys).toEqual(["aaa-held"]);
  // The cursor is what makes the second tick see the OTHER one rather than the same held cycle.
  const second = anchors.listDue(1, first.nextCursor!);
  expect(second.entityKeys).toEqual(["zzz-due"]);
});
