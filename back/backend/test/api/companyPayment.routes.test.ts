/**
 * The payment DOORS (design 2026-08-26 §6.1/§6.8) — the quote on `POST /companies`,
 * `GET /companies/:companyId/payment`, and the two `/config` fields the wizard branches on.
 *
 * With payment OFF none of it exists: no field on the create response, a 404 on the payment
 * route, and `formationPaymentRequired: false`. That is the shape every deployment ships in for
 * the beta, and it is asserted here rather than assumed.
 */
import type Database from "better-sqlite3";
import { getAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { Address } from "../../src/types";

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const guardian = privateKeyToAccount(`0x${"7".repeat(64)}`);
const OWNER = getAddress(guardian.address);
const OTHER = getAddress("0x000000000000000000000000000000000000000b");
const REVENUE = "0x000000000000000000000000000000000000bEEF" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let parties: SqliteFormationPartyRepository;
let payments: SqliteFormationPaymentRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
});
afterEach(() => db.close());

async function token(tenantId: string): Promise<string> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

function paymentCfg(over: Partial<FormationPaymentConfig> = {}): FormationPaymentConfig {
  return {
    required: true,
    feeAtomic: 399_000_000n,
    feeUsdc: 399,
    revenueAddress: REVENUE,
    quoteTtlMs: 30 * 60 * 1000,
    domain: { name: "USD Coin", version: "2", chainId: 5042002, verifyingContract: USDC },
    payments,
    ...over,
  };
}

function app(payment?: FormationPaymentConfig) {
  const companyDeps = {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "sandbox" },
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
    payment,
  };
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    formationSteps: (id: string) => requests.stepsOf(id),
    transaction: <T>(fn: () => T) => db.transaction(fn)(),
    formation: {
      environment: "sandbox",
      required: true,
      sandboxSyntheticPii: false,
      maxPerTenant: 3,
      dailyCeiling: 10,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin: { provider: "doola", environment: "sandbox" },
      companyDeps,
      payment,
      feeUsdc: 399,
    },
    // `POST /companies` opens its own transaction through `deps.repo`.
    // biome-ignore lint/suspicious/noExplicitAny: the app deps are wider than this file needs
  } as any);
}

function newParty(tenantId = OWNER): string {
  return parties.create({
    tenantId,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
}

async function create(payment?: FormationPaymentConfig, tenantId = OWNER) {
  const res = await app(payment).request("/companies", {
    method: "POST",
    headers: {
      authorization: `Bearer ${await token(tenantId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      partyId: newParty(tenantId),
      names: ["Acme Robotics LLC", "Acme Automata", "Acme Mechanicals"],
      businessPurpose: "Operating autonomous software agents.",
      industryLabel: DEFAULT_INDUSTRY,
    }),
  });
  return { res, body: (await res.json()) as Record<string, never> };
}

test("payment OFF: the create response is the companyId and NOTHING else", async () => {
  const { res, body } = await create(paymentCfg({ required: false }));
  expect(res.status).toBe(201);
  expect(Object.keys(body)).toEqual(["companyId"]);
});

test("payment ON: the create response carries the quote, ready to sign", async () => {
  const { res, body } = await create(paymentCfg());
  expect(res.status).toBe(201);
  const payment = body.payment as unknown as Record<string, unknown>;
  expect(payment).toMatchObject({
    amountUsdc: "399000000",
    amountDisplayUsdc: 399,
    payTo: REVENUE,
    validAfter: 0,
  });
  // The whole EIP-712 request, so no client assembles the message for itself.
  expect(payment.typedData).toMatchObject({
    primaryType: "TransferWithAuthorization",
    domain: { name: "USD Coin", version: "2", chainId: 5042002, verifyingContract: USDC },
    message: { from: OWNER, to: REVENUE, value: "399000000", validAfter: "0" },
  });
});

test("GET the payment: 404 where there is NO PAYMENT — not where the flag is off", async () => {
  // A company with no payment row has no payment resource, and inventing an empty one would have
  // every client render a payment section for a deployment that takes no money.
  const { body } = await create(paymentCfg({ required: false }));
  const res = await app(paymentCfg({ required: false })).request(
    `/companies/${body.companyId}/payment`,
    { headers: { authorization: `Bearer ${await token(OWNER)}` } },
  );
  expect(res.status).toBe(404);
});

test("⚠ B8: a payment already taken stays READABLE after the flag is rolled back", async () => {
  // Gating the read on `payment.required` meant that turning charging off after taking money made
  // every settled payment invisible: a guardian who paid 399 USDC saw no payment at all and
  // support had nothing to point at. Rolling a flag back must not erase history.
  const cfg = paymentCfg();
  const { body } = await create(cfg);
  const companyId = body.companyId as unknown as string;
  const row = payments.findLive(companyId, "formation")!;
  payments.markSettling(row.paymentId, {
    payerAddress: OWNER as Address,
    signature: `0x${"11".repeat(65)}`,
  });
  payments.markSettled(row.paymentId, `0x${"cc".repeat(32)}`);

  const rolledBack = paymentCfg({ required: false, domain: undefined });
  const res = await app(rolledBack).request(`/companies/${companyId}/payment`, {
    headers: { authorization: `Bearer ${await token(OWNER)}` },
  });
  expect(res.status).toBe(200);
  const view = (await res.json()) as Record<string, unknown>;
  expect(view).toMatchObject({ status: "settled", txHash: `0x${"cc".repeat(32)}` });
  // Nothing SIGNABLE, though: no quote, and no domain to sign one against.
  expect(view.quote).toBeUndefined();
  expect(view.domain).toBeNull();

  // …and the ACTION doors are still closed, which is the half that must stay gated.
  for (const action of ["settle", "cancel", "requote"]) {
    const denied = await app(rolledBack).request(`/companies/${companyId}/payment/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token(OWNER)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ signature: `0x${"11".repeat(65)}`, from: OWNER }),
    });
    expect(denied.status).toBe(404);
  }
});

