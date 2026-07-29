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
import { TEST_FUND_CAPS } from "../helpers/fundCaps";
import { startMcpTestClient } from "./helpers";

// TENANT is the authenticated tenant — the tool forces roles.guardian = TENANT.
// PLATFORM_MANAGER is the platform manager address — the tool forces roles.manager to this,
// regardless of what the caller supplies (audit fix C).
// MANAGER (a WRONG guess a caller might supply) must differ from TENANT (guardian) per
// AgentSpecSchema superRefine — it never survives the override, but it must still parse.
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

// Minimal AgentSpec that passes AgentSpecSchema validation.
// guardian is intentionally set to MANAGER here, and manager to MANAGER too — the tool
// overwrites guardian with TENANT and manager with PLATFORM_MANAGER before validation, which is
// what makes it pass (TENANT !== PLATFORM_MANAGER so roles are distinct).
const VALID_SPEC = {
  name: "TestOnboardAgent",
  roles: {
    manager: MANAGER,
    guardian: MANAGER, // will be forced to TENANT by the tool — that satisfies manager !== guardian
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

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  passkeys = new SqlitePasskeyStore(db);
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
    passkeys,
    platformManagerAddress: PLATFORM_MANAGER,
  } as never);
});
afterEach(() => db.close());

// onboard_agent requires the "provision" capability (S1) — these tests exercise the happy path and
// its argument handling, not the capability gate itself (see actingToolGates.int.test.ts for that).

test("onboard_agent with a stored passkey handle starts the saga and returns pending", async () => {
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle },
    });
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out.status).toBe("pending");
    expect(typeof out.id).toBe("string");
  } finally {
    await close();
  }
});

test("onboard_agent overrides a caller-supplied wrong manager with the platform manager address", async () => {
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    // VALID_SPEC.roles.manager is MANAGER — a wrong guess. The tool must override it with
    // PLATFORM_MANAGER regardless (audit fix C), never letting the caller's guess through.
    const res = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle },
    });
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out.status).toBe("pending");
    const rec = repo.findByIdempotencyKey(out.id);
    expect(rec?.manager).toBe(PLATFORM_MANAGER);
    expect(rec?.manager).not.toBe(MANAGER);
  } finally {
    await close();
  }
});

test("onboard_agent with an omitted manager still resolves to the platform manager address", async () => {
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const { manager: _omit, ...rolesWithoutManager } = VALID_SPEC.roles;
    const specWithoutManager = { ...VALID_SPEC, roles: rolesWithoutManager };
    const res = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: specWithoutManager, passkeyId: handle },
    });
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out.status).toBe("pending");
    const rec = repo.findByIdempotencyKey(out.id);
    expect(rec?.manager).toBe(PLATFORM_MANAGER);
  } finally {
    await close();
  }
});

test("onboard_agent with an unknown passkey handle returns isError", async () => {
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: "nope" },
    });
    expect(res.isError).toBe(true);
  } finally {
    await close();
  }
});
