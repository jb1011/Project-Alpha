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

const FAKE_VIEW = { available: "1000000", cap: "5000000", paused: false, allowlistEnabled: false };
const FAKE_PAYMENTS = {
  status: async () => FAKE_VIEW,
  pay: async () => ({ ok: true, txOrTransferId: null }),
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let app: ReturnType<typeof buildApiApp>;

function repoSeed(tenantId: string, userKey: string) {
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
    treasuryConfig: {
      usdc: "0x0000000000000000000000000000000000000002",
      payoutAddress: "0x000000000000000000000000000000000000000A",
      cap: 1000000000n,
      period: 86400n,
      allowlistEnabled: false,
    },
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
    payments: FAKE_PAYMENTS,
  } as never);
});
afterEach(() => db.close());

test("treasury_status returns the payment service's view for a tenant-wide key", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "treasury_status",
      arguments: { id: `${TENANT}:agent1` },
    });
    const view = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(view).toEqual(FAKE_VIEW);
  } finally {
    await close();
  }
});

test("treasury_status hides another tenant's entity (isError, uniform message)", async () => {
  repoSeed(OTHER_TENANT, "secret");
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "treasury_status",
      arguments: { id: `${OTHER_TENANT}:secret` },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("entity not found");
  } finally {
    await close();
  }
});

test("treasury_status on an unknown id is a uniform not-found", async () => {
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "treasury_status",
      arguments: { id: `${TENANT}:nope` },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("entity not found");
  } finally {
    await close();
  }
});

test("treasury_status with an entity-scoped key to a DIFFERENT entity is not found", async () => {
  const entityA1 = repoSeed(TENANT, "agent1");
  repoSeed(TENANT, "agent2");
  const { key } = apiKeys.mint(TENANT, { entityId: entityA1, capability: "read" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "treasury_status",
      arguments: { id: `${TENANT}:agent2` },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("entity not found");
  } finally {
    await close();
  }
});
