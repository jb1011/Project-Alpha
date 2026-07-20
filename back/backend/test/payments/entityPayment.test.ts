import Database from "better-sqlite3";
import { beforeEach, expect, test, vi } from "vitest";
import type { Config } from "../../src/config/env";
import type { TreasuryReader } from "../../src/payments/entityPayment";
import { buildEntityPaymentService } from "../../src/payments/entityPayment";
import { PaymentLedger } from "../../src/payments/ledger";
import { migrate } from "../../src/persistence/db";
import { SqlitePaymentIdempotencyStore } from "../../src/persistence/paymentIdempotencyStore";
import type { Address, EntityRecord, Hex } from "../../src/types";

// Two distinct valid secp256k1-scalar-shaped 32-byte hex values (test-only, never used on any real chain).
const POCKET_MASTER_SEED: Hex = "0xabababababababababababababababababababababababababababababab";

const TREASURY: Address = "0x000000000000000000000000000000000000000F";
const PAY_TO: Address = "0x00000000000000000000000000000000000000AB";
const USDC: Address = "0x3600000000000000000000000000000000000000";

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
    perTxCap: undefined,
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

/** A pocket float fake that always covers every test's amountUsdc — the default (real) reader would
 *  make a live Circle Gateway call, so every pay()/status() test that reaches the preflight injects
 *  this instead. */
const SUFFICIENT_FLOAT = async () => 1_000_000_000n;

/** Simulates an x402 resource server: first request (no X-PAYMENT) -> 402 with requirements;
 *  a request carrying X-PAYMENT -> 200. Records every call for assertions. */
function fakeFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const headers = init?.headers as Record<string, string> | undefined;
    const xp = headers?.["X-PAYMENT"];
    if (!xp) return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    return new Response("ok", { status: 200 });
  });
  return { fn, calls };
}

/** Fake TreasuryReader with scripted outcomes; records which payee treasuryIsAllowed was consulted with. */
function makeReader(
  over: Partial<{
    available: bigint;
    paused: boolean;
    allowlistEnabled: boolean;
    isAllowed: boolean;
    balance: bigint;
    legalStatus: number;
  }> = {},
) {
  const isAllowedCalls: Address[] = [];
  const usdcBalanceOfCalls: [Address, Address][] = [];
  const reader: TreasuryReader = {
    treasuryAvailable: async () => over.available ?? 1_000_000n,
    treasuryPaused: async () => over.paused ?? false,
    treasuryAllowlistEnabled: async () => over.allowlistEnabled ?? false,
    treasuryIsAllowed: async (_t, who) => {
      isAllowedCalls.push(who);
      return over.isAllowed ?? true;
    },
    usdcBalanceOf: async (usdc, owner) => {
      usdcBalanceOfCalls.push([usdc, owner]);
      return over.balance ?? 0n;
    },
    legalStatus: async () => over.legalStatus ?? 0,
  };
  return { reader, isAllowedCalls, usdcBalanceOfCalls };
}

let db: Database.Database;
let ledger: PaymentLedger;
let idempotency: SqlitePaymentIdempotencyStore;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  ledger = new PaymentLedger(db);
  idempotency = new SqlitePaymentIdempotencyStore(db);
});

test("happy path (micro): settles, fetch called twice, X-PAYMENT on retry, payee re-asserted", async () => {
  const { reader, isAllowedCalls } = makeReader({ available: 1_000_000n, isAllowed: true });
  const { fn, calls } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });

  const receipt = await svc.pay(seedEntity(), {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-happy",
    tenantId: "tenantA",
  });

  expect(receipt.ok).toBe(true);
  expect(fn).toHaveBeenCalledTimes(2);
  const secondHeaders = calls[1]?.init?.headers as Record<string, string> | undefined;
  expect(secondHeaders?.["X-PAYMENT"]).toBeTruthy();
  expect(isAllowedCalls.map((a) => a.toLowerCase())).toContain(PAY_TO.toLowerCase());
});

