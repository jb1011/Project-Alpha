import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { JobRecord } from "../../src/jobs/types";
import { migrate } from "../../src/persistence/db";

const base: JobRecord = {
  jobKey: "t:k",
  jobId: null,
  entityKey: "t:agent",
  ownerTenantId: "0xT",
  status: "pending",
  clientAddress: "0xC",
  evaluatorAddress: "0xE",
  providerAddress: "0xP",
  budgetAmount: "500000",
  description: "d",
  deliverableHash: null,
  deliverablePath: null,
  createTxHash: null,
  fundTxHash: null,
  submitTxHash: null,
  completeTxHash: null,
  sweepTxHash: null,
  reputationTxHash: null,
  error: null,
};

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF"); // unit test: no parent entity fixtures needed
  migrate(db);
  return db;
}

test("upsert + find + tenant scope", () => {
  const db = makeDb();
  const repo = new SqliteJobRepository(db);

  repo.upsert(base);
  expect(repo.findByKey("t:k")?.status).toBe("pending");

  repo.upsert({ ...base, status: "funded" });
  expect(repo.findByKey("t:k")?.status).toBe("funded");

  expect(repo.listByTenant("0xT").length).toBe(1);
  expect(repo.listByTenant("0xOTHER").length).toBe(0);
});

test("listInFlight includes pending/completed but not reputed/failed", () => {
  const db = makeDb();
  const repo = new SqliteJobRepository(db);

  repo.upsert({ ...base, jobKey: "t:pending", status: "pending" });
  repo.upsert({ ...base, jobKey: "t:completed", status: "completed" });
  repo.upsert({ ...base, jobKey: "t:reputed", status: "reputed" });
  repo.upsert({ ...base, jobKey: "t:failed", status: "failed" });

  const inFlight = repo.listInFlight();
  const keys = inFlight.map((r) => r.jobKey);
  expect(keys).toContain("t:pending");
  expect(keys).toContain("t:completed");
  expect(keys).not.toContain("t:reputed");
  expect(keys).not.toContain("t:failed");
});

test("listByEntity returns only matching entity jobs", () => {
  const db = makeDb();
  const repo = new SqliteJobRepository(db);

  repo.upsert({ ...base, jobKey: "t:k1", entityKey: "t:agent" });
  repo.upsert({ ...base, jobKey: "t:k2", entityKey: "t:other-agent" });

  const agentJobs = repo.listByEntity("t:agent");
  expect(agentJobs.length).toBe(1);
  expect(agentJobs[0]?.jobKey).toBe("t:k1");
  expect(repo.listByEntity("t:other-agent").length).toBe(1);
});

test("recordEvent inserts into job_events", () => {
  const db = makeDb();
  const repo = new SqliteJobRepository(db);

  repo.upsert(base);
  repo.recordEvent("t:k", "create", "ok", "0xabc", "detail text");

  const rows = db.prepare("SELECT * FROM job_events WHERE job_key = ?").all("t:k") as {
    step: string;
    status: string;
    tx_hash: string | null;
    detail: string | null;
  }[];
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(row?.step).toBe("create");
  expect(row?.status).toBe("ok");
  expect(row?.tx_hash).toBe("0xabc");
  expect(row?.detail).toBe("detail text");
});

test("transaction rolls back on error", () => {
  const db = makeDb();
  const repo = new SqliteJobRepository(db);

  expect(() => {
    repo.transaction(() => {
      repo.upsert(base);
      throw new Error("rollback");
    });
  }).toThrow("rollback");

  expect(repo.findByKey("t:k")).toBeUndefined();
});