test("GET the payment: the live quote, re-servable after a reload", async () => {
  const cfg = paymentCfg();
  const { body } = await create(cfg);
  const res = await app(cfg).request(`/companies/${body.companyId}/payment`, {
    headers: { authorization: `Bearer ${await token(OWNER)}` },
  });
  expect(res.status).toBe(200);
  const view = (await res.json()) as Record<string, unknown>;
  expect(view).toMatchObject({
    companyId: body.companyId,
    product: "formation",
    status: "quoted",
    amountUsdc: "399000000",
  });
  // The SAME nonce the create handed out — a reload must not re-quote.
  expect((view.quote as { nonce: string }).nonce).toBe(
    (body.payment as unknown as { nonce: string }).nonce,
  );
});

test("GET the payment: a SETTLING row carries NO quote — re-signing is the double charge", async () => {
  const cfg = paymentCfg();
  const { body } = await create(cfg);
  const row = payments.findLive(body.companyId as unknown as string, "formation")!;
  payments.markSettling(row.paymentId, {
    payerAddress: OWNER as Address,
    signature: `0x${"11".repeat(65)}`,
  });
  const res = await app(cfg).request(`/companies/${body.companyId}/payment`, {
    headers: { authorization: `Bearer ${await token(OWNER)}` },
  });
  const view = (await res.json()) as Record<string, unknown>;
  expect(view.status).toBe("settling");
  expect(view.quote).toBeUndefined();
});

test("GET the payment: an EXPIRED-BY-THE-CLOCK quote offers nothing, sweeper or not", async () => {
  // The clock is the truth; the row's status is a record of when we last looked at it. Offering
  // typed data here would walk a guardian through a wallet prompt the token would reject.
  const cfg = paymentCfg({ quoteTtlMs: 1 });
  const { body } = await create(cfg);
  const res = await app(cfg).request(`/companies/${body.companyId}/payment`, {
    headers: { authorization: `Bearer ${await token(OWNER)}` },
  });
  const view = (await res.json()) as Record<string, unknown>;
  expect(view.status).toBe("quoted");
  expect(view.quote).toBeUndefined();
});

test("GET the payment: somebody else's company is the SAME 404 as an unknown one", async () => {
  const cfg = paymentCfg();
  const { body } = await create(cfg);
  const res = await app(cfg).request(`/companies/${body.companyId}/payment`, {
    headers: { authorization: `Bearer ${await token(OTHER)}` },
  });
  expect(res.status).toBe(404);
  const missing = await app(cfg).request("/companies/does-not-exist/payment", {
    headers: { authorization: `Bearer ${await token(OWNER)}` },
  });
  expect(missing.status).toBe(404);
});

