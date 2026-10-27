import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";

/**
 * THE PILOT CASES HAVE TABLES OF THEIR OWN.
 *
 * A pilot case is never a `jobs` row: the boot reconciliation and the escrow refund read `jobs`
 * and would act on it. So the two tables are created beside `jobs`, and their CHECKs are the
 * only place the status, mode and Kleros chain lists are enforced by the database itself.
 */

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

const tableNames = (db: Database.Database) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

const tableSql = (db: Database.Database, name: string) =>
  (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as {
      sql: string;
    }
  ).sql;

/** A row with every NOT NULL column filled, and any column overridable. */
function insertCase(db: Database.Database, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    case_id: "pc_000000000001",
    label: "TEST-1",
    mode: "rehearsal",
    status: "created",
    chain_id: 5042002,
    job_contract: "0x00000000000000000000000000000000000000c1",
    buyer_address: "0x00000000000000000000000000000000000000b1",
    buyer_agent_id: "11",
    seller_address: "0x00000000000000000000000000000000000000b2",
    seller_agent_id: "12",
    referee_address: "0x00000000000000000000000000000000000000b3",
    budget_atomic: "1000000",
    description: "a test job",
    expired_at: 1_800_000_000,
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO pilot_cases (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`,
  ).run(row);
}

describe("pilot migration", () => {
  test("migrate creates pilot_cases, pilot_case_events and the status index", () => {
    const db = freshDb();
    expect(tableNames(db)).toContain("pilot_cases");
    expect(tableNames(db)).toContain("pilot_case_events");
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pilot_cases'")
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_pilot_cases_status");
  });

  test("a second migrate is a no-op: same DDL, rows kept, nothing thrown", () => {
    const db = freshDb();
    insertCase(db);
    db.prepare(
      "INSERT INTO pilot_case_events (case_id, step, status, ref, detail) VALUES ('pc_000000000001', 'create', 'ok', '0xaa', NULL)",
    ).run();
    const before = [tableSql(db, "pilot_cases"), tableSql(db, "pilot_case_events")];

    migrate(db);

    expect([tableSql(db, "pilot_cases"), tableSql(db, "pilot_case_events")]).toEqual(before);
    expect(db.prepare("SELECT case_id, status FROM pilot_cases").all()).toEqual([
      { case_id: "pc_000000000001", status: "created" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pilot_case_events").get()).toEqual({ n: 1 });
  });

  test("the status CHECK refuses a status outside the list, simulated included", () => {
    const db = freshDb();
    expect(() => insertCase(db, { status: "simulated" })).toThrow(/CHECK constraint failed/);
    expect(() => insertCase(db, { status: "pending" })).toThrow(/CHECK constraint failed/);
    insertCase(db, { status: "settling" });
  });

  test("the mode CHECK refuses a mode outside rehearsal, testnet, live", () => {
    const db = freshDb();
    expect(() => insertCase(db, { mode: "beta" })).toThrow(/CHECK constraint failed/);
    for (const [i, mode] of ["rehearsal", "testnet", "live"].entries())
      insertCase(db, { case_id: `pc_00000000000${i}`, mode });
  });

  test("the kleros_chain CHECK refuses a chain outside the list, and NULL passes", () => {
    const db = freshDb();
    expect(() => insertCase(db, { kleros_chain: "arbitrum-sepolia" })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertCase(db, { kleros_chain: "ethereum" })).toThrow(/CHECK constraint failed/);
    const chains = [null, "arbitrum-sepolia-testnet", "arbitrum-one", "fake"];
    for (const [i, kleros_chain] of chains.entries())
      insertCase(db, { case_id: `pc_00000000000${i}`, kleros_chain });
  });

  test("an event must name an existing case", () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO pilot_case_events (case_id, step, status) VALUES ('pc_missing', 'create', 'ok')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});
