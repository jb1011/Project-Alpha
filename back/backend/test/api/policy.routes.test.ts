import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { usdToUnits } from "../../src/policy/units";
import { OnboardingRunner } from "../../src/workflow/runner";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const otherAccount = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";
const POLICY_ID = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const PAYOUT_ADDR = "0x000000000000000000000000000000000000000A";

let db: Database.Database;
let repo: SqliteEntityRepository;

// Stub arc: captures calls, returns predictable hash
let lastScheduleArgs: unknown;
let lastExecuteArgs: unknown;

const STUB_ARC = {
  schedulePolicyUpdate: vi.fn(async (_treasury: unknown, p: unknown) => {
    lastScheduleArgs = p;
    return FAKE_HASH;
  }),
  executePolicyUpdate: vi.fn(async (_treasury: unknown, policyId: unknown) => {
    lastExecuteArgs = policyId;
    return FAKE_HASH;
  }),
  // treasury route needs these for shared app:
  usdcBalanceOf: async () => 0n,
  treasuryAvailable: async () => 0n,
  treasuryPaused: async () => false,
} as unknown as ArcAdapter;

function makeApp() {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
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
    arc: STUB_ARC,
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

function seedBound(tenant: string, key: string, withTreasury = true) {
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
      payoutAddress: PAYOUT_ADDR,
      cap: 1_000_000n,
      period: 86_400n,
      allowlistEnabled: false,
    },
    agentId: "42",
    proxy: null,
    treasury: withTreasury ? "0x000000000000000000000000000000000000000F" : null,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: tenant,
  });
  return id;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  vi.clearAllMocks();
  lastScheduleArgs = undefined;
  lastExecuteArgs = undefined;
});
afterEach(() => db.close());

// ── POST /entities/:id/policy (schedule) ────────────────────────────────────

test("POST /entities/:id/policy → 200 { txHash }, stub receives correct args", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "p1");

  const res = await app.request(`/entities/${encodeURIComponent(id)}/policy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      capUsdc: "200.00",
      periodSeconds: 86400,
      allowlistOn: false,
      payoutAddress: PAYOUT_ADDR,
    }),
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ txHash: FAKE_HASH });

  expect(lastScheduleArgs).toMatchObject({
    newCap: usdToUnits("200.00"),
    newPeriod: 86400n,
    allowlistOn: false,
    newPayout: PAYOUT_ADDR,
  });
});

test("POST /entities/:id/policy cross-tenant → 404", async () => {
  const app = makeApp();
  seedBound(account.address, "p1");
  const otherToken = await login(app, otherAccount);

  const res = await app.request(`/entities/${encodeURIComponent(`${account.address}:p1`)}/policy`, {
    method: "POST",
    headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      capUsdc: "200.00",
      periodSeconds: 86400,
      allowlistOn: false,
      payoutAddress: PAYOUT_ADDR,
    }),
  });
  expect(res.status).toBe(404);
});

test("POST /entities/:id/policy no auth → 401", async () => {
  const app = makeApp();
  const res = await app.request("/entities/x/policy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capUsdc: "200.00",
      periodSeconds: 86400,
      allowlistOn: false,
      payoutAddress: PAYOUT_ADDR,
    }),
  });
  expect(res.status).toBe(401);
});

test("POST /entities/:id/policy invalid body (bad cap) → 400", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "p1");

  const res = await app.request(`/entities/${encodeURIComponent(id)}/policy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      capUsdc: "not-a-number",
      periodSeconds: 86400,
      allowlistOn: false,
      payoutAddress: PAYOUT_ADDR,
    }),
  });
  expect(res.status).toBe(400);
});

test("POST /entities/:id/policy treasury not deployed → 409", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "p1", false); // no treasury

  const res = await app.request(`/entities/${encodeURIComponent(id)}/policy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      capUsdc: "200.00",
      periodSeconds: 86400,
      allowlistOn: false,
      payoutAddress: PAYOUT_ADDR,
    }),
  });
  expect(res.status).toBe(409);
});

// ── POST /entities/:id/policy/execute ───────────────────────────────────────

test("POST /entities/:id/policy/execute → 200 { txHash }, stub receives policyId", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "p1");

  const res = await app.request(`/entities/${encodeURIComponent(id)}/policy/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ policyId: POLICY_ID }),
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ txHash: FAKE_HASH });
  expect(lastExecuteArgs).toBe(POLICY_ID);
});

test("POST /entities/:id/policy/execute invalid policyId → 400", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "p1");

  const res = await app.request(`/entities/${encodeURIComponent(id)}/policy/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ policyId: "not-a-hex" }),
  });
  expect(res.status).toBe(400);
});
