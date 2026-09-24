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
import { TEST_FUND_CAPS } from "../helpers/fundCaps";
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
  refundTxHash: null,
  escrowState: null,
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
    fundCaps: TEST_FUND_CAPS,
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

/**
 * The same app, plus the escrow recovery — the half that only exists where a job client key does.
 *
 * `refund_job` is the on-demand door to `jobs/refund.ts` (the saga and the boot reconcile are the
 * other two). Everything interesting about it here is the GATE, so the recovery itself is a fake
 * that records the jobKey it was asked about: a tool that refuses must not have called it.
 */
function appWithRefund(refundJob?: (jobKey: string) => Promise<unknown>) {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  return buildApiApp({
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
    refundJob,
  } as never);
}

const REFUND_HASH = `0x${"ab".repeat(32)}`;

/** A recovery that always succeeds, and the list of jobKeys it was asked about. */
function fakeRefund() {
  const asked: string[] = [];
  return {
    asked,
    refundJob: async (jobKey: string) => {
      asked.push(jobKey);
      return { outcome: "refunded", via: "reject", txHash: REFUND_HASH };
    },
  };
}

const textOf = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;

test("refund_job recovers the caller's own job and reports what happened", async () => {
  const entityA1 = seedEntity(TENANT, "agent1");
  jobs.upsert({
    ...baseJob,
    jobKey: "jobA1",
    entityKey: entityA1,
    ownerTenantId: TENANT,
    status: "failed",
    fundTxHash: `0x${"f7".repeat(32)}`,
  });
  const fake = fakeRefund();

  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(appWithRefund(fake.refundJob), key);
  try {
    const res = await client.callTool({ name: "refund_job", arguments: { jobKey: "jobA1" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      jobKey: "jobA1",
      outcome: "refunded",
      via: "reject",
      txHash: REFUND_HASH,
    });
    expect(fake.asked).toEqual(["jobA1"]);
  } finally {
    await close();
  }
});

test("refund_job renders a bigint deadline as a string rather than throwing", async () => {
  // `waiting-expiry` carries `expiredAt` as a bigint, which `JSON.stringify` refuses. Serving a
  // TypeError to an agent asking where its money is would be the worst possible moment for one.
  const entityA1 = seedEntity(TENANT, "agent1");
  jobs.upsert({ ...baseJob, jobKey: "jobA1", entityKey: entityA1, ownerTenantId: TENANT });

  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(
    appWithRefund(async () => ({ outcome: "waiting-expiry", expiredAt: 5_000n })),
    key,
  );
  try {
    const res = await client.callTool({ name: "refund_job", arguments: { jobKey: "jobA1" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      jobKey: "jobA1",
      outcome: "waiting-expiry",
      expiredAt: "5000",
    });
  } finally {
    await close();
  }
});

test("two refund_job calls on one job never run the recovery at the same time", async () => {
  // THE DOOR TAKES THE SAME LOCK AS EVERYTHING ELSE. `recoverEscrow` reads the chain, decides and
  // sends; two callers inside that window both read Funded and both send a reject. One is mined,
  // the other reverts — burnt gas, a `refund/failed` on the trail describing nothing real, and
  // the loser's write landing on top of the winner's. The saga and the boot walk serialise on
  // `withKeyedLock(entityKey)`; this door has to be on the same key.
  const entityA1 = seedEntity(TENANT, "agent1");
  jobs.upsert({
    ...baseJob,
    jobKey: "jobA1",
    entityKey: entityA1,
    ownerTenantId: TENANT,
    status: "failed",
    fundTxHash: `0x${"f7".repeat(32)}`,
  });

  // A recovery that would overlap with itself if nothing held it apart: it parks for a tick in
  // the middle, exactly where the real one is reading the chain and sending.
  let inside = 0;
  let maxInside = 0;
  const refundJob = async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside -= 1;
    return { outcome: "refunded", via: "reject", txHash: REFUND_HASH };
  };

  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(appWithRefund(refundJob), key);
  try {
    const [a, b] = await Promise.all([
      client.callTool({ name: "refund_job", arguments: { jobKey: "jobA1" } }),
      client.callTool({ name: "refund_job", arguments: { jobKey: "jobA1" } }),
    ]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    // Both calls were served, one after the other — never together.
    expect(maxInside).toBe(1);
  } finally {
    await close();
  }
});

test("refund_job hides another tenant's job, and does not touch its escrow", async () => {
  const entityB1 = seedEntity(OTHER_TENANT, "x");
  jobs.upsert({ ...baseJob, jobKey: "jobB1", entityKey: entityB1, ownerTenantId: OTHER_TENANT });
  const fake = fakeRefund();

  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(appWithRefund(fake.refundJob), key);
  try {
    const res = await client.callTool({ name: "refund_job", arguments: { jobKey: "jobB1" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("job not found");
    // The refusal reached no chain: somebody else's escrow is not ours to move.
    expect(fake.asked).toEqual([]);
  } finally {
    await close();
  }
});

test("refund_job needs the earn capability, exactly like run_job", async () => {
  const entityA1 = seedEntity(TENANT, "agent1");
  jobs.upsert({ ...baseJob, jobKey: "jobA1", entityKey: entityA1, ownerTenantId: TENANT });
  const fake = fakeRefund();

  // A read-only key: the same uniform refusal `run_job` gives, teaching nothing about the job.
  const { key } = apiKeys.mint(TENANT, { capability: "read" });
  const { client, close } = await startMcpTestClient(appWithRefund(fake.refundJob), key);
  try {
    const res = await client.callTool({ name: "refund_job", arguments: { jobKey: "jobA1" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("not found");
    expect(fake.asked).toEqual([]);
  } finally {
    await close();
  }
});

test("with no job client key, refund_job says so and names the variable", async () => {
  const entityA1 = seedEntity(TENANT, "agent1");
  jobs.upsert({ ...baseJob, jobKey: "jobA1", entityKey: entityA1, ownerTenantId: TENANT });

  const { key } = apiKeys.mint(TENANT, { capability: "earn" });
  const { client, close } = await startMcpTestClient(appWithRefund(undefined), key);
  try {
    const res = await client.callTool({ name: "refund_job", arguments: { jobKey: "jobA1" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      "jobs unavailable: set JOB_CLIENT_PRIVATE_KEY (its own funded address — it pays the job escrow and gas)",
    );
  } finally {
    await close();
  }
});

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
