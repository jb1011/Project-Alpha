/**
 * Smoke test for buildJobDeps — verifies the composition root builds without throwing
 * and returns the expected interface. No chain calls are made.
 */
import Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import type { Config } from "../../src/config/env";
import { buildJobDeps } from "../../src/jobs/composition";
import { migrate } from "../../src/persistence/db";
import type { DocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { makeFakeDocStore } from "../helpers/runJobDeps";

// Four DISTINCT valid secp256k1 private keys (these are Anvil test keys — safe for tests).
// Distinct on purpose: a fixture that reused the platform key for the job client or the customer
// would be asserting exactly the arrangement this config no longer allows.
const PLATFORM_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const EVALUATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const JOB_CLIENT_KEY =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
const CUSTOMER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const;

function makeConfig(): Config {
  return {
    rpcUrl: "https://rpc.testnet.arc.network",
    chainId: 5042002,
    platformPrivateKey: PLATFORM_KEY,
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    usdc: "0x3600000000000000000000000000000000000000",
    factoryAddress: undefined,
    guardianAddress: undefined,
    operatorPrivateKey: undefined,
    pocketMasterSeed: undefined,
    dataDir: "./data",
    dbPath: ":memory:",
    docStoreDir: "/tmp/test-docs",
    turnkey: undefined,
    circleApiKey: undefined,
    anthropicApiKey: undefined,
    agentModel: "claude-sonnet-4-6",
    gatewayFacilitatorUrl: "https://gateway-api-testnet.circle.com",
    fundingFloatUsdc: "0.50",
    maxPocketFloatUsdc: "1.00",
    spendAllowlistThreshold: 1_000_000n,
    maxJobBudget: 5_000_000n,
    maxInflightJobsPerTenant: 3,
    maxTreasuryFund: 25_000_000n,
    maxTreasuryFundedPerTenant: 100_000_000n,
    customerPrivateKey: CUSTOMER_KEY,
    authJwtSecret: "dev-insecure-secret-change-me-please",
    authJwtTtlSec: 3600,
    webOrigin: "*",
    siweDomain: "localhost",
    passkeyRpId: "localhost",
    jobContract: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    jobClientPrivateKey: JOB_CLIENT_KEY,
    jobEvaluatorPrivateKey: EVALUATOR_KEY,
    jobSweepToTreasury: false,
    mcpPublicUrl: "http://localhost:8789/mcp",
    metadataBaseUrl: "http://localhost:8789",
    gasSeedFloorUsdc: "0.05",
    gasSeedTargetUsdc: "0.2",
    enableX402Demo: false,
    x402DemoPayTo: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    x402DemoPriceUsdc: "0.01",
    x402BuyerTrustPolicy: "open",
    platformOutflowCeiling: 200_000_000n,
    walletProviderDefault: "turnkey" as const,
    platformOutflowWindowMs: 86_400_000,
  };
}

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  migrate(db);
  return db;
}

// The ONE fake doc store (test/helpers/runJobDeps.ts). The inline copy that used to live here
// silently dropped `putBytes`/`getBytes` when the interface grew.
const fakeDocStore: DocumentStore = makeFakeDocStore();

