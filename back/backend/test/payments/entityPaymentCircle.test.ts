import Database from "better-sqlite3";
import { beforeEach, expect, test, vi } from "vitest";
import type { CircleWalletsApi } from "../../src/adapters/circle/circleWallets";
import type { Config } from "../../src/config/env";
import type { TreasuryReader } from "../../src/payments/entityPayment";
import { buildEntityPaymentService } from "../../src/payments/entityPayment";
import { PaymentLedger } from "../../src/payments/ledger";
import { migrate } from "../../src/persistence/db";
import { SqlitePaymentIdempotencyStore } from "../../src/persistence/paymentIdempotencyStore";
import type { Address, EntityRecord, Hex } from "../../src/types";

/** Tier-0 audit item 4 — the pay path's provider dispatch: a circle-custody agent signs x402
 *  authorizations through the Circle API (MPC-held pocket key), same seams, no local key. */

const POCKET_MASTER_SEED: Hex = "0xabababababababababababababababababababababababababababababab";
const TREASURY: Address = "0x000000000000000000000000000000000000000F";
const PAY_TO: Address = "0x00000000000000000000000000000000000000AB";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const POCKET_ADDR: Address = "0x4000000000000000000000000000000000000004";

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    rpcUrl: "https://rpc.testnet.arc.network",
    chainId: 5042002,
    platformPrivateKey: POCKET_MASTER_SEED,
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    usdc: USDC,
    factoryAddress: undefined,
    guardianAddress: undefined,
    operatorPrivateKey: undefined,
    pocketMasterSeed: POCKET_MASTER_SEED,
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
    spendAllowlistThreshold: 500n,
    maxJobBudget: 5_000_000n,
    maxInflightJobsPerTenant: 3,
    maxTreasuryFund: 25_000_000n,
    maxTreasuryFundedPerTenant: 100_000_000n,
    customerPrivateKey: POCKET_MASTER_SEED,
    authJwtSecret: "dev-insecure-secret-change-me-please",
    authJwtTtlSec: 3600,
    webOrigin: "*",
    siweDomain: "localhost",
    passkeyRpId: "localhost",
    jobContract: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    jobClientPrivateKey: POCKET_MASTER_SEED,
    jobEvaluatorPrivateKey: undefined,
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
    ...over,
  };
}

function circleEntity(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    idempotencyKey: "tenantA:circle1",
    name: "CircleAgent",
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: "0x000000000000000000000000000000000000000A",
    operator: "0x000000000000000000000000000000000000000B",
    amendmentDelay: "86400",
    ein: "12-3456789",
    formationDate: 1700000000,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: {
      usdc: USDC,
      payoutAddress: "0x000000000000000000000000000000000000000E",
      cap: 5_000_000n,
      period: 86400n,
      allowlistEnabled: false,
    },
    agentId: "42",
    proxy: "0x000000000000000000000000000000000000000D",
    treasury: TREASURY,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    walletProvider: "circle",
    circleOperatorWalletId: "op-w",
    circlePocketWalletId: "pk-w",
    pocketAddress: POCKET_ADDR,
    ...over,
  };
}

const requirements = {
  payTo: PAY_TO,
  maxAmountRequired: "1000",
  asset: USDC,
  network: "eip155:5042002",
  maxTimeoutSeconds: 60,
};

function fakeFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (!headers?.["X-PAYMENT"])
      return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    return new Response("ok", { status: 200 });
  });
}

const reader: TreasuryReader = {
  treasuryAvailable: async () => 1_000_000n,
  treasuryPaused: async () => false,
  treasuryAllowlistEnabled: async () => false,
  treasuryIsAllowed: async () => true,
  usdcBalanceOf: async () => 0n,
  legalStatus: async () => 0,
};

let db: Database.Database;
let ledger: PaymentLedger;
let idempotency: SqlitePaymentIdempotencyStore;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  ledger = new PaymentLedger(db);
  idempotency = new SqlitePaymentIdempotencyStore(db);
});

test("circle entity signs x402 through the Circle API (MPC pocket) and settles", async () => {
  const signTypedData = vi.fn().mockResolvedValue({ data: { signature: `0x${"ab".repeat(65)}` } });
  const circleApi = { signTypedData } as unknown as CircleWalletsApi;
  const svc = buildEntityPaymentService(makeConfig({ pocketMasterSeed: undefined }), {
    reader,
    ledger,
    idempotency,
    circleApi,
    fetchImpl: fakeFetch() as unknown as typeof fetch,
    readPocketFloat: async () => 1_000_000_000n,
  });
  const receipt = await svc.pay(circleEntity(), {
    url: "https://seller.example/x",
    amountUsdc: 1_000n,
    idempotencyKey: "k1",
    tenantId: "tenantA",
  });
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true });
  // The signature came from the Circle API against the POCKET wallet id — no local key existed
  // (pocketMasterSeed is undefined above, so any derivation attempt would have thrown).
  expect(signTypedData).toHaveBeenCalledTimes(1);
  expect(signTypedData.mock.calls[0]![0]).toMatchObject({ walletId: "pk-w" });
});

test("circle entity without a configured Circle client fails NAMED and releases the claim", async () => {
  const svc = buildEntityPaymentService(makeConfig({ pocketMasterSeed: undefined }), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fakeFetch() as unknown as typeof fetch,
    readPocketFloat: async () => 1_000_000_000n,
  });
  const args = {
    url: "https://seller.example/x",
    amountUsdc: 1_000n,
    idempotencyKey: "k2",
    tenantId: "tenantA",
  };
  const receipt = await svc.pay(circleEntity(), args);
  expect(receipt.ok).toBe(false);
  expect(receipt.reason).toMatch(/no Circle client is configured/);
  // Claim released → the same key retries cleanly once the config is fixed.
  const again = await svc.pay(circleEntity(), args);
  expect(again.reason).toMatch(/no Circle client is configured/);
});

test("circle entity missing wallet fields fails NAMED (never a confusing signer error)", async () => {
  const circleApi = { signTypedData: vi.fn() } as unknown as CircleWalletsApi;
  const svc = buildEntityPaymentService(makeConfig({ pocketMasterSeed: undefined }), {
    reader,
    ledger,
    idempotency,
    circleApi,
    fetchImpl: fakeFetch() as unknown as typeof fetch,
    readPocketFloat: async () => 1_000_000_000n,
  });
  const receipt = await svc.pay(circleEntity({ circlePocketWalletId: undefined }), {
    url: "https://seller.example/x",
    amountUsdc: 1_000n,
    idempotencyKey: "k3",
    tenantId: "tenantA",
  });
  expect(receipt.ok).toBe(false);
  expect(receipt.reason).toMatch(/missing/);
  expect(receipt.reason).toMatch(/pocketWalletId/);
});
