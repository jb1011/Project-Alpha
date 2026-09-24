import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";

describe("jobs migration", () => {
  test("migrate creates jobs and job_events tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toContain("jobs");
    expect(names).toContain("job_events");
  });
});

/**
 * THE ESCROW COLUMNS ARRIVE ON A DATABASE THAT ALREADY HAS JOBS IN IT.
 *
 * The box's `jobs` table holds the rows this feature exists for: the failed jobs whose budget is
 * still in the contract. So the two new columns have to reach it the way every other column in
 * this schema reached it — `ALTER TABLE … ADD COLUMN` behind a `PRAGMA table_info` guard, with
 * the existing rows untouched and the status CHECK list exactly as it was. Rebuilding the table
 * to add them would mean dropping and recreating the one table nothing may be lost from.
 *
 * `PRE_ESCROW_JOBS_DDL` is the shape as it stood before this change, frozen. It must never be
 * "kept in sync" with `db.ts`: if it drifts, the fixture stops proving anything.
 */
const PRE_ESCROW_JOBS_DDL = `
  CREATE TABLE jobs (
    job_key TEXT PRIMARY KEY,
    job_id TEXT,
    entity_key TEXT NOT NULL,
    owner_tenant_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','created','funded','submitted','completed','reputed','failed')),
    client_address TEXT NOT NULL,
    evaluator_address TEXT NOT NULL,
    provider_address TEXT NOT NULL,
    budget_amount TEXT NOT NULL,
    description TEXT NOT NULL,
    deliverable_hash TEXT, deliverable_path TEXT,
    create_tx_hash TEXT, fund_tx_hash TEXT, submit_tx_hash TEXT, complete_tx_hash TEXT, sweep_tx_hash TEXT, reputation_tx_hash TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

function legacyJobsDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(PRE_ESCROW_JOBS_DDL);
  db.prepare(`
    INSERT INTO jobs (
      job_key, job_id, entity_key, owner_tenant_id, status,
      client_address, evaluator_address, provider_address,
      budget_amount, description, fund_tx_hash, error
    ) VALUES ('t:old', '7', 't:agent', '0xT', 'failed', '0xC', '0xE', '0xP', '500000', 'd', '0xf7', 'died at submit')
  `).run();
  return db;
}

const jobColumns = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);

describe("jobs escrow columns", () => {
  test("a fresh database has refund_tx_hash and escrow_state", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(jobColumns(db)).toContain("refund_tx_hash");
    expect(jobColumns(db)).toContain("escrow_state");
  });

  test("an existing jobs table gains the two columns and keeps its rows", () => {
    const db = legacyJobsDb();
    expect(jobColumns(db)).not.toContain("refund_tx_hash");

    migrate(db);

    expect(jobColumns(db)).toContain("refund_tx_hash");
    expect(jobColumns(db)).toContain("escrow_state");
    // The row that was there before is still there, with its facts, and NULL for what nobody has
    // decided yet: a job written before this change has an escrow whose whereabouts are unknown.
    expect(
      db
        .prepare(
          "SELECT job_key, status, fund_tx_hash, error, refund_tx_hash, escrow_state FROM jobs",
        )
        .all(),
    ).toEqual([
      {
        job_key: "t:old",
        status: "failed",
        fund_tx_hash: "0xf7",
        error: "died at submit",
        refund_tx_hash: null,
        escrow_state: null,
      },
    ]);
  });

  test("the status CHECK list is untouched, and migrate is idempotent", () => {
    const db = legacyJobsDb();
    migrate(db);
    migrate(db); // the guard means a second run adds nothing and throws nothing
    const ddl = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get() as {
        sql: string;
      }
    ).sql;
    expect(ddl).toContain(
      "CHECK (status IN ('pending','created','funded','submitted','completed','reputed','failed'))",
    );
    expect(jobColumns(db).filter((c) => c === "escrow_state")).toEqual(["escrow_state"]);
  });
});
