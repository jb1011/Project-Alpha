import type { AgentkitExtension } from "@worldcoin/agentkit";
import Database from "better-sqlite3";
import { beforeEach, expect, test, vi } from "vitest";
import type { CircleWalletsApi } from "../../src/adapters/circle/circleWallets";
import type { AgentkitSigner } from "../../src/adapters/worldid/agentkitSigner";
import { agentkitSignerFromKey } from "../../src/adapters/worldid/agentkitSigner";
import type { Config } from "../../src/config/env";
import { AGENT_BOOK_CAIP2, AGENT_BOOK_CHAIN_ID } from "../../src/payments/agentBookReader";
import type { TreasuryReader } from "../../src/payments/entityPayment";
import { buildEntityPaymentService } from "../../src/payments/entityPayment";
import { PaymentLedger } from "../../src/payments/ledger";
import type { AgentkitSellerConfig } from "../../src/payments/worldVerifier";
import { mintAgentkitExtension, verifyAgentkitRequest } from "../../src/payments/worldVerifier";
import { migrate } from "../../src/persistence/db";
import { SqlitePaymentIdempotencyStore } from "../../src/persistence/paymentIdempotencyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Address, EntityRecord, Hex } from "../../src/types";

/**
 * Design v3 D10 — chain separation of the AgentKit proof.
 *
 * Our paid route and settlement live on Arc, but AgentBook (the registry a seller looks the agent
 * up in) lives on World Chain, and every AgentKit client in the wild signs its challenge for
 * `eip155:480`. So: OUR agents sign for World Chain, and OUR seller advertises World Chain BESIDE
 * Arc so a client that only knows one of the two still finds a chain it can sign for.
 *
 * Nothing about HOW a challenge is signed changes here (eip191 for a key, eip1271 for an SCA) —
 * only the advertised/announced chain id.
 */

// Captured by the module mock below; `vi.hoisted` because vi.mock factories are hoisted above
// ordinary const declarations.
const captured = vi.hoisted(() => [] as AgentkitSigner[]);

// Real signer builders, faked wrapper: the wrapper is where the payment service hands its
// AgentKit signer over, so capturing there observes exactly what buildEntityPaymentService built
// without loading the SDK or touching the payment path.
type SignerModule = typeof import("../../src/adapters/worldid/agentkitSigner");
vi.mock("../../src/adapters/worldid/agentkitSigner", async (importOriginal) => {
  const actual = await importOriginal<SignerModule>();
  return {
    ...actual,
    wrapFetchWithAgentkit: (baseFetch: typeof fetch, signer: AgentkitSigner) => {
      captured.push(signer);
      return baseFetch;
    },
  };
});

// The SDK's `verifyAgentkitSignature`, stubbed so the second argument it receives is observable
// without a live RPC. Everything else in the package (declareAgentkitExtension,
// createAgentkitClient, parseAgentkitHeader, validateAgentkitMessage) is the real thing, so the
// header these tests verify is a genuinely signed one.
const verifyCalls = vi.hoisted(() => [] as Array<{ chainId: string; rpcUrl: unknown }>);
type SdkModule = typeof import("@worldcoin/agentkit");
vi.mock("@worldcoin/agentkit", async (importOriginal) => {
  const actual = await importOriginal<SdkModule>();
  return {
    ...actual,
    verifyAgentkitSignature: async (
      payload: { chainId: string; address: string },
      rpcUrl?: unknown,
    ) => {
      verifyCalls.push({ chainId: payload.chainId, rpcUrl });
      return { valid: true, address: payload.address };
    },
  };
});

const POCKET_MASTER_SEED: Hex = "0xabababababababababababababababababababababababababababababab";
const TREASURY: Address = "0x000000000000000000000000000000000000000F";
const PAY_TO: Address = "0x00000000000000000000000000000000000000AB";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const POCKET_ADDR: Address = "0x4000000000000000000000000000000000000004";
const ARC_CAIP2 = "eip155:5042002";

// ---------------------------------------------------------------- the seller's 402

