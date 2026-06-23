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
  test("create → fund advances to funded and setBudget uses provider wallet", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent");

    const capturedWallet = {} as unknown as import("viem").WalletClient; // sentinel
    let setBudgetWallet: unknown;

    const deps = makeRunJobDeps({
      db,
      jobs,
      entities,
      jobKey: "t:k",
      entityKey: "t:agent",
      budget: 500_000n,
    });

    // Spy on providerWalletFor to capture the provider wallet
    deps.providerWalletFor = vi.fn().mockResolvedValue(capturedWallet);

    // Spy on setBudget to capture the wallet argument
    deps.job.setBudget = vi
      .fn()
      .mockImplementation(async (_id: bigint, _amt: bigint, w: unknown) => {
        setBudgetWallet = w;
        return `0x${"bb".repeat(32)}` as `0x${string}`;
      });

    // Stub the worker so it throws after fund, stopping the saga before submit
    deps.worker.produceDeliverable = vi.fn().mockRejectedValueOnce(new Error("stop after fund"));

    await expect(runJob(deps)).rejects.toThrow("stop after fund");

    // Steps 0–2 must have completed and the record must be persisted as "funded"
    expect(jobs.findByKey("t:k")?.status).toBe("funded");

    // setBudget must be called with the provider wallet from providerWalletFor
    expect(setBudgetWallet).toBe(capturedWallet);
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

    await expect(runJob(deps)).rejects.toThrow(
      /fully-onboarded agent.*missing operator\/subOrg\/agentId/,
    );
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
