/**
 * THE QUOTE (design 2026-08-26 §6.1) — what changes about `createCompany` when payment is on.
 *
 * Two things, and they are one fact: the company lands `draft` instead of `ready`, and the
 * `quoted` row that is its only way out is written in the SAME transaction. The separate file is
 * deliberate — `createCompany.test.ts` is the argument that payment OFF behaves exactly as A2
 * shipped it, and mixing the two would make it easy to weaken that by accident.
 */
import type DatabaseType from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type CreateCompanyDeps, createCompany } from "../../src/formation/company";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import { hasLivePayment } from "../../src/formation/status";
import { verifyTransferAuthorization } from "../../src/payments/transferAuthorization";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { Address, Hex } from "../../src/types";

const guardian = privateKeyToAccount(`0x${"7".repeat(64)}`);
const TENANT = guardian.address as Address;
const REVENUE = "0x000000000000000000000000000000000000bEEF" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const NOW = Date.parse("2026-08-26T12:00:00Z");

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let payments: SqliteFormationPaymentRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
});
afterEach(() => db.close());

function paymentCfg(over: Partial<FormationPaymentConfig> = {}): FormationPaymentConfig {
  return {
    required: true,
    feeAtomic: 399_000_000n,
    feeUsdc: 399,
    revenueAddress: REVENUE,
    quoteTtlMs: 30 * 60 * 1000,
    // Read and pinned at boot in production; a literal here, because this file is about the row
    // and the transaction rather than about the chain read (see usdcToken.test.ts for that).
    domain: { name: "USD Coin", version: "2", chainId: 5042002, verifyingContract: USDC },
    payments,
    ...over,
  };
}

function deps(over: Partial<CreateCompanyDeps> = {}): CreateCompanyDeps {
  return {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "sandbox" },
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
    transaction: (fn) => db.transaction(fn)(),
    now: () => NOW,
    payment: paymentCfg(),
    ...over,
  };
}

function newParty(tenantId = TENANT): string {
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

const intake = (partyId: string, over: Record<string, unknown> = {}) => ({
  partyId,
  names: ["Acme Robotics LLC", "Acme Automata", "Acme Mechanicals"],
  businessPurpose: "Operating autonomous software agents.",
  industryLabel: DEFAULT_INDUSTRY,
  ...over,
});

function created(over: Partial<CreateCompanyDeps> = {}) {
  const result = createCompany(deps(over), TENANT, intake(newParty()));
  if ("error" in result) throw new Error(`unexpected refusal: ${result.error}`);
  return result;
}

test("payment ON: the company lands DRAFT and carries a quoted row", () => {
  const { companyId, quote } = created();
  expect(companies.find(companyId)?.status).toBe("draft");
  expect(quote).toBeDefined();
  const row = payments.findLive(companyId, "formation");
  expect(row).toMatchObject({ status: "quoted", amountUsdc: 399_000_000n });
  // …and the derived predicate agrees, with no second write anywhere.
  expect(hasLivePayment(companies, companyId)).toBe(true);
});

test("payment OFF changes NOTHING — no row, `ready`, and no quote in the answer", () => {
  const { companyId, quote } = created({ payment: paymentCfg({ required: false }) });
  expect(companies.find(companyId)?.status).toBe("ready");
  expect(quote).toBeUndefined();
  expect(payments.listByCompany(companyId)).toEqual([]);
  expect(hasLivePayment(companies, companyId)).toBe(false);
});

test("a deployment with no payment config at all is the beta shape", () => {
  const { companyId, quote } = created({ payment: undefined });
  expect(companies.find(companyId)?.status).toBe("ready");
  expect(quote).toBeUndefined();
});

test("the quote is bound to the STORED row: amount, nonce, expiry, payee", () => {
  const { companyId, quote } = created();
  const row = payments.findLive(companyId, "formation")!;
  expect(quote).toMatchObject({
    paymentId: row.paymentId,
    amountUsdc: "399000000",
    amountDisplayUsdc: 399,
    payTo: REVENUE,
    nonce: row.nonce,
    validAfter: 0,
    validBefore: row.validBefore,
  });
  // The TTL, in seconds, from the injected clock — not "about now".
  expect(row.validBefore).toBe(Math.floor((NOW + 30 * 60 * 1000) / 1000));
});

test("the nonce is 32 random bytes from the ROW — two companies never share one", () => {
  // A nonce derived from the company id would be ONE-SHOT: the first failed attempt would brick
  // the company, because a re-quote could not produce a different one.
  const a = created();
  const b = createCompany(deps(), TENANT, intake(newParty()));
  const nonceA = payments.findLive(a.companyId, "formation")!.nonce;
  const nonceB = payments.findLive((b as { companyId: string }).companyId, "formation")!.nonce;
  expect(nonceA).toMatch(/^0x[0-9a-f]{64}$/);
  expect(nonceA).not.toBe(nonceB);
});

test("the typed data is the whole EIP-712 request, and a signature over it VERIFIES", async () => {
  // The end-to-end property the quote exists for: whatever the guardian's wallet signs from this
  // object must pass the same helper the settle route runs. A client that assembled the message
  // for itself would be a second place to get the domain, the type list or the field order wrong,
  // and every one of those produces a signature that reverts on-chain after approval.
  const { quote } = created();
  const td = quote!.typedData;
  const signature = (await guardian.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: {
      from: td.message.from,
      to: td.message.to,
      value: BigInt(td.message.value),
      validAfter: BigInt(td.message.validAfter),
      validBefore: BigInt(td.message.validBefore),
      nonce: td.message.nonce,
    },
  })) as Hex;

  const verdict = await verifyTransferAuthorization({
    authorization: {
      from: td.message.from,
      to: td.message.to,
      value: td.message.value,
      validAfter: td.message.validAfter,
      validBefore: td.message.validBefore,
      nonce: td.message.nonce,
    },
    signature,
    domain: td.domain,
    payTo: REVENUE,
    value: 399_000_000n,
    mode: "exact",
    now: () => NOW,
  });
  expect(verdict).toEqual({ ok: true, nonce: td.message.nonce });
});

