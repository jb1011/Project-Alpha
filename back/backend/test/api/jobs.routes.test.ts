import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { JobRunner } from "../../src/jobs/jobRunner";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const otherAccount = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const CLIENT_ADDR = "0x000000000000000000000000000000000000000C";
const EVALUATOR_ADDR = "0x000000000000000000000000000000000000000E";
// Audit fix A caps, exercised below.
const MAX_JOB_BUDGET = 5_000_000n; // 5 USDC
const MAX_INFLIGHT_JOBS_PER_TENANT = 3;

let db: Database.Database;
let repo: SqliteEntityRepository;
let jobs: SqliteJobRepository;

function makeApp() {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => {
      const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
      return cur;
    },
    fundCaps: TEST_FUND_CAPS,
  });

  // runJob is a no-op: job stays pending so we can inspect it.
  const jobRunner = new JobRunner({
    jobs,
    runJob: async () => {
      // no-op: leaves the record as-is (pending)
      return jobs.findByKey("noop")!;
    },
  });

  const app = buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    jobs,
    jobRunner,
    jobClientAddress: CLIENT_ADDR,
    jobEvaluatorAddress: EVALUATOR_ADDR,
    maxJobBudget: MAX_JOB_BUDGET,
    maxInflightJobsPerTenant: MAX_INFLIGHT_JOBS_PER_TENANT,
  } as never);

  return { app, jobRunner };
}

async function login(app: ReturnType<typeof buildApiApp>, acct: typeof account = account) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: acct.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = await acct.signMessage({ message });
  const body = await (
    await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    })
  ).json();
  return body.token as string;
}

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
});
afterEach(() => db.close());

test("POST /entities/:id/jobs → 202 { jobKey, status: 'pending' }", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const entityId = seedEntity(account.address, "agent1");

  const res = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ budget: "2.00", description: "test job" }),
  });
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(typeof body.jobKey).toBe("string");
  expect(body.status).toBe("pending");
});

test("GET /jobs/:jobKey → 200 with JobView", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const entityId = seedEntity(account.address, "agent1");

  // Trigger a job first
  const triggerRes = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ budget: "1.50", description: "view test" }),
  });
  expect(triggerRes.status).toBe(202);
  const { jobKey } = await triggerRes.json();

  // Poll the job
  const pollRes = await app.request(`/jobs/${encodeURIComponent(jobKey)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(pollRes.status).toBe(200);
  const view = await pollRes.json();
  expect(view.jobKey).toBe(jobKey);
  expect(view.status).toBe("pending");
  expect(view.entityKey).toBe(entityId);
});

test("GET /entities/:id/jobs → 200 list of JobViews for that entity", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const entityId = seedEntity(account.address, "agent1");

  await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ budget: "1.00", description: "job A" }),
  });
  await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ budget: "1.00", description: "job B" }),
  });

  const listRes = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(listRes.status).toBe(200);
  const list = await listRes.json();
  expect(Array.isArray(list)).toBe(true);
  expect(list).toHaveLength(2);
  expect(list[0].entityKey).toBe(entityId);
});

test("cross-tenant: GET /jobs/:jobKey with different tenant token → 404", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const entityId = seedEntity(account.address, "agent1");

  const triggerRes = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const { jobKey } = await triggerRes.json();

  // Login as the other tenant
  const otherToken = await login(app, otherAccount);

  const pollRes = await app.request(`/jobs/${encodeURIComponent(jobKey)}`, {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  expect(pollRes.status).toBe(404);
});

test("cross-tenant: POST to another tenant's entity → 404", async () => {
  const { app } = makeApp();
  // Seed entity owned by main account
  seedEntity(account.address, "agent1");
  const entityId = `${account.address}:agent1`;

  // Login as other tenant and try to trigger a job on entity owned by main account
  const otherToken = await login(app, otherAccount);
  const res = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(404);
});

test("no auth → GET /jobs/anything → 401", async () => {
  const { app } = makeApp();
  const res = await app.request("/jobs/anything");
  expect(res.status).toBe(401);
});

// --- Audit fix A: run_job budget + per-tenant in-flight caps (REST twin) ---

test("POST /entities/:id/jobs rejects a budget over MAX_JOB_BUDGET_USDC (400) without starting a job", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const entityId = seedEntity(account.address, "agent1");

  const res = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    // MAX_JOB_BUDGET is 5_000_000n (5 USDC); 5.01 exceeds it.
    body: JSON.stringify({ budget: "5.01" }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.message).toBe("budget exceeds the max job budget");
  expect(jobs.listByEntity(entityId)).toHaveLength(0);
});

test("POST /entities/:id/jobs accepts a budget exactly at MAX_JOB_BUDGET_USDC", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const entityId = seedEntity(account.address, "agent1");

  const res = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ budget: "5.00" }),
  });
  expect(res.status).toBe(202);
});

test("POST /entities/:id/jobs rejects once the tenant has MAX_INFLIGHT_JOBS_PER_TENANT non-terminal jobs (429)", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const entityId = seedEntity(account.address, "agent1");

  // Fill the cap via the real route (JobRunner's no-op runJob leaves each job "pending").
  for (let i = 0; i < MAX_INFLIGHT_JOBS_PER_TENANT; i++) {
    const res = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ budget: "1.00", description: `seed ${i}` }),
    });
    expect(res.status).toBe(202);
  }
  const before = jobs.listByEntity(entityId).length;

  const res = await app.request(`/entities/${encodeURIComponent(entityId)}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ budget: "1.00", description: "over the cap" }),
  });
  expect(res.status).toBe(429);
  const body = await res.json();
  expect(body.error.message).toBe("too many jobs in flight");
  expect(jobs.listByEntity(entityId)).toHaveLength(before);
});
