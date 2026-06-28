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

// TENANT is the authenticated tenant — the tool forces roles.guardian = TENANT.
// MANAGER must differ from TENANT (guardian) per AgentSpecSchema superRefine.
const TENANT = "0x000000000000000000000000000000000000000A";
const MANAGER = "0x000000000000000000000000000000000000000C";
const PAYOUT = "0x000000000000000000000000000000000000000D";

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
// guardian is intentionally set to MANAGER here — the tool overwrites it with TENANT,
// which is what makes it pass (TENANT !== MANAGER so roles are distinct).
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
  } as never);
});
afterEach(() => db.close());

test("onboard_agent with a stored passkey handle starts the saga and returns pending", async () => {
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT);
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

test("onboard_agent with an unknown passkey handle returns isError", async () => {
  const { key } = apiKeys.mint(TENANT);
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