test("policy denial (over-cap): surfaces the reason, no retry fetch, idempotency released for retry", async () => {
  const { reader } = makeReader({ available: 10n }); // below requirements.maxAmountRequired (1000)
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-cap",
    tenantId: "tenantA",
  });

  expect(receipt).toMatchObject({ ok: false, reason: "over-cap" });
  expect(fn).toHaveBeenCalledTimes(1); // only the 402 probe, no retry
  // released, not stuck: a subsequent begin() with the same key is "new" again
  expect(idempotency.begin("k-cap", "tenantA", entity.idempotencyKey)).toEqual({ status: "new" });
});

test("pay denies when the legal body is suspended, even with sufficient float", async () => {
  const { reader } = makeReader({ legalStatus: 1 }); // non-zero = suspended
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const receipt = await svc.pay(seedEntity(), {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-legal",
    tenantId: "tenantA",
  });
  expect(receipt).toMatchObject({ ok: false, reason: "legal-not-active" });
  expect(fn).toHaveBeenCalledTimes(1); // only the 402 probe, no retry
});

test("hybrid: amount above threshold with a non-allowlisted payee is denied", async () => {
  const { reader } = makeReader({
    available: 1_000_000n,
    isAllowed: false,
    allowlistEnabled: false,
  });
  const { fn } = fakeFetch(); // requirements.maxAmountRequired = 1000 > cfg.spendAllowlistThreshold (500)
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });

  const receipt = await svc.pay(seedEntity(), {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-hybrid",
    tenantId: "tenantA",
  });

  expect(receipt).toMatchObject({ ok: false, reason: "over-threshold-needs-allowlist" });
  expect(fn).toHaveBeenCalledTimes(1); // no retry
});

test("SSRF: rejects a private/loopback URL before any network call or idempotency claim", async () => {
  const { reader } = makeReader();
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "http://127.0.0.1/x",
    amountUsdc: 1000n,
    idempotencyKey: "k-ssrf",
    tenantId: "tenantA",
  });

  expect(receipt.ok).toBe(false);
  expect((receipt as { reason?: string }).reason).toMatch(/ssrf/i);
  expect(fn).not.toHaveBeenCalled();
  // no idempotency row was created for the rejected URL
  expect(idempotency.begin("k-ssrf", "tenantA", entity.idempotencyKey)).toEqual({ status: "new" });
});

test("idempotency: replays the cached receipt on a repeated key without re-settling", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity();
  const args = {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-replay",
    tenantId: "tenantA",
  };

  const first = await svc.pay(entity, args);
  expect(first.ok).toBe(true);
  const callsAfterFirst = fn.mock.calls.length;

  const second = await svc.pay(entity, args);
  expect(second).toEqual(first);
  expect(fn.mock.calls.length).toBe(callsAfterFirst); // no new fetch on replay
});

test("treasury-not-ready: an entity with no treasury cannot pay", async () => {
  const { reader } = makeReader();
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity({ treasury: null });

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-notready",
    tenantId: "tenantA",
  });

  expect(receipt).toEqual({ ok: false, txOrTransferId: null, reason: "treasury-not-ready" });
  expect(fn).not.toHaveBeenCalled();
});

test("status: reads the four treasury fields plus the entity's configured cap", async () => {
  const { reader } = makeReader({
    available: 42_000n,
    paused: true,
    allowlistEnabled: true,
    balance: 123n,
  });
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    readPocketFloat: async () => 250_000n,
    readExposure: async () => ({ operatorEoa: 0n, pocketEoa: 0n, gateway: 0n, total: 0n }),
  });

  const status = await svc.status(seedEntity());

  expect(status).toEqual({
    available: "42000",
    cap: "5000000",
    paused: true,
    allowlistEnabled: true,
    float: "250000",
    balance: "123",
    standing: { operatorEoa: "0", pocketEoa: "0", gateway: "0", total: "0", ceiling: "1000000" },
  });
});

