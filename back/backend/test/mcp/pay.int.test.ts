import { readFileSync } from "node:fs";
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

interface RecordedPayCall {
  entity: unknown;
  args: unknown;
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let app: ReturnType<typeof buildApiApp>;
let payCalls: RecordedPayCall[];
let payReceipt: { ok: boolean; txOrTransferId: string | null; reason?: string };

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
  payCalls = [];
  payReceipt = { ok: true, txOrTransferId: "0xabc" };
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  const FAKE_PAYMENTS = {
    status: async () => ({ available: "0", cap: "0", paused: false, allowlistEnabled: false }),
    pay: async (entity: unknown, args: unknown) => {
      payCalls.push({ entity, args });
      return payReceipt;
    },
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
    payments: FAKE_PAYMENTS,
  } as never);
});
afterEach(() => db.close());

test("pay with a read-capability key is denied and never reaches the payment service", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "read" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "pay",
      arguments: {
        id: `${TENANT}:agent1`,
        to: "https://example.com/resource",
        amountUsdc: "100000",
        idempotencyKey: "idem-1",
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(payCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test("pay with a spend-capability key proceeds to the payment service", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "pay",
      arguments: {
        id: `${TENANT}:agent1`,
        to: "https://example.com/resource",
        amountUsdc: "100000",
        idempotencyKey: "idem-2",
      },
    });
    expect(res.isError).toBe(false);
    expect(payCalls).toHaveLength(1);
  } finally {
    await close();
  }
});

test("pay on a cross-tenant entity id is uniform not-found and never calls the payment service", async () => {
  repoSeed(OTHER_TENANT, "secret");
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "pay",
      arguments: {
        id: `${OTHER_TENANT}:secret`,
        to: "https://example.com/resource",
        amountUsdc: "100000",
        idempotencyKey: "idem-3",
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(payCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test("pay with an entity-scoped key calling a DIFFERENT entity is uniform not-found and never calls the payment service", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { entityId: `${TENANT}:other`, capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "pay",
      arguments: {
        id: `${TENANT}:agent1`,
        to: "https://example.com/resource",
        amountUsdc: "100000",
        idempotencyKey: "idem-4",
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("not found");
    expect(payCalls).toHaveLength(0);
  } finally {
    await close();
  }
});

test.each(["0", "-1", "1.5", "abc"])(
  "pay rejects amountUsdc=%s without calling the payment service",
  async (amountUsdc) => {
    repoSeed(TENANT, "agent1");
    const { key } = apiKeys.mint(TENANT, { capability: "spend" });
    const { client, close } = await startMcpTestClient(app, key);
    try {
      const res = await client.callTool({
        name: "pay",
        arguments: {
          id: `${TENANT}:agent1`,
          to: "https://example.com/resource",
          amountUsdc,
          idempotencyKey: "idem-invalid",
        },
      });
      expect(res.isError).toBe(true);
      expect(payCalls).toHaveLength(0);
    } finally {
      await close();
    }
  },
);

test("pay happy path delegates the RESOLVED entity record and args to the payment service", async () => {
  repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  const to = "https://example.com/resource";
  try {
    const res = await client.callTool({
      name: "pay",
      arguments: {
        id: `${TENANT}:agent1`,
        to,
        amountUsdc: "100000",
        idempotencyKey: "idem-happy",
      },
    });
    expect(res.isError).toBe(false);
    expect(payCalls).toHaveLength(1);
    const call = payCalls[0]!;
    expect((call.entity as { idempotencyKey: string }).idempotencyKey).toBe(`${TENANT}:agent1`);
    expect(call.args).toEqual({
      url: to,
      amountUsdc: 100000n,
      idempotencyKey: "idem-happy",
      tenantId: TENANT,
    });
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out).toEqual(payReceipt);
  } finally {
    await close();
  }
});

test("pay surfaces a failed receipt as isError with the reason in the JSON body", async () => {
  repoSeed(TENANT, "agent1");
  payReceipt = { ok: false, txOrTransferId: null, reason: "over-cap" };
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "pay",
      arguments: {
        id: `${TENANT}:agent1`,
        to: "https://example.com/resource",
        amountUsdc: "100000",
        idempotencyKey: "idem-fail",
      },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain("over-cap");
  } finally {
    await close();
  }
});

test("chokepoint (§14.2): server.ts imports no signer — pay's only payment path is deps.payments.pay", () => {
  const src = readFileSync(new URL("../../src/mcp/server.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/makeSignX402|signX402|pocketSigner/);
});
