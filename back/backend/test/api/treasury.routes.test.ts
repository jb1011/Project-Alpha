import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
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

// Fake adapter: the route reads four values off it; canned numbers prove the response shape + scoping.
const FAKE_ARC = {
  usdcBalanceOf: async () => 1_500_000n, // 1.50 USDC actually held
  treasuryAvailable: async () => 800_000n, // 0.80 spendable this period
  treasuryPaused: async () => false,
  legalStatus: async () => 0, // 0 = Active (LegalManager status())
} as unknown as ArcAdapter;

// Fake standing-exposure reader (the S2 float-ceiling wiring, api/app.ts#ApiDeps.standingExposure):
// canned numbers distinct from FAKE_ARC's so the response shape is unambiguous in assertions.
const FAKE_STANDING_EXPOSURE = {
  read: async () => ({
    operatorEoa: 100_000n,
    pocketEoa: 50_000n,
    gateway: 200_000n,
    total: 350_000n,
  }),
  ceilingAtomic: "1000000",
};

let db: Database.Database;
let repo: SqliteEntityRepository;

function makeApp(opts?: { withStandingExposure?: boolean }) {
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
    arc: FAKE_ARC,
    standingExposure: opts?.withStandingExposure === false ? undefined : FAKE_STANDING_EXPOSURE,
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

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

test("GET /entities/:id/treasury → 200 real on-chain shape", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/treasury`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    usdcBalance: "1500000",
    available: "800000",
    cap: "1000000",
    period: "86400",
    paused: false,
    standing: {
      operatorEoa: "100000",
      pocketEoa: "50000",
      gateway: "200000",
      total: "350000",
      ceiling: "1000000",
    },
    legalActive: true,
  });
});

test("GET /entities/:id/treasury → legalActive false when legalStatus() is non-zero (suspended)", async () => {
  const app = buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner: new OnboardingRunner({
      repo,
      runSaga: async (i: { idempotencyKey: string }) =>
        repo.findByIdempotencyKey(i.idempotencyKey)!,
    }),
    passkeyRpId: "wizard.local",
    apiKeys: new SqliteApiKeyStore(db),
    arc: { ...FAKE_ARC, legalStatus: async () => 1 } as unknown as ArcAdapter,
    standingExposure: FAKE_STANDING_EXPOSURE,
  } as never);
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/treasury`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).legalActive).toBe(false);
});

test("GET /entities/:id/treasury → zeroed standing when standingExposure isn't configured (no POCKET_MASTER_SEED)", async () => {
  const app = makeApp({ withStandingExposure: false });
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/treasury`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.standing).toEqual({
    operatorEoa: "0",
    pocketEoa: "0",
    gateway: "0",
    total: "0",
    ceiling: "0",
  });
  expect(body.legalActive).toBe(true);
});

test("cross-tenant → 404", async () => {
  const app = makeApp();
  await login(app);
  seedBound(account.address, "a1");
  const otherToken = await login(app, otherAccount);
  const res = await app.request(
    `/entities/${encodeURIComponent(`${account.address}:a1`)}/treasury`,
    { headers: { authorization: `Bearer ${otherToken}` } },
  );
  expect(res.status).toBe(404);
});

test("no auth → 401", async () => {
  const app = makeApp();
  expect((await app.request("/entities/x/treasury")).status).toBe(401);
});