test("status: sources the balance read from the entity's own treasury USDC, not the platform-global default", async () => {
  const ENTITY_USDC: Address = "0x00000000000000000000000000000000009999";
  const { reader, usdcBalanceOfCalls } = makeReader({ balance: 777n });
  const svc = buildEntityPaymentService(makeConfig({ usdc: USDC }), {
    reader,
    ledger,
    idempotency,
    readPocketFloat: SUFFICIENT_FLOAT,
    readExposure: async () => ({ operatorEoa: 0n, pocketEoa: 0n, gateway: 0n, total: 0n }),
  });
  const entity = seedEntity({
    treasuryConfig: {
      usdc: ENTITY_USDC,
      payoutAddress: "0x000000000000000000000000000000000000000E",
      cap: 5_000_000n,
      period: 86400n,
      allowlistEnabled: false,
    },
  });

  const status = await svc.status(entity);

  expect(status.balance).toBe("777");
  expect(usdcBalanceOfCalls).toHaveLength(1);
  expect(usdcBalanceOfCalls[0]?.[0].toLowerCase()).toBe(ENTITY_USDC.toLowerCase());
  expect(usdcBalanceOfCalls[0]?.[1].toLowerCase()).toBe(TREASURY.toLowerCase());
  // Proves the divergence: the platform-global cfg.usdc was NOT what got queried.
  expect(usdcBalanceOfCalls[0]?.[0].toLowerCase()).not.toBe(USDC.toLowerCase());
});

test("surprise-price: 402 demands more than the caller's amountUsdc ceiling, denied before authorize/sign, claim released", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const authorizeSpy = vi.fn();
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers?.["X-PAYMENT"]) {
      authorizeSpy(); // would only be reached after a real authorize+retry
      return new Response("ok", { status: 200 });
    }
    // requirements.maxAmountRequired = 1000 (atomic), caller's amountUsdc below is 100 — over ceiling
    return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
  });
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 100n,
    idempotencyKey: "k-surprise",
    tenantId: "tenantA",
  });

  expect(receipt).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/amount-exceeds-declared/),
  });
  expect(fn).toHaveBeenCalledTimes(1); // only the 402 probe, no retry — authorize/sign never reached
  expect(authorizeSpy).not.toHaveBeenCalled();
  // released, not stuck: a subsequent begin() with the same key is "new" again (retryable)
  expect(idempotency.begin("k-surprise", "tenantA", entity.idempotencyKey)).toEqual({
    status: "new",
  });
});

test("post-sign failure (retry throws): does NOT release the claim, caches an unconfirmed receipt, blocks a blind re-sign", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const xp = headers?.["X-PAYMENT"];
    if (!xp) return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    throw new Error("network error: connection reset");
  });
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-postsign-throw",
    tenantId: "tenantA",
  });

  expect(receipt).toMatchObject({ ok: false, reason: expect.stringMatching(/^unconfirmed:/) });
  expect(fn).toHaveBeenCalledTimes(2); // 402 probe + the retry that threw — authorize/sign DID happen

  // A same-key retry must NOT be free to re-sign: begin() replays the cached unconfirmed receipt.
  const replay = idempotency.begin("k-postsign-throw", "tenantA", entity.idempotencyKey);
  expect(replay).toEqual({ status: "replayed", receipt });
});

test("post-sign failure (retry returns non-200): does NOT release the claim, caches unconfirmed", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const xp = headers?.["X-PAYMENT"];
    if (!xp) return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    return new Response("server error", { status: 500 });
  });
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-postsign-500",
    tenantId: "tenantA",
  });

  expect(receipt).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/^unconfirmed: resource-500$/),
  });
  expect(fn).toHaveBeenCalledTimes(2);

  const replay = idempotency.begin("k-postsign-500", "tenantA", entity.idempotencyKey);
  expect(replay).toEqual({ status: "replayed", receipt });
});

test("authorize-build failure (missing pocket master seed): releases the idempotency claim instead of burning it", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const { fn } = fakeFetch();
  // No pocketMasterSeed -> buildAuthorize's requireMasterSeed throws BEFORE any fetch/signing.
  // readPocketFloat is faked (not defaulted) so the preflight — which would otherwise also hit
  // requireMasterSeed via the real reader — doesn't mask the buildAuthorize failure under test.
  const svc = buildEntityPaymentService(makeConfig({ pocketMasterSeed: undefined }), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-authorize-throws",
    tenantId: "tenantA",
  });

  expect(receipt).toMatchObject({ ok: false, reason: "set POCKET_MASTER_SEED to run payments" });
  expect(fn).not.toHaveBeenCalled(); // buildAuthorize threw before buyWithX402 ever ran

  // Released, not burned: a subsequent begin() with the same key is "new" again (retryable),
  // not stuck in-flight forever with a dangling receipt_json NULL row.
  expect(idempotency.begin("k-authorize-throws", "tenantA", entity.idempotencyKey)).toEqual({
    status: "new",
  });
});

