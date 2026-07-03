import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteLinkCodeStore } from "../../src/persistence/linkCodeStore";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";
import { startMcpTestClient } from "./helpers";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER_TENANT = "0x000000000000000000000000000000000000000B";

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let linkCodes: SqliteLinkCodeStore;
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
  linkCodes = new SqliteLinkCodeStore(db);
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
    linkCodes,
  } as never);
});
afterEach(() => db.close());

test("claim_connection consumes a valid code and returns the binding confirmation (single-use)", async () => {
  const entityId = repoSeed(TENANT, "agent1");
  const code = linkCodes.issue(TENANT, Date.now(), 60_000);
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({ name: "claim_connection", arguments: { linkCode: code } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { text: string }[])[0]!.text;
    const out = JSON.parse(text);
    expect(out.tenantId).toBe(TENANT);
    expect(out.bound).toBe(true);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].id).toBe(entityId);
    // Confirmation only — never key material.
    expect(text).not.toContain(key);
    expect(text.toLowerCase()).not.toContain("mcp_");
    expect(text.toLowerCase()).not.toContain("apikey");

    // Second use of the same code: consumed, uniform error.
    const again = await client.callTool({
      name: "claim_connection",
      arguments: { linkCode: code },
    });
    expect(again.isError).toBe(true);
    expect((again.content as { text: string }[])[0]!.text).toBe("invalid or expired link code");
  } finally {
    await close();
  }
});

test("claim_connection with another tenant's code fails uniformly and does NOT burn the code", async () => {
  const code = linkCodes.issue(OTHER_TENANT, Date.now(), 60_000);
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({ name: "claim_connection", arguments: { linkCode: code } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("invalid or expired link code");
    // The owner can still consume it — the wrong-tenant attempt did not burn it.
    expect(linkCodes.consume(OTHER_TENANT, code, Date.now())).toBe(true);
  } finally {
    await close();
  }
});

test("claim_connection with an unknown code fails uniformly", async () => {
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "claim_connection",
      arguments: { linkCode: "no-such-code" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("invalid or expired link code");
  } finally {
    await close();
  }
});

test("claim_connection with an expired code fails uniformly", async () => {
  const code = linkCodes.issue(TENANT, Date.now(), -1); // already past its TTL
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({ name: "claim_connection", arguments: { linkCode: code } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("invalid or expired link code");
  } finally {
    await close();
  }
});
