import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GuardianPasskey } from "../../src/adapters/turnkey/provisioner";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteLinkCodeStore } from "../../src/persistence/linkCodeStore";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";
import { startMcpTestClient } from "./helpers";

/**
 * S1 mint-surface test: a key minted via POST /bootstrap-connection with capability:"provision"
 * must (a) round-trip through verify() as "provision", and (b) actually pass BOTH acting-tool
 * gates over MCP — not just carry the right string. This is the real-world path a tenant uses to
 * self-provision (the bootstrap flow), as opposed to actingToolGates.int.test.ts which mints
 * directly via the store.
 */

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const PLATFORM_MANAGER = "0x000000000000000000000000000000000000000E";
const MANAGER_GUESS = "0x000000000000000000000000000000000000000C";
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

const VALID_SPEC = {
  name: "BootstrapProvisionAgent",
  roles: { manager: MANAGER_GUESS, guardian: MANAGER_GUESS },
  treasury: { payoutAddress: PAYOUT, spendingCapUsdc: "100.00", spendingPeriod: "30d" },
  governance: { amendmentDelay: "24h" },
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let passkeys: SqlitePasskeyStore;
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

async function login(a: ReturnType<typeof buildApiApp>) {
  const nonce = (await (await a.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = await account.signMessage({ message });
  const body = await (
    await a.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    })
  ).json();
  return body.token as string;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  passkeys = new SqlitePasskeyStore(db);
  linkCodes = new SqliteLinkCodeStore(db);
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  app = buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    platformManagerAddress: PLATFORM_MANAGER,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys,
    passkeys,
    linkCodes,
    mcpPublicUrl: "https://mcp.example.com/mcp",
  } as never);
});
afterEach(() => db.close());

test("POST /bootstrap-connection with capability:'provision' mints a key that passes both acting-tool gates end-to-end", async () => {
  const jwt = await login(app);
  const entityId = repoSeed(account.address, "agent1");
  const guardianPasskeyId = passkeys.store(account.address, VALID_PASSKEY);

  const res = await app.request("/bootstrap-connection", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({ passkeyId: guardianPasskeyId, capability: "provision" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.capability).toBe("provision");

  // verify() returns the capability as "provision"...
  expect(apiKeys.verify(body.apiKey)).toMatchObject({
    tenantId: account.address,
    entityId: null,
    capability: "provision",
  });

  // ...and the key actually WORKS against both acting tools over a live MCP connection.
  const { client, close } = await startMcpTestClient(app, body.apiKey);
  try {
    const fundRes = await client.callTool({
      name: "fund_treasury",
      arguments: { id: entityId, amount: "1000000" },
    });
    expect(fundRes.isError).toBeFalsy();

    const onboardRes = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: guardianPasskeyId },
    });
    expect(onboardRes.isError).toBeFalsy();
    const onboardOut = JSON.parse((onboardRes.content as { text: string }[])[0]!.text);
    expect(onboardOut.status).toBe("pending");
  } finally {
    await close();
  }
});
