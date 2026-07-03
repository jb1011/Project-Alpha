import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
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
    jobRunner: FAKE_JOB_RUNNER,
    jobClientAddress: CLIENT_ADDR,
    jobEvaluatorAddress: EVALUATOR_ADDR,
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
