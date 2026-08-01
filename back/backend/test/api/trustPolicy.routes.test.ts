import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
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

let db: Database.Database;
let repo: SqliteEntityRepository;

function makeApp() {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
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
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    jobRunner: {} as never,
    jobClientAddress: "0x0000000000000000000000000000000000000000",
    jobEvaluatorAddress: "0x0000000000000000000000000000000000000000",
    arc: {} as never,
    agentRuns: {} as never,
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
    perTxCap: null,
  });
  return id;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

test("PATCH /entities/:id/trust-policy → 200 sets the per-entity dial and persists it", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/trust-policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ trustPolicy: "verified-legal-bodies-only" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ trustPolicy: "verified-legal-bodies-only" });
  expect(repo.findByIdempotencyKey(id)?.trustPolicy).toBe("verified-legal-bodies-only");
});

test("PATCH with null → clears the override (back to inheriting the platform default)", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  await app.request(`/entities/${encodeURIComponent(id)}/trust-policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ trustPolicy: "open" }),
  });
  const res = await app.request(`/entities/${encodeURIComponent(id)}/trust-policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ trustPolicy: null }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ trustPolicy: null });
  expect(repo.findByIdempotencyKey(id)?.trustPolicy ?? null).toBeNull();
});

test("an invalid value is a 400, not a silent default", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/trust-policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ trustPolicy: "yolo" }),
  });
  expect(res.status).toBe(400);
});

test("another tenant's entity is a uniform 404 (no exists-but-not-yours leak)", async () => {
  const app = makeApp();
  const id = seedBound(account.address, "a1");
  const token = await login(app, otherAccount);
  const res = await app.request(`/entities/${encodeURIComponent(id)}/trust-policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ trustPolicy: "open" }),
  });
  expect(res.status).toBe(404);
  expect(repo.findByIdempotencyKey(id)?.trustPolicy ?? null).toBeNull(); // untouched
});

test("no auth → 401", async () => {
  const app = makeApp();
  const id = seedBound(account.address, "a1");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/trust-policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trustPolicy: "open" }),
  });
  expect(res.status).toBe(401);
});
