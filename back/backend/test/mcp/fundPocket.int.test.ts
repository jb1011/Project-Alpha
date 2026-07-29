import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import type { EntityRecord } from "../../src/types";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";
import { startMcpTestClient } from "./helpers";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER_TENANT = "0x000000000000000000000000000000000000000B";

interface RecordedFundCall {
  entity: EntityRecord;
  amount: bigint;
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let app: ReturnType<typeof buildApiApp>;
let fundCalls: RecordedFundCall[];
let fundResult: string[] | (() => string[]);

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
  fundCalls = [];
  fundResult = ["0xabc"];
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  const fakePocketFunding = async (entity: EntityRecord, amount: bigint) => {
    fundCalls.push({ entity, amount });
    if (typeof fundResult === "function") return fundResult();
    return fundResult;
  };
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
    pocketFunding: fakePocketFunding,
  } as never);
});
afterEach(() => db.close());

test("fund_pocket with a read-capability key is denied and never reaches pocketFunding", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "read" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "fund_pocket",
      arguments: { id: `${TENANT}:agent1`, amountUsdc: "500000" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(fundCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test("fund_pocket on a cross-tenant entity id is uniform not-found and never calls pocketFunding", async () => {
  repoSeed(OTHER_TENANT, "secret");
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "fund_pocket",
      arguments: { id: `${OTHER_TENANT}:secret`, amountUsdc: "500000" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(fundCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test("fund_pocket with an entity-scoped key calling a DIFFERENT entity is uniform not-found and never calls pocketFunding", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { entityId: `${TENANT}:other`, capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "fund_pocket",
      arguments: { id: `${TENANT}:agent1`, amountUsdc: "500000" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(fundCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test.each([
  ["0", "amountUsdc must be positive"],
  ["-1", "amountUsdc must be positive"],
  ["1.5", "invalid amountUsdc"],
  ["abc", "invalid amountUsdc"],
  ["0x10", "invalid amountUsdc"],
  [" 100 ", "invalid amountUsdc"],
  ["1e6", "invalid amountUsdc"],
])(
  "fund_pocket rejects amountUsdc=%s without calling pocketFunding (%s)",
  async (amountUsdc, expectedText) => {
    repoSeed(TENANT, "agent1");
    const { key } = apiKeys.mint(TENANT, { capability: "spend" });
    const { client, close } = await startMcpTestClient(app, key);
    try {
      const res = await client.callTool({
        name: "fund_pocket",
        arguments: { id: `${TENANT}:agent1`, amountUsdc },
      });
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0]!.text).toBe(expectedText);
      expect(fundCalls).toHaveLength(0);
    } finally {
      await close();
    }
  },
);

test("fund_pocket happy path calls pocketFunding ONCE with the RESOLVED entity + amount", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "fund_pocket",
      arguments: { id: `${TENANT}:agent1`, amountUsdc: "500000" },
    });
    expect(res.isError).toBeFalsy();
    expect(fundCalls).toHaveLength(1);
    const call = fundCalls[0]!;
    expect(call.entity.idempotencyKey).toBe(`${TENANT}:agent1`);
    expect(call.amount).toBe(500000n);
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out).toEqual({ ok: true, txHashes: ["0xabc"] });
  } finally {
    await close();
  }
});

test("fund_pocket surfaces a thrown pocketFunding error as isError with the reason in the JSON body", async () => {
  repoSeed(TENANT, "agent1");
  fundResult = () => {
    throw new Error("insufficient treasury available");
  };
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "fund_pocket",
      arguments: { id: `${TENANT}:agent1`, amountUsdc: "500000" },
    });
    expect(res.isError).toBe(true);
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out).toEqual({ ok: false, reason: "insufficient treasury available" });
  } finally {
    await close();
  }
});

test("fund_pocket reports unavailable when pocketFunding is not configured, without touching the entity lookup outcome", async () => {
  repoSeed(TENANT, "agent1");
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  const appNoFunding = buildApiApp({
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
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  const { client, close } = await startMcpTestClient(appNoFunding, key);
  try {
    const res = await client.callTool({
      name: "fund_pocket",
      arguments: { id: `${TENANT}:agent1`, amountUsdc: "500000" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("pocket funding unavailable");
  } finally {
    await close();
  }
});