test("/config serves the two payment fields, and NEVER the revenue address", async () => {
  const on = (await (await app(paymentCfg()).request("/config")).json()) as Record<string, unknown>;
  expect(on.formationPaymentRequired).toBe(true);
  expect(on.formationFeeUsdc).toBe(399);
  // The payee belongs on the QUOTE — authenticated, and bound to an exact amount and nonce.
  // `/config` is public and unauthenticated.
  expect(JSON.stringify(on).toLowerCase()).not.toContain(REVENUE.toLowerCase());

  const off = (await (
    await app(paymentCfg({ required: false })).request("/config")
  ).json()) as Record<string, unknown>;
  expect(off.formationPaymentRequired).toBe(false);
  // The FEE is still served with payment off: it is the number in the beta sentence
  // ("included during the beta, normally $399"), and bundling it in the browser build is how a
  // price on screen drifts from the price the backend would quote.
  expect(off.formationFeeUsdc).toBe(399);
});

// ── the ACTION doors (§6.3/§6.4) ───────────────────────────────────────────────────────────
//
// The domain behaviour is asserted in test/workflow/formationPayment.test.ts against a fake
// chain. What these add is the DOOR: ownership, the 404 on a box that does not charge, and the
// body validation that stands between a stranger's POST and the executor.

/** The smallest executor stub that lets a settle reach a verdict. */
function fakeExecutor() {
  const sent: string[] = [];
  return {
    publicClient: {
      getTransactionCount: async () => 1,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => {
        sent.push(serializedTransaction);
        return "0x00";
      },
      waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
        status: "success",
        gasUsed: 118_000n,
        transactionHash: hash,
      }),
      readContract: async () => false,
      getBlockNumber: async () => 1_000n,
      getBlock: async () => ({ number: 1_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
      getLogs: async () => [],
      // Client-bound verification (gate A6): a real client tries ECDSA first, which for the EOA
      // guardian in this file is the whole answer.
      verifyTypedData: async (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
      getCode: async () => undefined,
      // biome-ignore lint/suspicious/noExplicitAny: a five-method stub of viem's PublicClient
    } as any,
    walletClient: {
      account: privateKeyToAccount(`0x${"9".repeat(64)}`),
      signTransaction: async () => "0x02aabb",
      // biome-ignore lint/suspicious/noExplicitAny: a two-field stub of viem's WalletClient
    } as any,
    usdc: USDC,
    chainId: 5042002,
    sent,
  };
}

function appWithExecutor(
  payment: FormationPaymentConfig,
  executor: ReturnType<typeof fakeExecutor>,
) {
  const built = app(payment);
  void built;
  const companyDeps = {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "sandbox" },
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
    payment,
  };
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    formationSteps: (id: string) => requests.stepsOf(id),
    formation: {
      environment: "sandbox",
      required: true,
      sandboxSyntheticPii: false,
      maxPerTenant: 3,
      dailyCeiling: 10,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin: { provider: "doola", environment: "sandbox" },
      companyDeps,
      payment,
      feeUsdc: 399,
      paymentExecutor: executor,
    },
    // biome-ignore lint/suspicious/noExplicitAny: the app deps are wider than this file needs
  } as any);
}

/** The served quote, as a caller receives it over the wire. */
type ServedQuote = { typedData: Parameters<typeof signQuote>[0] };

/** Sign a SERVED EIP-712 message, converting only the three uint256 strings viem wants as
 *  bigints — the same translation the browser's `toWagmiTypedData` does. */
async function signQuote(td: {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, string>;
}): Promise<`0x${string}`> {
  return guardian.signTypedData({
    // biome-ignore lint/suspicious/noExplicitAny: a served EIP-712 request, typed at the wire
    domain: td.domain as any,
    // biome-ignore lint/suspicious/noExplicitAny: as above
    types: td.types as any,
    // biome-ignore lint/suspicious/noExplicitAny: as above
    primaryType: td.primaryType as any,
    message: {
      from: td.message.from,
      to: td.message.to,
      value: BigInt(td.message.value!),
      validAfter: BigInt(td.message.validAfter!),
      validBefore: BigInt(td.message.validBefore!),
      nonce: td.message.nonce,
      // biome-ignore lint/suspicious/noExplicitAny: as above
    } as any,
  });
}

