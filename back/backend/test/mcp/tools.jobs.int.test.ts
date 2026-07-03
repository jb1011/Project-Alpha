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

let db: Database.Database;
let repo: SqliteEntityRepository;
let jobs: SqliteJobRepository;
let apiKeys: SqliteApiKeyStore;
let app: ReturnType<typeof buildApiApp>;

const baseJob: JobRecord = {
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

/** Seed an entity (jobs.entity_key has an FK to entities.idempotency_key). */
function seedEntity(tenantId: string, userKey: string) {
  const entityId = `${tenantId}:${userKey}`;
  repo.upsert({
    idempotencyKey: entityId,
    name: "TestAgent",
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: tenantId as `0x${string}`,
    operator: "0x000000000000000000000000000000000000000B",
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
  jobs = new SqliteJobRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
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
  } as never);
});
afterEach(() => db.close());

test("tenant-wide key: get_job returns the view and list_jobs returns the entity's jobs", async () => {
  const entityA1 = seedEntity(TENANT, "agent1");
  jobs.upsert({ ...baseJob, jobKey: "jobA1", entityKey: entityA1, ownerTenantId: TENANT });

  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const getRes = await client.callTool({ name: "get_job", arguments: { jobKey: "jobA1" } });
    const view = JSON.parse((getRes.content as { text: string }[])[0]!.text);
    expect(getRes.isError).toBeFalsy();
    expect(view.jobKey).toBe("jobA1");
    expect(view.entityKey).toBe(entityA1);

    const listRes = await client.callTool({ name: "list_jobs", arguments: { id: entityA1 } });
    const list = JSON.parse((listRes.content as { text: string }[])[0]!.text);
    expect(listRes.isError).toBeFalsy();
    expect(list).toHaveLength(1);
    expect(list[0].jobKey).toBe("jobA1");
  } finally {
    await close();
  }
});

test("cross-tenant: get_job hides another tenant's job (uniform not-found, isError)", async () => {
  const entityB1 = seedEntity(OTHER_TENANT, "x");
  jobs.upsert({ ...baseJob, jobKey: "jobB1", entityKey: entityB1, ownerTenantId: OTHER_TENANT });

  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({ name: "get_job", arguments: { jobKey: "jobB1" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("job not found");
  } finally {
    await close();
  }
});

test("missing: get_job on a nonexistent jobKey returns uniform not-found (isError)", async () => {
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({ name: "get_job", arguments: { jobKey: "does-not-exist" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("job not found");
  } finally {
    await close();
  }
});

test("entity-scoped key: get_job/list_jobs on a different entity (same tenant) are denied", async () => {
  const entityA1 = seedEntity(TENANT, "agent1");
  const entityA2 = seedEntity(TENANT, "agent2");
  jobs.upsert({ ...baseJob, jobKey: "jobA2", entityKey: entityA2, ownerTenantId: TENANT });

  const { key } = apiKeys.mint(TENANT, { entityId: entityA1, capability: "read" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const getRes = await client.callTool({ name: "get_job", arguments: { jobKey: "jobA2" } });
    expect(getRes.isError).toBe(true);
    expect((getRes.content as { text: string }[])[0]!.text).toBe("job not found");

    const listRes = await client.callTool({ name: "list_jobs", arguments: { id: entityA2 } });
    expect(listRes.isError).toBe(true);
  } finally {
    await close();
  }
});
