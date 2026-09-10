import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";

/**
 * `world_usage.paid_attempts` — the second counter on the per-human window (ruling FP-R1).
 *
 * A unit CHARGED in the window (the 402 that quoted a purchase, or a refusal that did the work)
 * is an invoice; `tryConsumePaidAttempt` spends exactly one entitlement against it, which is what
 * bounds the facilitator calls one human can drive per window. The column is additive, so a
 * database that predates it must gain it with every existing row reading 0 — i.e. every human
 * keeps the attempts its already-charged units bought.
 */

const HUMAN = "0xhuman";
const RESOURCE = "https://example.com/x402-demo/quote";
const WINDOW = 60_000;

/** The pre-FP-R1 table, created by hand BEFORE migrate() — a real box's disk. */
function seedLegacyUsageTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE world_usage (
      human_id   TEXT NOT NULL,
      resource   TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (human_id, resource)
    );
  `);
  db.prepare("INSERT INTO world_usage (human_id, resource, used, updated_at) VALUES (?,?,?,?)").run(
    HUMAN,
    RESOURCE,
    2,
    1_000_000,
  );
}

test("the migration is additive and idempotent: legacy rows keep their units and read 0 attempts", () => {
  const db = new Database(":memory:");
  seedLegacyUsageTable(db);
  migrate(db);
  migrate(db); // twice: the ALTER is guarded by PRAGMA table_info, so a re-run is a no-op

  const cols = (db.prepare("PRAGMA table_info(world_usage)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toContain("paid_attempts");
  const row = db
    .prepare("SELECT used, paid_attempts FROM world_usage WHERE human_id = ?")
    .get(HUMAN) as { used: number; paid_attempts: number };
  expect(row).toEqual({ used: 2, paid_attempts: 0 });

  // The two units that row already carries are two invoices nobody has answered yet.
  const store = new SqliteWorldStore(db);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, 1_000_001).allowed).toBe(true);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, 1_000_002).allowed).toBe(true);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, 1_000_003)).toEqual({
    allowed: false,
    paidAttempts: 2,
    unitsCharged: 2,
  });
});

test("no unit charged, no attempt: an unquoted payment finds nothing to answer", () => {
  const db = new Database(":memory:");
  migrate(db);
  const store = new SqliteWorldStore(db);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, 1_000)).toEqual({
    allowed: false,
    paidAttempts: 0,
    unitsCharged: 0,
  });
  // Refused without a write, so hammering cannot even create the row.
  expect(db.prepare("SELECT COUNT(*) AS n FROM world_usage").get()).toEqual({ n: 0 });
});

test("one charge, one attempt — and the charge does not extend its own window", () => {
  const db = new Database(":memory:");
  migrate(db);
  const store = new SqliteWorldStore(db);
  const t0 = 1_000_000;

  expect(store.tryIncrementUsage(HUMAN, RESOURCE, 3, t0, WINDOW).allowed).toBe(true);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, t0 + 10, WINDOW).allowed).toBe(true);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, t0 + 20, WINDOW).allowed).toBe(false);

  // A claim leaves `updated_at` alone: answering an invoice must not push the window out.
  const row = db.prepare("SELECT updated_at FROM world_usage WHERE human_id = ?").get(HUMAN) as {
    updated_at: number;
  };
  expect(row.updated_at).toBe(t0);

  // A second unit charged in the same window is a second invoice.
  expect(store.tryIncrementUsage(HUMAN, RESOURCE, 3, t0 + 30, WINDOW).allowed).toBe(true);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, t0 + 40, WINDOW).allowed).toBe(true);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, t0 + 50, WINDOW).allowed).toBe(false);
});

test("an elapsed window resets BOTH counters — no stale attempts leak into the new one", () => {
  const db = new Database(":memory:");
  migrate(db);
  const store = new SqliteWorldStore(db);
  const t0 = 1_000_000;

  expect(store.tryIncrementUsage(HUMAN, RESOURCE, 2, t0, WINDOW).allowed).toBe(true);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, t0 + 1, WINDOW).allowed).toBe(true);

  // Past the window, before anything is charged in the new one: the old invoice is gone, so a
  // payment that arrives late finds nothing to answer.
  const later = t0 + WINDOW + 1;
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, later, WINDOW)).toEqual({
    allowed: false,
    paidAttempts: 0,
    unitsCharged: 0,
  });

  // The first charge of the new window rewrites both counters, so the spent attempt does not
  // carry over: this human's fresh unit buys a fresh attempt.
  const fresh = store.tryIncrementUsage(HUMAN, RESOURCE, 2, later, WINDOW);
  expect(fresh.used).toBe(1);
  expect(
    (
      db.prepare("SELECT paid_attempts FROM world_usage WHERE human_id = ?").get(HUMAN) as {
        paid_attempts: number;
      }
    ).paid_attempts,
  ).toBe(0);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, later + 1, WINDOW).allowed).toBe(true);
});

test("without a window the counters are lifetime, exactly as the allowance is", () => {
  const db = new Database(":memory:");
  migrate(db);
  const store = new SqliteWorldStore(db);
  expect(store.tryIncrementUsage(HUMAN, RESOURCE, 1, 1_000).allowed).toBe(true);
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, 1_001).allowed).toBe(true);
  // A year later, still the same one invoice and the same one answer to it.
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, 32_000_000_000).allowed).toBe(false);
});

test("attempts are keyed like units are: a separate rate key has its own invoices", () => {
  const db = new Database(":memory:");
  migrate(db);
  const store = new SqliteWorldStore(db);
  const demoKey = `${RESOURCE}#legal-bodies-run`;
  expect(store.tryIncrementUsage(HUMAN, demoKey, 5, 1_000).allowed).toBe(true);
  // The demo's unit cannot be answered on the real wall's key.
  expect(store.tryConsumePaidAttempt(HUMAN, RESOURCE, 1_001).allowed).toBe(false);
  expect(store.tryConsumePaidAttempt(HUMAN, demoKey, 1_002).allowed).toBe(true);
});
