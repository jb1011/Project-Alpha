/**
 * Light unit test for run-job / get-job / list-jobs CLI commands.
 * Uses a fake CliContext — no chain, no db.
 */
import { expect, test, vi } from "vitest";
import type { CliContext } from "../../src/cli/context";
import { buildCli } from "../../src/cli/index";
import type { JobDeps } from "../../src/jobs/composition";
import type { JobRecord } from "../../src/jobs/types";
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
    error: null,
    ...overrides,
  };
}

function makeFakeCtx(): { ctx: CliContext; runJobSpy: ReturnType<typeof vi.fn> } {
  const fakeRecord = makeFakeRecord();

  const runJobSpy = vi.fn().mockResolvedValue(fakeRecord);

  const fakeJobDeps: Pick<JobDeps, "runJob" | "jobs"> = {
    runJob: runJobSpy,
    jobs: {
      findByKey: vi.fn().mockReturnValue(fakeRecord),
      listByEntity: vi.fn().mockReturnValue([fakeRecord]),
      list: vi.fn().mockReturnValue([fakeRecord]),
      // satisfy interface but shouldn't be called in these tests
      upsert: vi.fn(),
      listByTenant: vi.fn().mockReturnValue([]),
      listInFlight: vi.fn().mockReturnValue([]),
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
