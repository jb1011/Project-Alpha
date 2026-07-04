/**
 * Smoke test for buildJobDeps — verifies the composition root builds without throwing
 * and returns the expected interface. No chain calls are made.
 */
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import type { Config } from "../../src/config/env";
import { buildJobDeps } from "../../src/jobs/composition";
import { migrate } from "../../src/persistence/db";
import type { DocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";

// Two distinct valid secp256k1 private keys (these are Anvil test keys — safe for tests)
const PLATFORM_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const EVALUATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

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
    spendAllowlistThreshold: 1_000_000n,
    maxJobBudget: 5_000_000n,
    maxInflightJobsPerTenant: 3,
    customerPrivateKey: PLATFORM_KEY,
    authJwtSecret: "dev-insecure-secret-change-me-please",
    authJwtTtlSec: 3600,
    webOrigin: "*",
    siweDomain: "localhost",
    passkeyRpId: "localhost",
    jobContract: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    jobClientPrivateKey: PLATFORM_KEY,
    jobEvaluatorPrivateKey: EVALUATOR_KEY,
    jobSweepToTreasury: false,
    mcpPublicUrl: "http://localhost:8789/mcp",
    metadataBaseUrl: "http://localhost:8789",
  };
}

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  migrate(db);
  return db;
}

const fakeDocStore: DocumentStore = {
  put: (name: string, contents: string) => ({
    id: name,
    path: `/tmp/test-docs/${name}`,
    uri: `file:///tmp/test-docs/${name}`,
  }),
  get: (_id: string) => "",
};

test("buildJobDeps returns the expected interface without network calls", () => {
  const cfg = makeConfig();
  const db = makeDb();
  const entities = new SqliteEntityRepository(db);

  const deps = buildJobDeps(cfg, db, entities, fakeDocStore);

  // Core function shapes
  expect(typeof deps.jobRunner.start).toBe("function");
  expect(typeof deps.jobRunner.reconcileInFlight).toBe("function");
  expect(typeof deps.runJob).toBe("function");

  // Address format
  expect(deps.jobClientAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(deps.jobEvaluatorAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // With distinct evaluator key, addresses should differ
  expect(deps.jobClientAddress.toLowerCase()).not.toBe(deps.jobEvaluatorAddress.toLowerCase());

  // Adapters and runner are present
  expect(deps.jobs).toBeDefined();
  expect(deps.jobAdapter).toBeDefined();
  expect(deps.reputationAdapter).toBeDefined();
  expect(deps.jobRunner).toBeDefined();
});

test("buildJobDeps falls back evaluator address to client address when no evaluator key", () => {
  const cfg = { ...makeConfig(), jobEvaluatorPrivateKey: undefined };
  const db = makeDb();
  const entities = new SqliteEntityRepository(db);

  const deps = buildJobDeps(cfg, db, entities, fakeDocStore);

  expect(deps.jobClientAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // Without distinct evaluator key, addresses must be equal
  expect(deps.jobClientAddress.toLowerCase()).toBe(deps.jobEvaluatorAddress.toLowerCase());
});
