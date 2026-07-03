import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { JobRecord } from "../../src/jobs/types";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";
import { startMcpTestClient } from "./helpers";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER_TENANT = "0x000000000000000000000000000000000000000B";
const CLIENT_ADDR = "0x000000000000000000000000000000000000000C";
const EVALUATOR_ADDR = "0x000000000000000000000000000000000000000E";
// Distinct from every id/tenant fixture so the happy-path assertion proves providerAddress
// came from the RESOLVED entity record's operator, not from the id argument.
const OPERATOR = "0x00000000000000000000000000000000000000E1";
// Audit fix A caps, exercised below.
const MAX_JOB_BUDGET = 5_000_000n; // 5 USDC
const MAX_INFLIGHT_JOBS_PER_TENANT = 3;

const baseJob: JobRecord = {
  jobKey: "seed:placeholder",
  jobId: null,
  entityKey: "",
  ownerTenantId: TENANT,
  status: "pending",
  clientAddress: CLIENT_ADDR,
  evaluatorAddress: EVALUATOR_ADDR,
  providerAddress: OPERATOR,
  budgetAmount: "500000",
  description: "seed",
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

interface RecordedStartCall {
  jobKey: string;
  entityKey: string;
  tenantId?: string;
  budget: bigint;
  description: string;
  clientAddress: string;
  evaluatorAddress: string;
  providerAddress: string;
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let jobs: SqliteJobRepository;
let app: ReturnType<typeof buildApiApp>;
let startCalls: RecordedStartCall[];

function repoSeed(tenantId: string, userKey: string) {
  const entityId = `${tenantId}:${userKey}`;
  repo.upsert({
    idempotencyKey: entityId,
    name: "TestAgent",
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: tenantId as `0x${string}`,
    operator: OPERATOR,
    amendmentDelay: "86400",
    ein: "12-3456789",
    formationDate: 1700000000,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: "42",
    proxy: "0x000000000000000000000000000000000000000D",
    treasury: "0x000000000000000000000000000000000000000F",
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: tenantId,
  });
  return entityId;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  jobs = new SqliteJobRepository(db);
  startCalls = [];
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  const FAKE_JOB_RUNNER = {
    start: (p: RecordedStartCall) => {
      startCalls.push(p);
      return { jobKey: p.jobKey, status: "pending" };
    },
  };
  app = buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: "wizard.local",
    chainId: 5042002,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys,
    passkeys: new SqlitePasskeyStore(db),
    jobs,
    jobRunner: FAKE_JOB_RUNNER,
    jobClientAddress: CLIENT_ADDR,
    jobEvaluatorAddress: EVALUATOR_ADDR,
    maxJobBudget: MAX_JOB_BUDGET,
    maxInflightJobsPerTenant: MAX_INFLIGHT_JOBS_PER_TENANT,
  } as never);
});
afterEach(() => db.close());

test("run_job with a read-capability key is uniform not-found and never starts the saga", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "read" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: `${TENANT}:agent1` },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(startCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test("run_job with an earn-capability key proceeds to the job runner", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: `${TENANT}:agent1` },
    });
    expect(res.isError).toBeFalsy();
    expect(startCalls).toHaveLength(1);
  } finally {
    await close();
  }
});

test("run_job with a spend-capability key proceeds too (spend ⊇ earn)", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT); // default capability = spend
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: `${TENANT}:agent1` },
    });
    expect(res.isError).toBeFalsy();
    expect(startCalls).toHaveLength(1);
  } finally {
    await close();
  }
});

