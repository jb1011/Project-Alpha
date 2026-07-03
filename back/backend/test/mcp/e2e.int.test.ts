import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  http,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import type { GuardianPasskey } from "../../src/adapters/turnkey/provisioner";
import { LocalKeySigner, type OperatorSigner } from "../../src/adapters/turnkey/signer";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { anvilChain } from "../../src/chains";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { runOnboarding } from "../../src/workflow/onboarding";
import { OnboardingRunner, type RunSaga } from "../../src/workflow/runner";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { deployStack } from "../helpers/stack";
import { startMcpTestClient } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Anvil bootstrap — reused verbatim from test/onboarding.int.test.ts.
// The same canonical accounts the mock registry/factory + saga accept:
//   manager  = KEYS[0]   (the wallet that sends txs)
//   guardian = KEYS[1]   == TENANT (the onboard_agent tool forces roles.guardian = TENANT)
//   operator = KEYS[2]   (the signer; distinct from manager/guardian for assertOperatorDistinct)
//   payout   = KEYS[3]
// ─────────────────────────────────────────────────────────────────────────────
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;
const manager = privateKeyToAccount(KEYS[0]);
const guardian = privateKeyToAccount(KEYS[1]).address;
const operatorSigner = new LocalKeySigner(KEYS[2]);
const payout = privateKeyToAccount(KEYS[3]).address;

// TENANT is the authenticated tenant; the onboard_agent tool forces roles.guardian = TENANT,
// so TENANT MUST be the guardian address the anvil mock + saga accept.
const TENANT = guardian;
const OTHER_TENANT = "0x000000000000000000000000000000000000bEEF";

// Guardian passkey fixture — only its presence drives the provision path; the FAKE provision below
// ignores the attestation and returns the real operator key, so the on-chain bind validates.
const VALID_PASSKEY: GuardianPasskey = {
  authenticatorName: "Guardian Passkey",
  challenge: "Y2hhbGxlbmdl",
  attestation: {
    credentialId: "cred-1",
    clientDataJson: "e30=",
    attestationObject: "o2M=",
    transports: ["internal"],
  },
};

// Minimal AgentSpec accepted by AgentSpecSchema. guardian here is set to manager (a placeholder);
// the onboard_agent tool overwrites roles.guardian with TENANT (which != manager => roles distinct).
const VALID_SPEC = {
  name: "E2EAgent",
  roles: { manager: manager.address, guardian: manager.address },
  treasury: {
    payoutAddress: payout,
    spendingCapUsdc: "1000.00",
    spendingPeriod: "30d",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "1h" },
};

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
let pub: PublicClient;
let wallet: WalletClient;
let docStore: FileDocumentStore;

beforeAll(async () => {
  anvil = await startAnvil(8549);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
  docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "saga-mcp-e2e-")));
}, 40_000);
afterAll(() => anvil?.stop());

// Fresh DB + stores + REAL runner + app per test (the anvil/adapter are shared, the state is not).
let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let passkeys: SqlitePasskeyStore;
let runner: OnboardingRunner;
let app: ReturnType<typeof buildApiApp>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  passkeys = new SqlitePasskeyStore(db);

  // FAKE provisioning (no real Turnkey): the per-agent vault returns the SHARED operator key, and
  // signerForEntity hands back the real operatorSigner — so createEntity records the operator the
  // anvil mock binds, and the bind step signs with a key the mock accepts. This mirrors the live
  // runSaga in src/api/main.ts but swaps the Turnkey provision/signerForEntity seams for the local
  // signer, which is exactly the substitution the saga's provision seam exists to allow.
  const provision = async () => ({
    subOrgId: "fake-suborg",
    walletId: "fake-wallet",
    operator: operatorSigner.address,
  });
  const signerForEntity = async (): Promise<OperatorSigner> => operatorSigner;

  const runSaga: RunSaga = (i) =>
    runOnboarding({
      spec: i.spec,
      idempotencyKey: i.idempotencyKey,
      repo,
      docStore,
      arc: adapter,
      operatorSigner,
      usdc: stack.usdc,
      ownerTenantId: i.tenantId,
      specJson: i.specJson,
      fundAmount: i.fundAmount,
      guardianPasskey: i.guardianPasskey,
      provision,
      signerForEntity,
    });

  runner = new OnboardingRunner({ repo, runSaga });
  app = buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: "wizard.local",
    chainId: anvilChain.id,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    platformManagerAddress: manager.address,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys,
    passkeys,
  } as never);
});
afterEach(async () => {
  await runner.settled();
  db.close();
});

function repoSeed(tenantId: string, userKey: string) {
  const entityId = `${tenantId}:${userKey}`;
  repo.upsert({
    idempotencyKey: entityId,
    name: "SeededAgent",
    status: "bound",
    manager: manager.address,
    guardian: tenantId as `0x${string}`,
    operator: operatorSigner.address,
    amendmentDelay: "86400",
    ein: "12-3456789",
    formationDate: 1700000000,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: {
      usdc: stack.usdc,
      payoutAddress: tenantId as `0x${string}`,
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

test("end-to-end: mint key, store passkey, onboard_agent, poll get_entity to bound", async () => {
  const passkeyId = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const start = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId },
    });
    expect(start.isError).toBeFalsy();
    const { id, status: startStatus } = JSON.parse((start.content as { text: string }[])[0]!.text);
    expect(startStatus).toBe("pending");
    expect(typeof id).toBe("string");

    // Poll get_entity over MCP until the saga reaches a terminal state.
    let status = "pending";
    for (let i = 0; i < 60 && !["bound", "funded", "failed"].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 500));
      const got = await client.callTool({ name: "get_entity", arguments: { id } });
      status = JSON.parse((got.content as { text: string }[])[0]!.text).status;
    }
    expect(status).toBe("bound");

    // The entity bound on-chain to the real operator key.
    const got = await client.callTool({ name: "get_entity", arguments: { id } });
    const view = JSON.parse((got.content as { text: string }[])[0]!.text);
    expect(view.guardian.toLowerCase()).toBe(TENANT.toLowerCase());
    expect(view.operator.toLowerCase()).toBe(operatorSigner.address.toLowerCase());
    expect((await adapter.getAgentWallet(BigInt(view.agentId))).toLowerCase()).toBe(
      operatorSigner.address.toLowerCase(),
    );
  } finally {
    await close();
  }
}, 60_000);

test("tenant isolation: a second tenant's key cannot see the first tenant's entity", async () => {
  repoSeed(TENANT, "agent1");
  const { key: otherKey } = apiKeys.mint(OTHER_TENANT);
  const { client, close } = await startMcpTestClient(app, otherKey);
  try {
    const list = await client.callTool({ name: "list_entities", arguments: {} });
    expect(JSON.parse((list.content as { text: string }[])[0]!.text)).toHaveLength(0);

    const get = await client.callTool({
      name: "get_entity",
      arguments: { id: `${TENANT}:agent1` },
    });
    expect(get.isError).toBe(true);
  } finally {
    await close();
  }
});
