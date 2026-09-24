import Database from "better-sqlite3";
import { HttpRequestError } from "viem";
import { expect, test } from "vitest";
import { JobFundRevertedError } from "../../src/errors";
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
    refundTxHash: null,
    escrowState: null,
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

/**
 * WHAT THE RUNNER STORES IS SERVED TO STRANGERS.
 *
 * `job.error` is rendered by the API, the MCP tools and the CLI. The runner used to store the raw
 * `e.message` of whatever the saga threw, and the saga's chain calls throw viem diagnostics — which
 * quote back the RPC URL WITH the provider key in its path, the request body and the whole raw
 * signed transaction. That is the exact shape that put a provider key on screen on 2026-09-16, one
 * table along (`workflow/publicError.ts`), and the job funding path reaches it: the allowance read
 * added for the escrow unit is an ordinary contract read, and a throttled or broken endpoint makes
 * it throw one of those.
 */
test("a chain diagnostic never reaches job.error with its credentials intact", async () => {
  const db = makeDb();
  const jobs = new SqliteJobRepository(db);
  const POISONED =
    'HTTP request failed.\nURL: https://rpc.example/v2/SECRETKEY123456\nRequest body: {"method":"eth_call"}\nRaw: 0x02f8720182015785012a05f200850';
  const runJobFn = async () => {
    throw new HttpRequestError({
      body: { method: "eth_call" },
      details: POISONED,
      status: 500,
      url: "https://rpc.example/v2/SECRETKEY123456",
    });
  };
  const runner = new JobRunner({ jobs, runJob: runJobFn });
  const { jobKey } = runner.start({ ...baseParams });
  await runner.settled();

  const stored = jobs.findByKey(jobKey)!;
  expect(stored.status).toBe("failed");
  // The fixture really is poisoned…
  expect(POISONED.includes("SECRETKEY123456")).toBe(true);
  // …and none of it is in the database.
  expect(stored.error!.includes("SECRETKEY123456")).toBe(false);
  expect(stored.error!.includes("rpc.example/v2")).toBe(false);
  expect(stored.error!.includes("0x02f8720182015785012a05f200850")).toBe(false);
  expect(stored.error).toBe("HTTP request failed.");
});

test("a typed failure from the saga is stored word for word", async () => {
  // The other half: the sanitiser must not paraphrase a sentence that was already written for a
  // founder — the escrow failures name their step and their hash, and both have to survive.
  const db = makeDb();
  const jobs = new SqliteJobRepository(db);
  const hash = `0x${"77".repeat(32)}` as const;
  const runJobFn = async () => {
    throw new JobFundRevertedError("fund", hash, 42n);
  };
  const runner = new JobRunner({ jobs, runJob: runJobFn });
  const { jobKey } = runner.start({ ...baseParams });
  await runner.settled();

  expect(jobs.findByKey(jobKey)!.error).toBe(
    `the escrow funding for job 42 failed at the fund step (${hash}): the transaction reverted on chain. The job was not funded and nothing was charged.`,
  );
});
