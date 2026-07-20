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
  } as never);
});
afterEach(() => db.close());

test("list_entities returns only the caller tenant's entities", async () => {
  repoSeed(TENANT, "agent1");
  repoSeed(OTHER_TENANT, "agentX");
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({ name: "list_entities", arguments: {} });
    const views = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe(`${TENANT}:agent1`);
  } finally {
    await close();
  }
});

test("get_entity hides another tenant's entity (isError)", async () => {
  repoSeed(OTHER_TENANT, "secret");
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "get_entity",
      arguments: { id: `${OTHER_TENANT}:secret` },
    });
    expect(res.isError).toBe(true);
  } finally {
    await close();
  }
});

test("an entity-scoped key lists ONLY its entity (not same-tenant siblings)", async () => {
  repoSeed(TENANT, "agent1");
  repoSeed(TENANT, "agent2");
  const { key } = apiKeys.mint(TENANT, { entityId: `${TENANT}:agent1`, capability: "read" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({ name: "list_entities", arguments: {} });
    const views = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe(`${TENANT}:agent1`);
  } finally {
    await close();
  }
});

test("an entity-scoped key cannot get_entity a same-tenant sibling (uniform not found)", async () => {
  repoSeed(TENANT, "agent1");
  repoSeed(TENANT, "agent2");
  const { key } = apiKeys.mint(TENANT, { entityId: `${TENANT}:agent1`, capability: "read" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const sibling = await client.callTool({
      name: "get_entity",
      arguments: { id: `${TENANT}:agent2` },
    });
    expect(sibling.isError).toBe(true);
    expect((sibling.content as { text: string }[])[0]!.text).toBe("entity not found");
    // ...but its own entity is still reachable
    const own = await client.callTool({
      name: "get_entity",
      arguments: { id: `${TENANT}:agent1` },
    });
    expect(own.isError).toBeFalsy();
  } finally {
    await close();
  }
});

test("fund_treasury on a bound entity returns a status", async () => {
  repoSeed(TENANT, "agent1");
  // fund_treasury requires the "provision" capability (S1).
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "fund_treasury",
      arguments: { id: `${TENANT}:agent1`, amount: "1000000" },
    });
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out.id).toBe(`${TENANT}:agent1`);
  } finally {
    await close();
  }
});

test("schema://agent-spec resource returns the AgentSpec JSON schema", async () => {
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const r = await client.readResource({ uri: "schema://agent-spec" });
    const schema = JSON.parse((r.contents as { text: string }[])[0]!.text);
    expect(schema).toHaveProperty("properties");
  } finally {
    await close();
  }
});