test("run_job on a cross-tenant entity id is uniform not-found and never starts the saga", async () => {
  repoSeed(OTHER_TENANT, "secret");
  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: `${OTHER_TENANT}:secret` },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(startCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test("run_job with an entity-scoped key calling a DIFFERENT entity is uniform not-found and never starts the saga", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { entityId: `${TENANT}:other`, capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: `${TENANT}:agent1` },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(startCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test.each([
  ["abc", "invalid budgetUsdc"],
  ["-1", "invalid budgetUsdc"],
  ["1.1234567", "invalid budgetUsdc"], // >6 decimals: rejected uniformly at the tool boundary
  ["0", "budgetUsdc must be positive"],
])(
  "run_job rejects budgetUsdc=%s without starting the saga (%s)",
  async (budgetUsdc, expectedText) => {
    repoSeed(TENANT, "agent1");
    const { key } = apiKeys.mint(TENANT, { capability: "earn" });
    const { client, close } = await startMcpTestClient(app, key);
    try {
      const res = await client.callTool({
        name: "run_job",
        arguments: { id: `${TENANT}:agent1`, budgetUsdc },
      });
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0]!.text).toBe(expectedText);
      expect(startCalls).toHaveLength(0);
    } finally {
      await close();
    }
  },
);

test("run_job happy path starts the saga once with the RESOLVED entity's args", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: `${TENANT}:agent1`, budgetUsdc: "2.00" },
    });
    expect(res.isError).toBeFalsy();
    expect(startCalls).toHaveLength(1);
    const call = startCalls[0]!;
    expect(call.jobKey.startsWith(`${TENANT}:agent1:`)).toBe(true);
    expect(call.entityKey).toBe(`${TENANT}:agent1`);
    expect(call.tenantId).toBe(TENANT);
    expect(call.budget).toBe(2_000_000n);
    expect(call.description).toBe("agent job (mcp)");
    expect(call.clientAddress).toBe(CLIENT_ADDR);
    expect(call.evaluatorAddress).toBe(EVALUATOR_ADDR);
    // providerAddress is the RESOLVED entity's operator, not derived from the id argument.
    expect(call.providerAddress).toBe(OPERATOR);
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out).toEqual({ jobKey: call.jobKey, status: "pending" });
  } finally {
    await close();
  }
});

test("run_job defaults the budget to 1.00 USDC (1_000_000n) when budgetUsdc is omitted", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: `${TENANT}:agent1` },
    });
    expect(res.isError).toBeFalsy();
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.budget).toBe(1_000_000n);
  } finally {
    await close();
  }
});

// --- Audit fix A: run_job budget + per-tenant in-flight caps ---

test("run_job rejects a budgetUsdc over MAX_JOB_BUDGET_USDC without starting the saga", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      // MAX_JOB_BUDGET is 5_000_000n (5 USDC); 5.01 exceeds it.
      arguments: { id: `${TENANT}:agent1`, budgetUsdc: "5.01" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe(
      "budgetUsdc exceeds the max job budget",
    );
    expect(startCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test("run_job accepts a budgetUsdc exactly at MAX_JOB_BUDGET_USDC", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: `${TENANT}:agent1`, budgetUsdc: "5.00" },
    });
    expect(res.isError).toBeFalsy();
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.budget).toBe(MAX_JOB_BUDGET);
  } finally {
    await close();
  }
});

test("run_job rejects when the tenant already has MAX_INFLIGHT_JOBS_PER_TENANT non-terminal jobs", async () => {
  const entityId = repoSeed(TENANT, "agent1");
  // Seed exactly the cap's worth of non-terminal jobs for this tenant. Statuses other than
  // completed/reputed/failed all count as in-flight.
  const nonTerminalStatuses = ["pending", "created", "funded"] as const;
  expect(nonTerminalStatuses).toHaveLength(MAX_INFLIGHT_JOBS_PER_TENANT);
  nonTerminalStatuses.forEach((status, i) => {
    jobs.upsert({ ...baseJob, jobKey: `seed-${i}`, entityKey: entityId, status });
  });

  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: entityId },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe(
      "too many jobs in flight, try again later",
    );
    expect(startCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test("run_job ignores terminal jobs when counting in-flight and still starts under both caps", async () => {
  const entityId = repoSeed(TENANT, "agent1");
  // MAX_INFLIGHT_JOBS_PER_TENANT terminal jobs must NOT count toward the cap.
  const terminalStatuses = ["completed", "reputed", "failed"] as const;
  expect(terminalStatuses).toHaveLength(MAX_INFLIGHT_JOBS_PER_TENANT);
  terminalStatuses.forEach((status, i) => {
    jobs.upsert({ ...baseJob, jobKey: `terminal-${i}`, entityKey: entityId, status });
  });

  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "run_job",
      arguments: { id: entityId, budgetUsdc: "2.00" },
    });
    expect(res.isError).toBeFalsy();
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.budget).toBe(2_000_000n);
  } finally {
    await close();
  }
});
