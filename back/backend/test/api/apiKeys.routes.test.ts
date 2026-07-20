import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
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
let db: Database.Database;
let repo: SqliteEntityRepository;

function makeApp() {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
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
    apiKeys: new SqliteApiKeyStore(db),
  } as never);
  return app;
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

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

test("POST /api-keys → 201 returns plaintext key once; GET lists it without the secret", async () => {
  const app = makeApp();
  const token = await login(app);
  const created = await app.request("/api-keys", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "laptop" }),
  });
  expect(created.status).toBe(201);
  const { id, key } = await created.json();
  expect(key.startsWith("mcp_")).toBe(true);

  const listed = await app.request("/api-keys", { headers: { authorization: `Bearer ${token}` } });
  const views = await listed.json();
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ id, label: "laptop" });
  expect(JSON.stringify(views)).not.toContain(key);
});

test("DELETE /api-keys/:id → 204 and the key disappears from the list", async () => {
  const app = makeApp();
  const token = await login(app);
  const { id } = await (
    await app.request("/api-keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  const del = await app.request(`/api-keys/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(del.status).toBe(204);
  const views = await (
    await app.request("/api-keys", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(views[0].revokedAt).toBeTypeOf("number");
});

test("DELETE /api-keys/:id by a different tenant → 404 (cannot revoke another tenant's key)", async () => {
  const app = makeApp();
  const ownerToken = await login(app);
  const { id } = await (
    await app.request("/api-keys", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();

  const otherToken = await login(app, otherAccount);
  const del = await app.request(`/api-keys/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${otherToken}` },
  });
  expect(del.status).toBe(404);

  // The owner's key must still be active (verify it was NOT revoked).
  const views = await (
    await app.request("/api-keys", { headers: { authorization: `Bearer ${ownerToken}` } })
  ).json();
  expect(views[0].revokedAt).toBeNull();
});

test("no auth → 401", async () => {
  const app = makeApp();
  expect((await app.request("/api-keys")).status).toBe(401);
});

test("POST /api-keys with no capability given defaults to 'spend'", async () => {
  const app = makeApp();
  const token = await login(app);
  const created = await app.request("/api-keys", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(body.capability).toBe("spend");

  const listed = await app.request("/api-keys", { headers: { authorization: `Bearer ${token}` } });
  const views = await listed.json();
  expect(views[0]!.capability).toBe("spend");
});

test("POST /api-keys accepts an explicit 'provision' capability", async () => {
  const app = makeApp();
  const token = await login(app);
  const created = await app.request("/api-keys", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "provisioner", capability: "provision" }),
  });
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(body.capability).toBe("provision");

  const listed = await app.request("/api-keys", { headers: { authorization: `Bearer ${token}` } });
  const views = await listed.json();
  expect(views[0]!).toMatchObject({ label: "provisioner", capability: "provision" });
});

test("POST /api-keys with an unknown capability → 400", async () => {
  const app = makeApp();
  const token = await login(app);
  const res = await app.request("/api-keys", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ capability: "admin" }),
  });
  expect(res.status).toBe(400);
});