test("the seller's 402 advertises Arc AND World Chain, EIP-191 and ERC-1271 each", async () => {
  // The cast carries `info` for the same reason test/world/sellerGate.test.ts does:
  // mintAgentkitExtension's declared return type narrows to `info` alone, so the assertion needs
  // that property to overlap with it.
  const ext = (await mintAgentkitExtension({
    domain: "api.example",
    resourceUrl: "https://api.example/x402-demo/paid",
    network: ARC_CAIP2,
    allowancePerHuman: 3,
  })) as {
    agentkit: {
      info: Record<string, unknown>;
      supportedChains: Array<{ chainId: string; type: string }>;
    };
  };
  // SDK shape (verified in @worldcoin/agentkit-core's SupportedChain and @worldcoin/agentkit's
  // declareAgentkitExtension): every `eip155:*` network it is handed yields one {chainId, type}
  // entry per signature type, `eip191` and `eip1271`.
  const chains = ext.agentkit.supportedChains.map((c) => `${c.chainId}/${c.type}`);
  expect(chains).toContain(`${ARC_CAIP2}/eip191`);
  expect(chains).toContain(`${ARC_CAIP2}/eip1271`);
  expect(chains).toContain(`${AGENT_BOOK_CAIP2}/eip191`);
  expect(chains).toContain(`${AGENT_BOOK_CAIP2}/eip1271`);
});

// ---------------------------------------------------------------- the agent's signer

test("a pocket signer built for AgentBook announces eip155:480", () => {
  const s = agentkitSignerFromKey(`0x${"7".repeat(64)}`, AGENT_BOOK_CHAIN_ID);
  expect(s.chainId).toBe("eip155:480");
  expect(s.type).toBe("eip191"); // unchanged: only the advertised chain moved
});

// ------------------------------------------- the signer the payment service actually builds

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
    // The AgentKit wrapper is only composed when the World layer is configured.
    world: {
      appId: "app_test",
      rpId: "localhost",
      rpSigningKey: "k",
      action: "a",
      requireGuardian: false,
      environment: "sandbox" as const,
      attestMinAge: 18,
    },
    ...over,
  };
}

function seedEntity(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    idempotencyKey: "tenantA:agent1",
    name: "TestAgent",
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
    ...over,
  };
}

const requirements = {
  payTo: PAY_TO,
  maxAmountRequired: "1000",
  asset: USDC,
  network: ARC_CAIP2,
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
  captured.length = 0;
  verifyCalls.length = 0;
  db = new Database(":memory:");
  migrate(db);
  ledger = new PaymentLedger(db);
  idempotency = new SqlitePaymentIdempotencyStore(db);
});

test("pay() hands the AgentKit wrapper a pocket signer announcing World Chain, not Arc", async () => {
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fakeFetch() as unknown as typeof fetch,
    readPocketFloat: async () => 1_000_000_000n,
  });
  const receipt = await svc.pay(seedEntity(), {
    url: "https://vendor.example/resource",
    amountUsdc: 1_000n,
    idempotencyKey: "k-turnkey",
    tenantId: "tenantA",
  });
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true });
  expect(captured).toHaveLength(1);
  expect(captured[0]?.chainId).toBe(AGENT_BOOK_CAIP2);
  expect(captured[0]?.type).toBe("eip191");
});

test("pay() on the circle custody path also announces World Chain", async () => {
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
  const receipt = await svc.pay(
    seedEntity({
      idempotencyKey: "tenantA:circle1",
      walletProvider: "circle",
      circleOperatorWalletId: "op-w",
      circlePocketWalletId: "pk-w",
      pocketAddress: POCKET_ADDR,
    }),
    {
      url: "https://vendor.example/resource",
      amountUsdc: 1_000n,
      idempotencyKey: "k-circle",
      tenantId: "tenantA",
    },
  );
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true });
  expect(captured).toHaveLength(1);
  expect(captured[0]?.chainId).toBe(AGENT_BOOK_CAIP2);
  expect(captured[0]?.address).toBe(POCKET_ADDR);
});

// ------------------------------------------------- the RPC url handed to the SDK verifier

