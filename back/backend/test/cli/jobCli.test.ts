/**
 * Light unit test for run-job / get-job / list-jobs CLI commands.
 * Uses a fake CliContext — no chain, no db.
 */
import { expect, test, vi } from "vitest";
import type { CliContext } from "../../src/cli/context";
import { buildCli } from "../../src/cli/index";
import type { JobDeps } from "../../src/jobs/composition";
import type { JobRecord } from "../../src/jobs/types";
import type { OaAnchorRecord } from "../../src/persistence/oaAnchorRepository";
import { usdToUnits } from "../../src/policy/units";

const FAKE_ADDRESS = "0x0000000000000000000000000000000000000001" as const;

function makeFakeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobKey: "t:agent:1234567890",
    jobId: null,
    entityKey: "t:agent",
    status: "pending",
    clientAddress: FAKE_ADDRESS,
    evaluatorAddress: FAKE_ADDRESS,
    providerAddress: FAKE_ADDRESS,
    budgetAmount: usdToUnits("2.00").toString(),
    description: "demo job",
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
    ...overrides,
  };
}

function makeFakeCtx(over: { refundJob?: JobDeps["refundJob"]; record?: JobRecord } = {}): {
  ctx: CliContext;
  runJobSpy: ReturnType<typeof vi.fn>;
} {
  const fakeRecord = over.record ?? makeFakeRecord();

  const runJobSpy = vi.fn().mockResolvedValue(fakeRecord);

  const fakeJobDeps: Pick<JobDeps, "runJob" | "jobs" | "refundJob"> = {
    runJob: runJobSpy,
    refundJob: over.refundJob,
    jobs: {
      findByKey: vi.fn().mockReturnValue(fakeRecord),
      listByEntity: vi.fn().mockReturnValue([fakeRecord]),
      list: vi.fn().mockReturnValue([fakeRecord]),
      // satisfy interface but shouldn't be called in these tests
      upsert: vi.fn(),
      listByTenant: vi.fn().mockReturnValue([]),
      listInFlight: vi.fn().mockReturnValue([]),
      listEscrowedUnrefunded: vi.fn().mockReturnValue([]),
      recordEvent: vi.fn(),
      transaction: <T>(fn: () => T): T => fn(),
    },
  };

  const ctx = {
    cfg: {} as CliContext["cfg"],
    repo: {} as CliContext["repo"],
    docStore: {} as CliContext["docStore"],
    arc: {} as CliContext["arc"],
    operatorSigner: {} as CliContext["operatorSigner"],
    jobDeps: fakeJobDeps as unknown as JobDeps,
  } as CliContext;

  return { ctx, runJobSpy };
}

test("run-job: parses --entity and --budget, calls runJob with correct args", async () => {
  const { ctx, runJobSpy } = makeFakeCtx();
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

  await buildCli(async () => ctx).parseAsync([
    "node",
    "cli",
    "run-job",
    "--entity",
    "t:agent",
    "--budget",
    "2.00",
  ]);

  spy.mockRestore();

  expect(runJobSpy).toHaveBeenCalledOnce();
  const call = runJobSpy.mock.calls[0]![0] as { entityKey: string; budget: bigint };
  expect(call.entityKey).toBe("t:agent");
  expect(call.budget).toBe(usdToUnits("2.00"));
  expect(logs.join("\n")).toContain('"entityKey": "t:agent"');
});

test("run-job: uses default budget 1.00 when not specified", async () => {
  const { ctx, runJobSpy } = makeFakeCtx();
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  await buildCli(async () => ctx).parseAsync(["node", "cli", "run-job", "--entity", "t:agent"]);

  consoleSpy.mockRestore();

  const call = runJobSpy.mock.calls[0]![0] as { budget: bigint };
  expect(call.budget).toBe(usdToUnits("1.00"));
});

