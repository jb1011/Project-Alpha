import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { runJob } from "../../src/jobs/runJob";
import { migrate } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { makeRunJobDeps, seedBoundEntity } from "../helpers/runJobDeps";

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF"); // no parent fixtures needed in unit tests
  migrate(db);
  return db;
}

describe("runJob saga — steps 0–2", () => {
  test("create → fund advances to funded and setBudget goes through providerOpsFor", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");

    const setBudget = vi.fn().mockResolvedValue(`0x${"bb".repeat(32)}` as `0x${string}`);

    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k",
      entityKey: "t:agent",
      budget: 500_000n,
    });

    // Spy on the provider ops seam — the saga must route the provider-signed step through it
    // (custody dispatch happens in composition, behind this seam).
    const providerOpsFor = vi.fn((_entity, _jobKey) => ({
      setBudget,
      submit: vi.fn(),
      sweepToTreasury: vi.fn(),
    }));
    deps.providerOpsFor = providerOpsFor;

    // Stub the worker so it throws after fund, stopping the saga before submit
    deps.worker.produceDeliverable = vi.fn().mockRejectedValueOnce(new Error("stop after fund"));

    await expect(runJob(deps)).rejects.toThrow("stop after fund");

    // Steps 0–2 must have completed and the record must be persisted as "funded"
    expect(jobs.findByKey("t:k")?.status).toBe("funded");

    // setBudget must have gone through the provider ops for THIS entity + job
    expect(providerOpsFor).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "t:agent" }),
      "t:k",
    );
    expect(setBudget).toHaveBeenCalledWith(0n, 500_000n);
  });

  test("missing entity throws a clear error", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    // Do NOT seed the entity

    const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:k2", entityKey: "t:missing" });
    await expect(runJob(deps)).rejects.toThrow(/t:missing/);
  });

  test("entity without operator throws a clear error", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    entities.upsert({
      idempotencyKey: "t:no-op",
      name: "No Operator LLC",
      status: "bound",
      manager: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      guardian: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      operator: null,
      amendmentDelay: "0",
      ein: "12-3456789",
      formationDate: 1_700_000_000,
      oaHash: null,
      metadataURI: null,
      docPath: null,
      treasuryConfig: null,
      agentId: null,
      proxy: null,
      treasury: null,
      createTxHash: null,
      bindTxHash: null,
      fundTxHash: null,
      turnkeySubOrgId: undefined,
      error: null,
      specJson: null,
    });

    const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:k3", entityKey: "t:no-op" });
    await expect(runJob(deps)).rejects.toThrow(/fully-onboarded agent/);
  });

  test("entity with operator+subOrgId but null agentId throws before any on-chain spend", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    entities.upsert({
      idempotencyKey: "t:no-agentid",
      name: "No AgentId LLC",
      status: "bound",
      manager: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      guardian: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      operator: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      amendmentDelay: "0",
      ein: "12-3456789",
      formationDate: 1_700_000_000,
      oaHash: null,
      metadataURI: null,
      docPath: null,
      treasuryConfig: null,
      agentId: null,
      proxy: null,
      treasury: null,
      createTxHash: null,
      bindTxHash: null,
      fundTxHash: null,
      turnkeySubOrgId: "test-sub-org-id",
      error: null,
      specJson: null,
    });

    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k-naid",
      entityKey: "t:no-agentid",
    });
    // Spy to confirm createJob was NOT called (guard must fire before Step 1)
    const createJobSpy = vi.fn();
    deps.job.createJob = createJobSpy;

    // Provider-agnostic guard message (Tier-0): operator/agentId are required on BOTH custody
    // paths; the sub-org requirement moved into the provider-aware branch.
    await expect(runJob(deps)).rejects.toThrow(/fully-onboarded agent.*missing operator\/agentId/);
    expect(createJobSpy).not.toHaveBeenCalled();
  });

  test("entity with wrong status (pending) throws a clear error", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    const entity = seedBoundEntity(entities, "t:pending-agent");

    // Override the entity status to "pending" (not a runnable state)
    entities.upsert({ ...entity, status: "pending" });

    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k5",
      entityKey: "t:pending-agent",
    });
    await expect(runJob(deps)).rejects.toThrow(/not a bound agent/);
  });

  test("funded → submitted → completed (full fakes)", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");
    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k",
      entityKey: "t:agent",
      budget: 500_000n,
    });
    await runJob(deps);
    const r = jobs.findByKey("t:k")!;
    expect(["completed", "reputed"]).toContain(r.status);
    expect(r.submitTxHash).toBeTruthy();
    expect(r.completeTxHash).toBeTruthy();
    expect(r.deliverableHash).toBeTruthy();
  });

  // ── Task 6.3 tests ──────────────────────────────────────────────────────────

  test("reputation failure leaves job at completed (retryable), not failed", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");
    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k",
      entityKey: "t:agent",
      budget: 500_000n,
    });
    deps.reputation.record = async () => {
      throw new Error("rep down");
    };
    await runJob(deps); // MUST NOT throw
    const r = jobs.findByKey("t:k")!;
    expect(r.status).toBe("completed");
    expect(r.error).toContain("rep down");
  });

  test("reputation success advances to reputed", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");
    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k",
      entityKey: "t:agent",
      budget: 500_000n,
    });
    await runJob(deps);
    expect(jobs.findByKey("t:k")?.status).toBe("reputed");
  });

  test("sweep: sweepToTreasury=true records sweepTxHash and a sweep event, uses balance minus reserve", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");
    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:sweep",
      entityKey: "t:agent",
      budget: 500_000n,
      sweepToTreasury: true,
    });

    // The FakeJobAdapter.usdcBalanceOf returns 500_000n by default.
    // SWEEP_GAS_RESERVE = 10_000n → sweepAmount should be 490_000n.
    const SWEEP_GAS_RESERVE = 10_000n;
    const FAKE_BALANCE = 500_000n;
    const expectedSweepAmount = FAKE_BALANCE - SWEEP_GAS_RESERVE; // 490_000n

    let capturedSweepAmount: bigint | undefined;
    const origTransferUsdc = deps.job.transferUsdc.bind(deps.job);
    deps.job.transferUsdc = async (wallet, usdc, to, amount) => {
      capturedSweepAmount = amount;
      return origTransferUsdc(wallet, usdc, to, amount);
    };

    await runJob(deps);
    const r = jobs.findByKey("t:sweep")!;
    expect(r.sweepTxHash).toBeTruthy();
    expect(capturedSweepAmount).toBe(expectedSweepAmount);
    // Query job_events directly from the SQLite db
    const sweepEvents = db
      .prepare("SELECT * FROM job_events WHERE job_key = ? AND step = 'sweep'")
      .all("t:sweep");
    expect(sweepEvents.length).toBeGreaterThan(0);
  });

  test("sweep: sweepToTreasury=false leaves sweepTxHash null", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");
    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:nosweep",
      entityKey: "t:agent",
      budget: 500_000n,
      sweepToTreasury: false,
    });
    await runJob(deps);
    const r = jobs.findByKey("t:nosweep")!;
    expect(r.sweepTxHash).toBeNull();
  });

  test("sweep failure does not throw and does not block reputation", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");
    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:sweepfail",
      entityKey: "t:agent",
      budget: 500_000n,
      sweepToTreasury: true,
    });
    // Force the sweep to fail
    deps.job.transferUsdc = async () => {
      throw new Error("sweep boom");
    };
    // MUST NOT throw — sweep is best-effort
    await runJob(deps);
    const r = jobs.findByKey("t:sweepfail")!;
    // Reputation still ran — job advanced to "reputed"
    expect(r.status).toBe("reputed");
    // No sweep tx recorded
    expect(r.sweepTxHash).toBeFalsy();
  });

  test("idempotent re-run from funded skips steps 0–2", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");

    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k4",
      entityKey: "t:agent",
      budget: 500_000n,
    });
    deps.worker.produceDeliverable = vi.fn().mockRejectedValue(new Error("stop"));

    await expect(runJob(deps)).rejects.toThrow("stop");
    expect(jobs.findByKey("t:k4")?.status).toBe("funded");

    // Run again from funded — should skip steps 0–2
    const deps2 = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k4",
      entityKey: "t:agent",
      budget: 500_000n,
    });
    deps2.worker.produceDeliverable = vi.fn().mockRejectedValue(new Error("stop again"));

    await expect(runJob(deps2)).rejects.toThrow("stop again");
    // Still funded (steps 0–2 were skipped — the saga fast-forwarded)
    expect(jobs.findByKey("t:k4")?.status).toBe("funded");
  });
});