const RESOURCE_URL = "https://example.com/x402-demo/quote";
const DOMAIN = "example.com";
const HUMAN = "0x051dbcb350abbe853a25ef35c88c7a582281f88d1d8e26ed014bad0e34a7d234";
const ARC_RPC = "https://arc.rpc.test.invalid";
const WORLD_RPC = "https://worldchain.rpc.test.invalid";
const AGENT_KEY: Hex = `0x${"7".repeat(64)}`;

/** A really-signed header for `chainId`, minted from our own seller's real 402 extension.
 *  A hand-written payload would be thrown out by parseAgentkitHeader long before the RPC url is
 *  chosen, so it could say nothing about this. */
async function realHeader(chainId: number): Promise<string> {
  const ext = (await mintAgentkitExtension({
    domain: DOMAIN,
    resourceUrl: RESOURCE_URL,
    network: ARC_CAIP2,
    allowancePerHuman: 9,
  })) as unknown as { agentkit: AgentkitExtension };
  const { createAgentkitClient } = await import("@worldcoin/agentkit");
  const client = createAgentkitClient({ signer: agentkitSignerFromKey(AGENT_KEY, chainId) });
  return client.createHeader(ext.agentkit);
}

function sellerCfg(store: SqliteWorldStore): AgentkitSellerConfig {
  return {
    domain: DOMAIN,
    resourceUrl: RESOURCE_URL,
    network: ARC_CAIP2,
    store,
    allowancePerHuman: 9,
    agentBook: { lookupHuman: async () => HUMAN },
    rpcUrls: { [ARC_CAIP2]: ARC_RPC, [AGENT_BOOK_CAIP2]: WORLD_RPC },
  };
}

test("the verifier gets the RPC url for the chain the payload names, not the whole map", async () => {
  // REGRESSION: this used to pass `{ rpcUrls: {...} }` behind an `as any`, but the SDK's second
  // parameter is `rpcUrl?: string` and goes straight into viem's `http()`. The object made that
  // transport unusable — EIP-191 survived only because viem falls back to local ECDSA recovery,
  // and ERC-1271 (a contract call on the account's own chain) could never have worked.
  const store = new SqliteWorldStore(db);
  const worldHeader = await realHeader(AGENT_BOOK_CHAIN_ID);
  const arcHeader = await realHeader(5042002);

  const world = await verifyAgentkitRequest(worldHeader, sellerCfg(store));
  expect(world.authorized, JSON.stringify(world)).toBe(true);
  expect(verifyCalls).toEqual([{ chainId: AGENT_BOOK_CAIP2, rpcUrl: WORLD_RPC }]);

  const arc = await verifyAgentkitRequest(arcHeader, sellerCfg(store));
  expect(arc.authorized, JSON.stringify(arc)).toBe(true);
  expect(verifyCalls[1]).toEqual({ chainId: ARC_CAIP2, rpcUrl: ARC_RPC });
});

test("a chain we have no RPC url for verifies with undefined, not with the map", async () => {
  // Undefined is the SDK's documented "use viem's default endpoint for this chain" — the point is
  // that a missing entry must not silently degrade into passing something viem cannot use.
  const store = new SqliteWorldStore(db);
  const header = await realHeader(AGENT_BOOK_CHAIN_ID);
  const r = await verifyAgentkitRequest(header, { ...sellerCfg(store), rpcUrls: undefined });
  expect(r.authorized, JSON.stringify(r)).toBe(true);
  expect(verifyCalls).toEqual([{ chainId: AGENT_BOOK_CAIP2, rpcUrl: undefined }]);
});

/**
 * THE JOIN (removed-behaviour F1). The two halves above are each pinned in isolation: the seller
 * advertises World Chain, and the signer `buildEntityPaymentService` builds announces it. Nothing
 * proved they agree — and the SDK's `selectSupportedChain` is an EXACT match on
 * `{chainId, type}`, so a drift between the two constants makes `createHeader` throw, which
 * `agentkit.fetch` swallows into `agentkit_skipped`: our agents would quietly pay without
 * presenting the human backing they have.
 */
