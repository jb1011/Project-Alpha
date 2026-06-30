import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { JobRunner } from "../../src/jobs/jobRunner";
import type { JobStatus } from "../../src/jobs/types";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { OnboardingRunner } from "../../src/workflow/runner";

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

let db: Database.Database;
let repo: SqliteEntityRepository;
let jobs: SqliteJobRepository;

function makeApp() {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  const jobRunner = new JobRunner({
    jobs,
    runJob: async () => jobs.findByKey("noop")!,
  });
  return buildApiApp({
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
  } as never);
}

async function login(app: ReturnType<typeof buildApiApp>, acct = account) {
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

function seedBound(tenant: string, key: string) {
  const id = `${tenant}:${key}`;
  repo.upsert({
    idempotencyKey: id,
    name: "A",
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: tenant as `0x${string}`,
    operator: null,
    amendmentDelay: "0",
    ein: "",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: {
      usdc: "0x3600000000000000000000000000000000000000",
      payoutAddress: "0x000000000000000000000000000000000000000A",
      cap: 1_000_000n,
      period: 86_400n,
      allowlistEnabled: false,
    },
    agentId: "42",
    proxy: null,
    treasury: "0x000000000000000000000000000000000000000F",
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: tenant,
  });
  return id;
}

let jobCounter = 0;
function seedJob(entityKey: string, status: JobStatus) {
  jobCounter += 1;
  jobs.upsert({
    jobKey: `test-job-${jobCounter}`,
    jobId: null,
    entityKey,
    ownerTenantId: entityKey.split(":")[0],
    status,
    clientAddress: CLIENT_ADDR as `0x${string}`,
    evaluatorAddress: EVALUATOR_ADDR as `0x${string}`,
    providerAddress: "0x000000000000000000000000000000000000000B" as `0x${string}`,
    budgetAmount: "1000000",
    description: `test job ${jobCounter}`,
    deliverableHash: null,
    deliverablePath: null,
    createTxHash: null,
    fundTxHash: null,
    submitTxHash: null,
    completeTxHash: null,
    sweepTxHash: null,
    reputationTxHash: null,
    error: null,
  });
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  jobs = new SqliteJobRepository(db);
  jobCounter = 0;
});
afterEach(() => db.close());

test("GET /entities/:id/reputation → 200 with the agent's job track record", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  // seed jobs for `id` via the same JobStore the app uses
  seedJob(id, "reputed");
  seedJob(id, "completed");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/reputation`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.reputation).toMatchObject({ totalJobs: 2, reputed: 1 });
});

test("cross-tenant → 404", async () => {
  const app = makeApp();
  await login(app);
  seedBound(account.address, "a1");
  const other = await login(app, otherAccount);
  const res = await app.request(
    `/entities/${encodeURIComponent(`${account.address}:a1`)}/reputation`,
    {
      headers: { authorization: `Bearer ${other}` },
    },
  );
  expect(res.status).toBe(404);
});

test("no auth → 401", async () => {
  expect((await makeApp().request("/entities/x/reputation")).status).toBe(401);
});