test("get-job: prints the job view for a known jobKey", async () => {
  const { ctx } = makeFakeCtx();
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

  await buildCli(async () => ctx).parseAsync(["node", "cli", "get-job", "t:agent:1234567890"]);

  spy.mockRestore();
  expect(logs.join("\n")).toContain('"jobKey": "t:agent:1234567890"');
});

test("get-job: sets exitCode=1 for unknown key", async () => {
  const { ctx } = makeFakeCtx();
  // Override findByKey to return undefined
  (ctx.jobDeps.jobs.findByKey as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  const errLogs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((m) => errLogs.push(String(m)));
  const prev = process.exitCode;

  await buildCli(async () => ctx).parseAsync(["node", "cli", "get-job", "does-not-exist"]);

  vi.restoreAllMocks();
  expect(errLogs.join("\n")).toContain("not found");
  expect(process.exitCode).toBe(1);
  process.exitCode = prev; // restore
});

test("list-jobs: without --entity prints all jobs as JSON array", async () => {
  const { ctx } = makeFakeCtx();
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

  await buildCli(async () => ctx).parseAsync(["node", "cli", "list-jobs"]);

  vi.restoreAllMocks();
  const parsed = JSON.parse(logs.join(""));
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed[0].entityKey).toBe("t:agent");
});

test("list-jobs: with --entity filters by entity", async () => {
  const { ctx } = makeFakeCtx();
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  await buildCli(async () => ctx).parseAsync(["node", "cli", "list-jobs", "--entity", "t:agent"]);

  consoleSpy.mockRestore();
  expect(ctx.jobDeps.jobs.listByEntity).toHaveBeenCalledWith("t:agent");
});

// ── F10: `acknowledgeHold` gets its surface ────────────────────────────────────────────────

/**
 * The operator's only exit from an anchor hold that the guardian does not end on chain.
 *
 * `acknowledgeHold` existed as a repository method with nothing calling it, so an operator staring
 * at `anchor_held` in journald had to open sqlite and hand-write the UPDATE — against the money
 * database, at whatever hour the page arrived.
 */
function ctxWithAnchors(rows: Record<string, OaAnchorRecord>) {
  const anchors = {
    find: vi.fn((_k: string, v: number) => rows[`v${v}`]),
    acknowledgeHold: vi.fn((_k: string, v: number) => {
      const row = rows[`v${v}`];
      if (!row || (row.state !== "vetoed" && row.state !== "failed")) return false;
      rows[`v${v}`] = { ...row, state: "superseded" };
      return true;
    }),
  };
  return { ctx: { anchors } as unknown as CliContext, anchors };
}

function heldRow(state: "vetoed" | "failed" | "scheduled"): OaAnchorRecord {
  return {
    entityKey: "t:agent",
    version: 2,
    manifestHash: `0x${"ab".repeat(32)}`,
    state,
    scheduleTx: null,
    executeTx: null,
    executableAt: null,
    attempt: 0,
    error: null,
    nextRetryAt: null,
    retryIntervalMs: null,
    updatedAt: "2026-08-24 10:00:00",
  };
}

test("F10: anchor-ack ends a held cycle and prints what it did", async () => {
  const { ctx, anchors } = ctxWithAnchors({ v2: heldRow("vetoed") });
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  await buildCli(async () => ctx).parseAsync(["node", "cli", "anchor-ack", "t:agent", "2"]);
  spy.mockRestore();

  expect(anchors.acknowledgeHold).toHaveBeenCalledWith("t:agent", 2);
  const out = JSON.parse(logs.join("\n"));
  expect(out).toMatchObject({
    entityKey: "t:agent",
    version: 2,
    acknowledged: true,
    was: "vetoed",
  });
  // The honest caveat, printed where the operator is looking: an ack is a statement about OUR
  // records, and a scheduled amendment stays executable on chain whatever we record.
  expect(out.note).toMatch(/only the guardian can stop it/);
});