test("the signer the payment service builds can sign our own seller's 402", async () => {
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fakeFetch() as unknown as typeof fetch,
    readPocketFloat: async () => 1_000_000_000n,
  });
  await svc.pay(seedEntity(), {
    url: "https://vendor.example/resource",
    amountUsdc: 1_000n,
    idempotencyKey: "k-join",
    tenantId: "tenantA",
  });
  const signer = captured[0];
  expect(signer).toBeDefined();

  const ext = (await mintAgentkitExtension({
    domain: DOMAIN,
    resourceUrl: RESOURCE_URL,
    network: ARC_CAIP2,
    allowancePerHuman: 9,
  })) as unknown as { agentkit: AgentkitExtension };
  expect(
    ext.agentkit.supportedChains.map(
      (c: { chainId: string; type: string }) => `${c.chainId}/${c.type}`,
    ),
  ).toContain(`${signer?.chainId}/${signer?.type}`);

  // The real join, not a restatement of it: createHeader picks a chain out of the advertised set
  // and throws when the signer's is not in it.
  const { createAgentkitClient } = await import("@worldcoin/agentkit");
  const header = await createAgentkitClient({ signer: signer as never }).createHeader(ext.agentkit);
  expect(header).toBeTruthy();
});

// ------------------------------------------------- the strict wall, end to end through pay()

/** A seller whose policy is `accountable-only` / `legal-bodies-only`: a proofless request is
 *  refused 403 WITH the challenge in the body (seller.ts `refusal()`), a proved one is quoted 402,
 *  a proved AND paid one is served. This is the shape that used to make our own agents unable to
 *  buy from our own strict wall through `pay`. */
function strictWallFetch(
  seen: Array<{ agentkit?: string | undefined; payment?: string | undefined }>,
) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers as Record<string, string> | undefined) ?? {};
    seen.push({ agentkit: h.agentkit, payment: h["X-PAYMENT"] });
    if (!h.agentkit) {
      const ext = await mintAgentkitExtension({
        domain: DOMAIN,
        resourceUrl: RESOURCE_URL,
        network: ARC_CAIP2,
        allowancePerHuman: 9,
      });
      return new Response(
        JSON.stringify({
          error: "human_backing_required",
          detail: "this seller trades only with agents a verified unique human answers for",
          reason: "no-proof-presented",
          extensions: ext,
        }),
        { status: 403 },
      );
    }
    if (!h["X-PAYMENT"])
      return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    return new Response("ok", { status: 200 });
  });
}

test("pay() recovers from a strict seller's 403 challenge and completes the purchase", async () => {
  const seen: Array<{ agentkit?: string | undefined; payment?: string | undefined }> = [];
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: strictWallFetch(seen) as unknown as typeof fetch,
    readPocketFloat: async () => 1_000_000_000n,
  });
  const receipt = await svc.pay(seedEntity(), {
    url: "https://vendor.example/resource",
    amountUsdc: 1_000n,
    idempotencyKey: "k-strict",
    tenantId: "tenantA",
  });
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true });
  // Proof on the recovery and the paid retry, never on the first request.
  expect(seen.map((c) => typeof c.agentkit)).toEqual(["undefined", "string", "string"]);
  expect(seen[2]?.payment).toBeTruthy();
});

test("with the World layer unconfigured the same wall is simply terminal — no proof to offer", async () => {
  const seen: Array<{ agentkit?: string | undefined; payment?: string | undefined }> = [];
  const svc = buildEntityPaymentService(makeConfig({ world: undefined }), {
    reader,
    ledger,
    idempotency,
    fetchImpl: strictWallFetch(seen) as unknown as typeof fetch,
    readPocketFloat: async () => 1_000_000_000n,
  });
  const receipt = await svc.pay(seedEntity(), {
    url: "https://vendor.example/resource",
    amountUsdc: 1_000n,
    idempotencyKey: "k-strict-noworld",
    tenantId: "tenantA",
  });
  expect(receipt).toMatchObject({ ok: false, reason: "resource-403" });
  expect(seen).toHaveLength(1);
});
