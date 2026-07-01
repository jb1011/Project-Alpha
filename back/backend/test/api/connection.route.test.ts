import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";
import { OnboardingRunner } from "../../src/workflow/runner";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const MCP_URL = "https://mcp.example.com/mcp";

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;

function makeApp() {
  const runSaga = async (i: { idempotencyKey: string }): Promise<EntityRecord> => {
    const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
    const bound = { ...cur, status: "bound" as const, agentId: "5" };
    repo.upsert(bound);
    return bound;
  };
  const runner = new OnboardingRunner({ repo, runSaga });
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
    apiKeys,
    mcpPublicUrl: MCP_URL,
  } as never);
  return { app, runner };
}

async function login(app: ReturnType<typeof buildApiApp>, signer = account) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: signer.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = await signer.signMessage({ message });
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
  apiKeys = new SqliteApiKeyStore(db);
});
afterEach(() => db.close());

test("mints an entity-scoped connection package for an owned entity", async () => {
  const { app } = makeApp();
  const jwt = await login(app);
  repo.upsert({
    idempotencyKey: "ent-1",
    name: "ConnTestEntity",
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: account.address,
    operator: null,
    amendmentDelay: "86400",
    ein: "00-0000000",
    formationDate: Math.floor(Date.now() / 1000),
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: null,
    proxy: null,
    treasury: null,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: account.address,
  } as EntityRecord);

  const res = await app.request("/connection-package", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({ entityId: "ent-1", capability: "spend" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entityId).toBe("ent-1");
  expect(body.apiKey).toMatch(/^mcp_/);
  expect(body.snippets.claudeCode).toContain(body.apiKey);
  // the minted key is scoped to the entity + capability
  expect(apiKeys.verify(body.apiKey)).toMatchObject({
    tenantId: account.address,
    entityId: "ent-1",
    capability: "spend",
  });
});

test("404 (uniform) when the entity is not owned by the caller", async () => {
  const { app } = makeApp();
  const jwt = await login(app);

  const res = await app.request("/connection-package", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({ entityId: "someone-elses-entity" }),
  });
  expect(res.status).toBe(404);
});