test("the signer named in the message is the GUARDIAN — the company's tenant, by construction", () => {
  const { companyId, quote } = created();
  // Sessions are minted by SIWE over the guardian's wallet and the onboard door forces
  // `roles.guardian` to it, so "the guardian" and "the tenant that owns this row" are one address.
  expect(quote!.typedData.message.from).toBe(companies.find(companyId)!.tenantId);
});

test("a DRAFT company with a live quote still counts against the tenant's quota (§6.7)", () => {
  // Payment is a price, not a brake. The quota counts companies a tenant has spent OR COMMITTED
  // on, which is exactly `ready` or carrying a live payment — a draft with no payment would not
  // count, and that is what stops an abandoned form from exhausting a real quota.
  const d = deps({ maxPerTenant: 2 });
  createCompany(d, TENANT, intake(newParty()));
  createCompany(d, TENANT, intake(newParty()));
  const third = createCompany(d, TENANT, intake(newParty()));
  expect(third).toMatchObject({ error: expect.stringMatching(/limit|quota/i) });
});

test("a refused create writes NO payment row — the quote lives in the mint's transaction", () => {
  // The order §7 fixes: everything refuses BEFORE a row is minted. A quote written outside that
  // transaction would leave a live payment for a company that does not exist, and the unique
  // index would then block the tenant's next legitimate quote for it.
  const partyId = newParty("0x000000000000000000000000000000000000000B" as Address);
  const result = createCompany(deps(), TENANT, intake(partyId));
  expect("error" in result).toBe(true);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM formation_payments").get() as { n: number }).n,
  ).toBe(0);
});

test("a lost party-bind CAS rolls the QUOTE back with the company", () => {
  // The sentinel-throw case (A1 finding 4): better-sqlite3 rolls back on an exception and nothing
  // else. A committed quote over a rolled-back company would be a live payment row pointing at
  // nothing — and the live-rows index would then refuse the tenant's next real quote.
  const partyId = newParty();
  const stealing = {
    ...parties,
    findOwned: parties.findOwned.bind(parties),
    bindToCompany: () => false,
  } as unknown as SqliteFormationPartyRepository;
  const result = createCompany(deps({ parties: stealing }), TENANT, intake(partyId));
  expect("error" in result).toBe(true);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM formation_payments").get() as { n: number }).n,
  ).toBe(0);
  expect((db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n).toBe(0);
});
