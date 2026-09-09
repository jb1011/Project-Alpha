import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { MCP_TOOL_DEP_KEYS } from "../../src/mcp/server";
import { mcpToolDepsOf } from "../../src/mcp/transport";
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

/**
 * THE TRANSPORT COPIES THE WHOLE DEPENDENCY SET (design §7, C8).
 *
 * It used to name each field by hand, and a hand-written pick is a subset by default. It dropped
 * the document index first — `get_entity` over MCP described an entity with no legal documents
 * while `GET /entities/:id` described the same entity with two, and nothing failed — then A3's
 * `sharedWith` the same way, then `now`, the injectable clock every REST surface honours.
 *
 * `MCP_TOOL_DEP_KEYS` is compile-checked against `McpToolDeps` beside the interface, so a new
 * field cannot be silently dropped. This asserts the RUNTIME half: the copy really carries every
 * key it names, and the one deliberate narrowing really narrows.
 */
test("mcpToolDepsOf copies every listed key, `now` included", () => {
  const deps = {
    now: () => 1_234_567,
    repo: { marker: "repo" },
    companies: { marker: "companies" },
    documents: { marker: "documents" },
    companyAgents: { marker: "companyAgents" },
    formationSteps: () => [],
    // A field the MCP layer does not take: it must not appear in the copy.
    docStore: { marker: "docStore" },
    jwtSecret: "not-for-mcp",
  } as unknown as Parameters<typeof mcpToolDepsOf>[0];

  const picked = mcpToolDepsOf(deps) as unknown as Record<string, unknown>;
  for (const key of MCP_TOOL_DEP_KEYS) expect(Object.hasOwn(picked, key), key).toBe(true);
  // The clock, by value — the field whose omission this test exists for.
  expect((picked.now as () => number)()).toBe(1_234_567);
  expect(picked.repo).toBe(deps.repo);
  expect(picked.documents).toBe(deps.documents);
  expect(picked.companyAgents).toBe(deps.companyAgents);
  // …and nothing the MCP layer never asked for.
  expect(picked).not.toHaveProperty("docStore");
  expect(picked).not.toHaveProperty("jwtSecret");
});

test("`ens` is NARROWED, never copied — the MCP layer must not hold the gateway's signer", () => {
  // `ApiDeps["ens"]` carries the CCIP resolver's private-key account. `resolve_agent` needs four
  // scalars off it, and copying the object whole would hand a signing key to a layer with no use
  // for one. The narrowing is why `ens` is excluded from the key list by name.
  const signer = { marker: "PRIVATE-KEY-ACCOUNT" };
  const deps = {
    ens: {
      signer,
      parentName: "novicorpus.eth",
      metadataBaseUrl: "https://example.test/metadata",
      identityRegistry: "0x0000000000000000000000000000000000000001",
      chainId: 5042002,
      labelAliases: { demo: "public-id" },
    },
  } as unknown as Parameters<typeof mcpToolDepsOf>[0];

  const { ens } = mcpToolDepsOf(deps);
  expect(ens).toEqual({
    parentName: "novicorpus.eth",
    identityRegistry: "0x0000000000000000000000000000000000000001",
    chainId: 5042002,
    labelAliases: { demo: "public-id" },
  });
  expect(JSON.stringify(ens)).not.toContain("PRIVATE-KEY-ACCOUNT");
  expect(MCP_TOOL_DEP_KEYS as readonly string[]).not.toContain("ens");

  // A deployment with no ENS wiring gets `undefined`, not a half-built object.
  expect(mcpToolDepsOf({} as Parameters<typeof mcpToolDepsOf>[0]).ens).toBeUndefined();
});