test("status: an entity with no treasury reads as zeroed-out/not-paused", async () => {
  const { reader } = makeReader();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
  });

  const status = await svc.status(seedEntity({ treasury: null }));

  expect(status).toEqual({
    available: "0",
    cap: "0",
    paused: false,
    allowlistEnabled: false,
    float: "0",
    balance: "0",
    standing: { operatorEoa: "0", pocketEoa: "0", gateway: "0", total: "0", ceiling: "1000000" },
  });
});

test("insufficient float: pay fails BEFORE the idempotency claim or any signing (audit fix B-safe)", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: async () => 500n, // less than the amountUsdc requested below (1000n)
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-float",
    tenantId: "tenantA",
  });

  expect(receipt).toEqual({ ok: false, txOrTransferId: null, reason: "insufficient-float" });
  expect(fn).not.toHaveBeenCalled(); // not even the 402 probe — nothing was signed

  // No idempotency row was created: the same key is still "new", nothing to release.
  expect(idempotency.begin("k-float", "tenantA", entity.idempotencyKey)).toEqual({
    status: "new",
  });
});

test("sufficient float (equal to amount): pay proceeds past the preflight and settles", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: async () => 1000n, // exactly equal to amountUsdc below
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-float-equal",
    tenantId: "tenantA",
  });

  expect(receipt.ok).toBe(true);
  expect(fn).toHaveBeenCalledTimes(2); // 402 probe + the paid retry — preflight didn't block it
});

test("audit fix E: a confirmed (200) pay settles its ledger row, so runningPending excludes it afterward", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entity = seedEntity();

  const receipt = await svc.pay(entity, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-settle",
    tenantId: "tenantA",
  });

  expect(receipt.ok).toBe(true);
  // Settled, not left dangling as "authorized" forever — the whole point of audit fix E.
  expect(ledger.runningPending(entity.idempotencyKey)).toBe(0n);
});

test("audit fix E: pays on two different entities don't cross-count in runningPending", async () => {
  const { reader } = makeReader({ available: 1_000_000n, isAllowed: true });
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fakeFetch().fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const entityA = seedEntity({ idempotencyKey: "tenantA:agent1" });
  const entityB = seedEntity({ idempotencyKey: "tenantA:agent2" });

  // entityA's pay fails post-sign (unconfirmed) so its row stays "authorized" — must not bleed
  // into entityB's runningPending.
  const failingFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (!headers?.["X-PAYMENT"]) {
      return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    }
    return new Response("server error", { status: 500 });
  });
  const svcA = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: failingFetch as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  await svcA.pay(entityA, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-crossA",
    tenantId: "tenantA",
  });
  expect(ledger.runningPending(entityA.idempotencyKey)).toBe(1000n);
  expect(ledger.runningPending(entityB.idempotencyKey)).toBe(0n);

  // entityB pays successfully and settles — still no cross-contamination either direction.
  const receiptB = await svc.pay(entityB, {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-crossB",
    tenantId: "tenantA",
  });
  expect(receiptB.ok).toBe(true);
  expect(ledger.runningPending(entityA.idempotencyKey)).toBe(1000n);
  expect(ledger.runningPending(entityB.idempotencyKey)).toBe(0n);
});

test("status surfaces the standing exposure breakdown + ceiling", async () => {
  const { reader } = makeReader();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    readPocketFloat: SUFFICIENT_FLOAT,
    readExposure: async () => ({
      operatorEoa: 200_000n,
      pocketEoa: 200_000n,
      gateway: 500_000n,
      total: 900_000n,
    }),
  });
  const view = await svc.status(seedEntity());
  expect(view.standing).toEqual({
    operatorEoa: "200000",
    pocketEoa: "200000",
    gateway: "500000",
    total: "900000",
    ceiling: "1000000", // usdToUnits("1.00")
  });
  // float stays the spendable Gateway balance, NOT the standing total
  expect(view.float).toBe(1_000_000_000n.toString());
});