async function post(
  application: ReturnType<typeof buildApiApp>,
  path: string,
  body: unknown,
  tenantId = OWNER,
) {
  return application.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await token(tenantId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("settle: a real guardian signature settles through the door and readies the company", async () => {
  const cfg = paymentCfg();
  const executor = fakeExecutor();
  const { body } = await create(cfg);
  const companyId = body.companyId as unknown as string;
  // ⚠ SIGNS WHAT THE DOOR SERVED (finding C1) — the typed data off the create response, not a
  // rebuild of the same six fields. A test that rebuilds them passes while the product serves
  // something else, which is the one failure the single construction exists to prevent.
  const signature = await signQuote((body.payment as unknown as ServedQuote).typedData);
  const res = await post(appWithExecutor(cfg, executor), `/companies/${companyId}/payment/settle`, {
    signature,
    from: OWNER,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("settled");
  expect(companies.find(companyId)?.status).toBe("ready");
});

test("settle: a body with no signature is a 400, and nothing reaches the executor", async () => {
  const cfg = paymentCfg();
  const executor = fakeExecutor();
  const { body } = await create(cfg);
  const res = await post(
    appWithExecutor(cfg, executor),
    `/companies/${body.companyId}/payment/settle`,
    { from: OWNER },
  );
  expect(res.status).toBe(400);
  expect(executor.sent).toHaveLength(0);
});

test("settle: another tenant's company is the same 404 as an unknown one", async () => {
  const cfg = paymentCfg();
  const executor = fakeExecutor();
  const { body } = await create(cfg);
  const res = await post(
    appWithExecutor(cfg, executor),
    `/companies/${body.companyId}/payment/settle`,
    { signature: `0x${"11".repeat(65)}`, from: OWNER },
    OTHER,
  );
  expect(res.status).toBe(404);
});

test("the three action doors 404 on a deployment that does not charge", async () => {
  const off = paymentCfg({ required: false });
  const executor = fakeExecutor();
  const { body } = await create(off);
  const application = appWithExecutor(off, executor);
  for (const action of ["settle", "cancel", "requote"]) {
    const res = await post(application, `/companies/${body.companyId}/payment/${action}`, {
      signature: `0x${"11".repeat(65)}`,
      from: OWNER,
    });
    expect(res.status).toBe(404);
  }
});

test("requote: refused while a quote is live, and issues a NEW nonce once it is terminal", async () => {
  const cfg = paymentCfg();
  const executor = fakeExecutor();
  const { body } = await create(cfg);
  const companyId = body.companyId as unknown as string;
  const application = appWithExecutor(cfg, executor);

  const live = await post(application, `/companies/${companyId}/payment/requote`, {});
  expect(live.status).toBe(400);

  const first = payments.findLive(companyId, "formation")!;
  payments.markExpired(first.paymentId, "quoted");
  const res = await post(application, `/companies/${companyId}/payment/requote`, {});
  expect(res.status).toBe(201);
  const quote = (await res.json()) as { nonce: string; paymentId: string };
  expect(quote.nonce).not.toBe(first.nonce);
  expect(quote.paymentId).not.toBe(first.paymentId);
});

test("a settling payment still carries the NONCE and the DOMAIN — the cancel path needs them", async () => {
  // The quote is withheld while a broadcast is in flight (signing again is the double charge),
  // but the guardian's exit from a stuck payment is a CancelAuthorization signature, and that
  // needs the nonce and the token's domain. Serving those two is safe where serving the quote is
  // not: a transfer authorization also commits to the VALUE, the RECIPIENT and the WINDOW, and
  // none of them is here — the worst a wrong cancel message can do is get rejected by the token.
  const cfg = paymentCfg();
  const { body } = await create(cfg);
  const companyId = body.companyId as unknown as string;
  const row = payments.findLive(companyId, "formation")!;
  payments.markSettling(row.paymentId, {
    payerAddress: OWNER as Address,
    signature: `0x${"11".repeat(65)}`,
  });
  const res = await app(cfg).request(`/companies/${companyId}/payment`, {
    headers: { authorization: `Bearer ${await token(OWNER)}` },
  });
  const view = (await res.json()) as Record<string, unknown>;
  expect(view.quote).toBeUndefined();
  expect(view.nonce).toBe(row.nonce);
  expect(view.domain).toEqual({
    name: "USD Coin",
    version: "2",
    chainId: 5042002,
    verifyingContract: USDC,
  });
});