test("F10: anchor-ack refuses a cycle that is not held, and says why", async () => {
  const { ctx } = ctxWithAnchors({ v2: heldRow("scheduled") });
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  await buildCli(async () => ctx).parseAsync(["node", "cli", "anchor-ack", "t:agent", "2"]);
  spy.mockRestore();

  const out = JSON.parse(logs.join("\n"));
  expect(out.acknowledged).toBe(false);
  expect(out.note).toMatch(/only `vetoed` or `failed`/);
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
});

// ── refund-job ────────────────────────────────────────────────────────────────────────────────
//
// The operator's door to the escrow recovery: the same function the saga and the boot reconcile
// call (`jobs/refund.ts`), for the job that is still owed its money now.

test("refund-job: prints the outcome AND the row it left behind", async () => {
  const refunded = makeFakeRecord({
    status: "failed",
    escrowState: "refunded",
    refundTxHash: `0x${"ab".repeat(32)}`,
  });
  const refundJob = vi.fn().mockResolvedValue({
    outcome: "refunded",
    via: "reject",
    txHash: `0x${"ab".repeat(32)}`,
  });
  const { ctx } = makeFakeCtx({ refundJob, record: refunded });
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

  await buildCli(async () => ctx).parseAsync(["node", "cli", "refund-job", "t:agent:1234567890"]);
  // Asserted BEFORE the spies are restored: `vi.restoreAllMocks()` resets a `vi.fn()`, history
  // and all, so a call count read after it is always zero.
  expect(refundJob).toHaveBeenCalledWith("t:agent:1234567890");

  vi.restoreAllMocks();
  const printed = JSON.parse(logs.join(""));
  expect(printed.jobKey).toBe("t:agent:1234567890");
  expect(printed.outcome).toBe("refunded");
  expect(printed.via).toBe("reject");
  expect(printed.txHash).toBe(`0x${"ab".repeat(32)}`);
  // The row, through the same projection every other job surface uses.
  expect(printed.job.escrowState).toBe("refunded");
  expect(printed.job.refundTxHash).toBe(`0x${"ab".repeat(32)}`);
});

test("refund-job: a bigint deadline is printed as a decimal string, not a crash", async () => {
  // `waiting-expiry` carries `expiredAt` as a bigint, and JSON.stringify throws on one — which
  // would be a TypeError at the exact moment an operator is asking where their money is.
  const refundJob = vi.fn().mockResolvedValue({ outcome: "waiting-expiry", expiredAt: 5_000n });
  const { ctx } = makeFakeCtx({ refundJob });
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

  await buildCli(async () => ctx).parseAsync(["node", "cli", "refund-job", "t:agent:1234567890"]);

  vi.restoreAllMocks();
  const printed = JSON.parse(logs.join(""));
  expect(printed.outcome).toBe("waiting-expiry");
  expect(printed.expiredAt).toBe("5000");
});

test("refund-job: with no job client key it refuses and names the variable", async () => {
  const { ctx } = makeFakeCtx(); // no refundJob: the signing half is absent
  const errLogs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((m) => errLogs.push(String(m)));
  const prev = process.exitCode;

  await buildCli(async () => ctx).parseAsync(["node", "cli", "refund-job", "t:agent:1234567890"]);

  vi.restoreAllMocks();
  expect(errLogs.join("\n")).toContain("set JOB_CLIENT_PRIVATE_KEY to refund a job");
  expect(process.exitCode).toBe(1);
  process.exitCode = prev;
});

test("refund-job: an unknown jobKey is a refusal, and nothing is sent", async () => {
  const refundJob = vi.fn();
  const { ctx } = makeFakeCtx({ refundJob });
  (ctx.jobDeps.jobs.findByKey as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  const errLogs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((m) => errLogs.push(String(m)));
  const prev = process.exitCode;

  await buildCli(async () => ctx).parseAsync(["node", "cli", "refund-job", "does-not-exist"]);
  expect(refundJob).not.toHaveBeenCalled();

  vi.restoreAllMocks();
  expect(errLogs.join("\n")).toContain("not found");
  expect(process.exitCode).toBe(1);
  process.exitCode = prev;
});