test("buildJobDeps returns the expected interface without network calls", () => {
  const cfg = makeConfig();
  const db = makeDb();
  const entities = new SqliteEntityRepository(db);

  const deps = buildJobDeps(cfg, db, entities, fakeDocStore);

  // Core function shapes
  expect(typeof deps.jobRunner?.start).toBe("function");
  expect(typeof deps.jobRunner?.reconcileInFlight).toBe("function");
  expect(typeof deps.runJob).toBe("function");

  // Address format
  expect(deps.jobClientAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(deps.jobEvaluatorAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // With distinct evaluator key, addresses should differ
  expect(deps.jobClientAddress?.toLowerCase()).not.toBe(deps.jobEvaluatorAddress?.toLowerCase());

  // The configured job client is its own identity, never the platform governance key.
  expect(deps.jobClientAddress?.toLowerCase()).toBe(
    privateKeyToAccount(JOB_CLIENT_KEY).address.toLowerCase(),
  );
  expect(deps.jobClientAddress?.toLowerCase()).not.toBe(
    privateKeyToAccount(PLATFORM_KEY).address.toLowerCase(),
  );

  // Adapters and runner are present
  expect(deps.jobs).toBeDefined();
  expect(deps.jobAdapter).toBeDefined();
  expect(deps.reputationAdapter).toBeDefined();
  expect(deps.jobRunner).toBeDefined();
});

/**
 * THE ESCROW RECOVERY IS WIRED IN PRODUCTION, not only in the tests that are about it.
 *
 * `runJob` and `JobRunner` both take the recovery as an OPTIONAL dependency, because most test
 * compositions stop at the funding boundary and have no escrow to get back. An optional
 * dependency the composition root forgets is a feature that silently does not exist on the box,
 * so this is the test that holds it: the callable surface (`refundJob`, for the MCP tool and the
 * CLI) and the boot walk (the runner's own copy) are both present, and they are the SAME
 * function — a second, differently-wired copy is how two callers come to disagree.
 */
test("buildJobDeps wires the escrow recovery into the runner and exposes it as refundJob", async () => {
  const cfg = makeConfig();
  const db = makeDb();
  const entities = new SqliteEntityRepository(db);

  const deps = buildJobDeps(cfg, db, entities, fakeDocStore);

  expect(typeof deps.refundJob).toBe("function");
  // Reaching into the runner's own dependency is deliberate: the alternative is trusting that a
  // field nobody can observe was passed, which is the thing that goes wrong.
  const runnerDeps = (
    deps.jobRunner as unknown as { deps: { recoverEscrow?: (k: string) => unknown } }
  ).deps;
  expect(runnerDeps.recoverEscrow).toBe(deps.refundJob);

  // And it is the real recovery, bound to THIS database: asked about a job that is not there, it
  // says so rather than reaching for a chain.
  await expect(deps.refundJob?.("t:nope")).rejects.toThrow("recoverEscrow: job t:nope not found");
});

test("buildJobDeps falls back evaluator address to client address when no evaluator key", () => {
  const cfg = { ...makeConfig(), jobEvaluatorPrivateKey: undefined };
  const db = makeDb();
  const entities = new SqliteEntityRepository(db);

  const deps = buildJobDeps(cfg, db, entities, fakeDocStore);

  expect(deps.jobClientAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // Without distinct evaluator key, addresses must be equal
  expect(deps.jobClientAddress?.toLowerCase()).toBe(deps.jobEvaluatorAddress?.toLowerCase());
});

/**
 * No job client key: the composition root builds the READ half and nothing that signs.
 *
 * The key funds the escrow, so the only two things it could do with a missing var are refuse or
 * pay out of the platform governance key. It refuses, here, once — and the job repository still
 * comes back, because reading jobs already recorded needs SQLite and no credential at all.
 */
test("buildJobDeps builds no client wallet — and never the platform key's — with no job client key", () => {
  const cfg = { ...makeConfig(), jobClientPrivateKey: undefined };
  const db = makeDb();
  const entities = new SqliteEntityRepository(db);

  const deps = buildJobDeps(cfg, db, entities, fakeDocStore);

  expect(deps.jobs).toBeDefined();
  expect(deps.jobClientAddress).toBeUndefined();
  expect(deps.jobEvaluatorAddress).toBeUndefined();
  expect(deps.runJob).toBeUndefined();
  expect(deps.jobRunner).toBeUndefined();
  expect(deps.jobAdapter).toBeUndefined();
  expect(deps.reputationAdapter).toBeUndefined();
  // No client key, no refund either: the refund is a send, and there is no key to send it with.
  expect(deps.refundJob).toBeUndefined();
  // The whole point: nothing here is the platform account, by any route.
  const platform = privateKeyToAccount(PLATFORM_KEY).address.toLowerCase();
  expect(deps.jobClientAddress).not.toBe(platform);
  expect(deps.jobEvaluatorAddress).not.toBe(platform);
});
