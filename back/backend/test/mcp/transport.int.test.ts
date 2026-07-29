import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";
import { startMcpTestClient } from "./helpers";

const TENANT = "0x000000000000000000000000000000000000000A";
let db: Database.Database;
let apiKeys: SqliteApiKeyStore;
let app: ReturnType<typeof buildApiApp>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
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

test("a valid api key connects and whoami returns the tenant", async () => {
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("whoami");
    const res = await client.callTool({ name: "whoami", arguments: {} });
    expect((res.content as { text: string }[])[0]!.text).toBe(TENANT);
  } finally {
    await close();
  }
});

test("an invalid api key is rejected (connect/list fails)", async () => {
  await expect(
    (async () => {
      const { client } = await startMcpTestClient(app, "mcp_bogus");
      await client.listTools();
    })(),
  ).rejects.toThrow();
});