test("TIER-0 AUDIT FIX: resuming a job after operator rotation is REFUSED, not mis-signed", async () => {
  // The race (verified in the spec audit): the on-chain job pins its provider at creation, but
  // steps rebuild the signing wallet from the LIVE entity row. After setOperator, resuming would
  // sign as the wrong wallet (on-chain revert) or worse, complete pays the retired key after the
  // drain. Refuse loudly instead.
  const db = makeDb();
  const jobs = new SqliteJobRepository(db);
  const entities = new SqliteEntityRepository(db);
  seedBoundEntity(entities, "t:rotated");

  const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:kr", entityKey: "t:rotated" });
  // A job created under the OLD operator, mid-saga:
  const rec = {
    jobKey: "t:kr",
    entityKey: "t:rotated",
    tenantId: "t",
    status: "created" as const,
    jobId: "7",
    budgetAmount: "500000",
    description: "d",
    providerAddress: "0x000000000000000000000000000000000000dEaD", // pinned at creation, != entity.operator
    clientAddress: "0x0000000000000000000000000000000000000001",
    evaluatorAddress: "0x0000000000000000000000000000000000000002",
    deliverableHash: null,
    resultSummary: null,
    createTxHash: null,
    fundTxHash: null,
    submitTxHash: null,
    completeTxHash: null,
    sweepTxHash: null,
    reputationTxHash: null,
    error: null,
  };
  jobs.upsert(rec as never);

  await expect(runJob(deps)).rejects.toThrow(/rotated|provider/i);
});
