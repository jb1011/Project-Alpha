import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GuardianPasskey } from "../../src/adapters/turnkey/provisioner";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";
import { startMcpTestClient } from "./helpers";

// TENANT is the authenticated tenant — onboard_agent forces roles.guardian = TENANT.
// MANAGER must differ from TENANT (guardian) per AgentSpecSchema superRefine.
const TENANT = "0x000000000000000000000000000000000000000A";
const MANAGER = "0x000000000000000000000000000000000000000C";
const PAYOUT = "0x000000000000000000000000000000000000000D";
const PLATFORM_MANAGER = "0x000000000000000000000000000000000000000E";

const VALID_PASSKEY: GuardianPasskey = {
  authenticatorName: "Test Key",
  challenge: "Y2hhbGxlbmdl",
  attestation: {
    credentialId: "cred-1",
    clientDataJson: "e30=",
    attestationObject: "o2M=",
    transports: ["internal"],
  },
};

const VALID_SPEC = {
  name: "TestGateAgent",
  roles: {
    manager: MANAGER,
    guardian: MANAGER, // forced to TENANT by the tool
  },
  treasury: {
    payoutAddress: PAYOUT,
    spendingCapUsdc: "100.00",
    spendingPeriod: "30d",
  },
  governance: {
    amendmentDelay: "24h",
  },
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let passkeys: SqlitePasskeyStore;
let app: ReturnType<typeof buildApiApp>;

/** Seed a bound entity owned by TENANT so fund_treasury has something to act on. */
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
  passkeys = new SqlitePasskeyStore(db);
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
    platformManagerAddress: PLATFORM_MANAGER,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys,
    passkeys,
  } as never);
});
afterEach(() => db.close());

test("read key: fund_treasury and onboard_agent are both denied", async () => {
  const entityA1 = repoSeed(TENANT, "agent1");
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "read" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const fundRes = await client.callTool({
      name: "fund_treasury",
      arguments: { id: entityA1, amount: "1000000" },
    });
    expect(fundRes.isError).toBe(true);

    const onboardRes = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle },
    });
    expect(onboardRes.isError).toBe(true);
  } finally {
    await close();
  }
});

test("entity-scoped key (different entity): fund_treasury and onboard_agent are both denied", async () => {
  const entityA1 = repoSeed(TENANT, "agent1");
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  // capability: "provision" isolates this test to the ENTITY-SCOPE gate (not the capability gate) —
  // the key has the top capability rung but is scoped to a different entity, so it must still be denied.
  const { key } = apiKeys.mint(TENANT, {
    entityId: `${TENANT}:other`,
    capability: "provision",
  });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const fundRes = await client.callTool({
      name: "fund_treasury",
      arguments: { id: entityA1, amount: "1000000" },
    });
    expect(fundRes.isError).toBe(true);

    // onboard_agent has no entity yet (it creates one) — it must be denied for any
    // non-tenant-wide (entityId !== null) key, regardless of which entity it's scoped to.
    const onboardRes = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle },
    });
    expect(onboardRes.isError).toBe(true);
  } finally {
    await close();
  }
});

test("tenant-wide spend key: fund_treasury and onboard_agent are both denied (S1: spend no longer provisions)", async () => {
  const entityA1 = repoSeed(TENANT, "agent1");
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const fundRes = await client.callTool({
      name: "fund_treasury",
      arguments: { id: entityA1, amount: "1000000" },
    });
    expect(fundRes.isError).toBe(true);
    expect((fundRes.content as { text: string }[])[0]!.text).toBe("not found");

    const onboardRes = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle },
    });
    expect(onboardRes.isError).toBe(true);
    expect((onboardRes.content as { text: string }[])[0]!.text).toBe("not authorized");
  } finally {
    await close();
  }
});

test("tenant-wide provision key: fund_treasury and onboard_agent both succeed (the migrated-bootstrap-key equivalence)", async () => {
  const entityA1 = repoSeed(TENANT, "agent1");
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const fundRes = await client.callTool({
      name: "fund_treasury",
      arguments: { id: entityA1, amount: "1000000" },
    });
    expect(fundRes.isError).toBeFalsy();
    const fundOut = JSON.parse((fundRes.content as { text: string }[])[0]!.text);
    expect(fundOut.id).toBe(entityA1);

    const onboardRes = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle },
    });
    expect(onboardRes.isError).toBeFalsy();
    const onboardOut = JSON.parse((onboardRes.content as { text: string }[])[0]!.text);
    expect(onboardOut.status).toBe("pending");
  } finally {
    await close();
  }
});

test("entity-scoped provision key: fund_treasury on its own entity passes the gate; onboard_agent is still rejected (tenant-wide gate)", async () => {
  const entityA1 = repoSeed(TENANT, "agent1");
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { entityId: entityA1, capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const fundRes = await client.callTool({
      name: "fund_treasury",
      arguments: { id: entityA1, amount: "1000000" },
    });
    expect(fundRes.isError).toBeFalsy();
    const fundOut = JSON.parse((fundRes.content as { text: string }[])[0]!.text);
    expect(fundOut.id).toBe(entityA1);

    // onboard_agent always requires a tenant-wide key (entityId === null) — even at the top
    // capability rung, an entity-scoped key can never create a new entity.
    const onboardRes = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle },
    });
    expect(onboardRes.isError).toBe(true);
    expect((onboardRes.content as { text: string }[])[0]!.text).toBe("not authorized");
  } finally {
    await close();
  }
});

test("fund_treasury rejects a malformed or negative amount before ever calling runner.fund", async () => {
  const entityA1 = repoSeed(TENANT, "agent1");
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const hexRes = await client.callTool({
      name: "fund_treasury",
      arguments: { id: entityA1, amount: "0x10" },
    });
    expect(hexRes.isError).toBe(true);
    expect((hexRes.content as { text: string }[])[0]!.text).toBe("invalid amount");

    const negRes = await client.callTool({
      name: "fund_treasury",
      arguments: { id: entityA1, amount: "-5" },
    });
    expect(negRes.isError).toBe(true);
    expect((negRes.content as { text: string }[])[0]!.text).toBe("amount must be positive");

    // The entity is still in its pre-fund state — neither malformed call reached runner.fund.
    const rec = repo.findByIdempotencyKey(entityA1);
    expect(rec?.status).toBe("bound");
  } finally {
    await close();
  }
});
