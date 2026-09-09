/**
 * The payment DOORS (design 2026-08-26 §6.1/§6.8) — the quote on `POST /companies`,
 * `GET /companies/:companyId/payment`, and the two `/config` fields the wizard branches on.
 *
 * With payment OFF none of it exists: no field on the create response, a 404 on the payment
 * route, and `formationPaymentRequired: false`. That is the shape every deployment ships in for
 * the beta, and it is asserted here rather than assumed.
 */
import type Database from "better-sqlite3";
import { getAddress } from "viem";
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

test("GET the payment: 404 where the deployment does not charge", async () => {
  // Not an empty object: there is no payment RESOURCE on a box that takes no money, and
  // inventing one would have every client render a payment section for it.
  const { body } = await create(paymentCfg({ required: false }));
  const res = await app(paymentCfg({ required: false })).request(
    `/companies/${body.companyId}/payment`,
    { headers: { authorization: `Bearer ${await token(OWNER)}` } },
  );
  expect(res.status).toBe(404);
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
    rawTx: "0x02aa",
    txHash: `0x${"cc".repeat(32)}`,
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
