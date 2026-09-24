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
  refundTxHash: null,
  escrowState: null,
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

// ── THE ESCROW COLUMNS ────────────────────────────────────────────────────────────────────────
//
// A `failed` row says the saga stopped. It says nothing about the money, and the money is the
// point: a job that funded and then died left its budget in the contract. These two columns are
// the only record of where it went, so they have to survive a round trip, and the query that
// finds the jobs still owed a refund has to be exact about which rows those are.

test("a refund hash and an escrow state round-trip", () => {
  const db = makeDb();
  const repo = new SqliteJobRepository(db);
  const hash = `0x${"ab".repeat(32)}` as const;

  repo.upsert(base);
  // Unknown until somebody reads the chain — which is what a row written before this change is.
  expect(repo.findByKey("t:k")?.refundTxHash).toBe(null);
  expect(repo.findByKey("t:k")?.escrowState).toBe(null);

  repo.upsert({ ...base, status: "failed", escrowState: "refunded", refundTxHash: hash });
  expect(repo.findByKey("t:k")?.refundTxHash).toBe(hash);
  expect(repo.findByKey("t:k")?.escrowState).toBe("refunded");
});

test("an escrow refunded by somebody else is recorded with no hash of ours", () => {
  const db = makeDb();
  const repo = new SqliteJobRepository(db);

  // Anyone may expire a funded job on chain, so the refund can happen without us sending
  // anything. The state is still `refunded`; the hash is not ours to claim.
  repo.upsert({ ...base, status: "failed", escrowState: "refunded", refundTxHash: null });
  expect(repo.findByKey("t:k")?.escrowState).toBe("refunded");
  expect(repo.findByKey("t:k")?.refundTxHash).toBe(null);
});

test("listEscrowedUnrefunded is the failed jobs whose funded escrow is still unaccounted for", () => {
  const db = makeDb();
  const repo = new SqliteJobRepository(db);
  const fund = `0x${"f7".repeat(32)}` as const;

  // Owed: it funded, it died, and nobody has read the chain for it (NULL) …
  repo.upsert({ ...base, jobKey: "t:unknown", status: "failed", fundTxHash: fund });
  // … or the chain was read and the money is still in there.
  repo.upsert({
    ...base,
    jobKey: "t:escrowed",
    status: "failed",
    fundTxHash: fund,
    escrowState: "escrowed",
  });
  // Not owed: never funded, so there is nothing in the contract to get back.
  repo.upsert({ ...base, jobKey: "t:unfunded", status: "failed", fundTxHash: null });
  // Not owed: already refunded, by us or by anyone.
  repo.upsert({
    ...base,
    jobKey: "t:refunded",
    status: "failed",
    fundTxHash: fund,
    escrowState: "refunded",
  });
  // Not owed: the provider was paid — the escrow was released, not lost.
  repo.upsert({
    ...base,
    jobKey: "t:released",
    status: "failed",
    fundTxHash: fund,
    escrowState: "released",
  });
  // Not owed: not a failure at all. A job still working, and a job that finished.
  repo.upsert({ ...base, jobKey: "t:funded", status: "funded", fundTxHash: fund });
  repo.upsert({ ...base, jobKey: "t:reputed", status: "reputed", fundTxHash: fund });

  expect(repo.listEscrowedUnrefunded().map((r) => r.jobKey)).toEqual(["t:unknown", "t:escrowed"]);
});
