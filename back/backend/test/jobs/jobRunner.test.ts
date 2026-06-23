import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { JobRunner } from "../../src/jobs/jobRunner";
import { migrate } from "../../src/persistence/db";

const baseParams = {
  jobKey: "t:k",
  entityKey: "t:agent",
  tenantId: "0xT",
  budget: 1n,
  description: "d",
  clientAddress: "0xC",
  evaluatorAddress: "0xE",
  providerAddress: "0xP",
} as const;

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  migrate(db);
  return db;
}

test("start runs the saga and reaches a terminal status", async () => {
  const db = makeDb();
  const jobs = new SqliteJobRepository(db);
  const runJobFn = async (i: { jobKey: string }) => {
    const r = jobs.findByKey(i.jobKey)!;
    const done = { ...r, status: "reputed" as const };
    jobs.upsert(done);
    return done;
  };
  const runner = new JobRunner({ jobs, runJob: runJobFn });
  const { jobKey } = runner.start({ ...baseParams });
  await runner.settled();
  expect(jobs.findByKey(jobKey)?.status).toBe("reputed");
});

test("start with duplicate jobKey throws 409", async () => {
  const db = makeDb();
  const jobs = new SqliteJobRepository(db);
  const runJobFn = async (i: { jobKey: string }) => {
    const r = jobs.findByKey(i.jobKey)!;
    const done = { ...r, status: "reputed" as const };
    jobs.upsert(done);
    return done;
  };
  const runner = new JobRunner({ jobs, runJob: runJobFn });
  runner.start({ ...baseParams });
  await runner.settled();
  // Now the record exists in DB — second start should throw 409
  expect(() => runner.start({ ...baseParams })).toThrow();
  try {
    runner.start({ ...baseParams });
  } catch (e: unknown) {
    expect((e as { status: number }).status).toBe(409);
  }
});

test("failed runJob results in status failed", async () => {
  const db = makeDb();
  const jobs = new SqliteJobRepository(db);
  const runJobFn = async (_i: { jobKey: string }) => {
    throw new Error("saga blew up");
  };
  const runner = new JobRunner({ jobs, runJob: runJobFn });
  runner.start({ ...baseParams });
  await runner.settled();
  expect(jobs.findByKey(baseParams.jobKey)?.status).toBe("failed");
  expect(jobs.findByKey(baseParams.jobKey)?.error).toBe("saga blew up");
});

test("a completed job is not clobbered to failed on a late throw", async () => {
  const db = makeDb();
  const jobs = new SqliteJobRepository(db);
  const runJobFn = async (i: { jobKey: string }) => {
    // Simulate: saga reaches `completed` (irreversible settlement), then throws afterwards
    const r = jobs.findByKey(i.jobKey)!;
    jobs.upsert({ ...r, status: "completed" });
    throw new Error("post-settlement boom");
  };
  const runner = new JobRunner({ jobs, runJob: runJobFn });
  runner.start({ ...baseParams });
  await runner.settled();
  // MUST remain `completed` — not overwritten to `failed`
  expect(jobs.findByKey(baseParams.jobKey)?.status).toBe("completed");
});

test("reconcileInFlight resumes non-terminal records", async () => {
  const db = makeDb();
  const jobs = new SqliteJobRepository(db);

  // Pre-seed a "created" (in-flight) record as if the server crashed mid-saga
  jobs.upsert({
    jobKey: "t:resume",
    jobId: null,
    entityKey: "t:agent",
    ownerTenantId: "0xT",
    status: "created",
    clientAddress: "0xC",
    evaluatorAddress: "0xE",
    providerAddress: "0xP",
    budgetAmount: "1",
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
  });

  const runJobFn = async (i: { jobKey: string }) => {
    const r = jobs.findByKey(i.jobKey)!;
    const done = { ...r, status: "reputed" as const };
    jobs.upsert(done);
    return done;
  };
  const runner = new JobRunner({ jobs, runJob: runJobFn });
  const count = runner.reconcileInFlight();
  await runner.settled();
  expect(count).toBe(1);
  expect(jobs.findByKey("t:resume")?.status).toBe("reputed");
});
