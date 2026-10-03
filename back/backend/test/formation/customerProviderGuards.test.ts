/**
 * A customer's own company at the formation seams: it never takes an agent of the full product,
 * it is priced with its own fee, it leaves the formation quota alone, and the formation filing
 * loop never picks it up.
 *
 * The rows are written as the doors write them: a customer's company as the declaration door
 * writes it (provider `customer`, the full declared name, the placeholder purpose and industry),
 * a formation company as `createCompany` writes it. Every name is an invention.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  companyAcceptsAgents,
  companyUnavailableMessage,
  formationDoorRefusal,
} from "../../src/formation";
import { type CreateCompanyDeps, createCompany } from "../../src/formation/company";
import { DEFAULT_INDUSTRY, companyNameOptions } from "../../src/formation/intake";
import { feeAtomicFor, insertQuote } from "../../src/formation/payment";
import { CUSTOMER_COMPANY_PLACEHOLDER } from "../../src/legalBody/customerCompany";
import {
  type CompanyStatus,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { paymentCfg } from "../helpers/formationPayment";

const TENANT = "0x000000000000000000000000000000000000000A";
const NOW = Date.parse("2026-10-01T12:00:00Z");
/** Any provider but `customer` is a company filed through formation. */
const FORMATION_PIN = { provider: "example-formation-provider", environment: "sandbox" } as const;
/** The shared payment fixture's formation fee, and an invented fee for a customer's company. */
const FORMATION_FEE = 399_000_000n;
const CUSTOMER_FEE = 7_000_000n;

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
  // A created company writes an ops line: kept off stdout here.
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** A customer's company, as the declaration door writes it on a sandbox deployment. */
function customerCompany(status: CompanyStatus): string {
  return companies.create({
    tenantId: TENANT,
    status,
    provider: "customer",
    environment: "sandbox",
    synthetic: true,
    nameOptions: [{ name: "Example Holdings LLC", entityTypeEnding: "", position: 1 }],
    businessPurpose: CUSTOMER_COMPANY_PLACEHOLDER,
    industryLabel: CUSTOMER_COMPANY_PLACEHOLDER,
    intakeSynthesized: false,
  });
}

/** A company filed through formation, on the same deployment. */
function formationCompany(
  status: CompanyStatus,
  provider: string = FORMATION_PIN.provider,
): string {
  return companies.create({
    tenantId: TENANT,
    status,
    provider,
    environment: FORMATION_PIN.environment,
    synthetic: false,
    nameOptions: companyNameOptions("Example Works"),
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
  });
}

function newParty(): string {
  return parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Example",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Example Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
}

function createDeps(): CreateCompanyDeps {
  return {
    companies,
    parties,
    requests,
    pin: FORMATION_PIN,
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
    transaction: (fn) => db.transaction(fn)(),
    now: () => NOW,
  };
}

// ── agents ──────────────────────────────────────────────────────────────────────────────────

test("companyAcceptsAgents refuses a ready customer company; a ready formation company is accepted as before", () => {
  const customer = companies.find(customerCompany("ready"))!;
  const formation = companies.find(formationCompany("ready"))!;
  // Every filing state a ready formation company takes an agent in: the provider is refused
  // before any of them is looked at.
  for (const derived of ["none", "in_progress", "filed", "complete"] as const) {
    expect(companyAcceptsAgents(formation, derived, false)).toBe(true);
    expect(companyAcceptsAgents(customer, derived, false)).toBe(false);
  }
});

test("the onboard door refuses a ready customer company with its one company-unavailable message", () => {
  const door = { formation: { required: true, maxAgentsPerCompany: 10, requests, companies } };
  expect(
    formationDoorRefusal(door, { tenantId: TENANT, companyId: customerCompany("ready") }),
  ).toBe(companyUnavailableMessage());
  expect(
    formationDoorRefusal(door, { tenantId: TENANT, companyId: formationCompany("ready") }),
  ).toBeNull();
});

// ── the fee ─────────────────────────────────────────────────────────────────────────────────

test("feeAtomicFor: the customer fee for a customer's company, the formation fee for any other provider", () => {
  const both = { feeAtomic: FORMATION_FEE, byoFeeAtomic: CUSTOMER_FEE };
  expect(feeAtomicFor(both, "customer")).toBe(CUSTOMER_FEE);
  expect(feeAtomicFor(both, FORMATION_PIN.provider)).toBe(FORMATION_FEE);
  expect(feeAtomicFor(both, "another-formation-provider")).toBe(FORMATION_FEE);
});

test("feeAtomicFor: with no customer fee configured it throws for a customer's company only", () => {
  const formationOnly = { feeAtomic: FORMATION_FEE };
  expect(() => feeAtomicFor(formationOnly, "customer")).toThrow(/customer/);
  expect(feeAtomicFor(formationOnly, FORMATION_PIN.provider)).toBe(FORMATION_FEE);
});

test("insertQuote writes the formation fee unless it is given an amount", () => {
  const cfg = paymentCfg(payments, { byoFeeAtomic: CUSTOMER_FEE });
  const byDefault = insertQuote(cfg, formationCompany("draft"), NOW);
  const given = insertQuote(cfg, customerCompany("draft"), NOW, CUSTOMER_FEE);
  expect(payments.find(byDefault)?.amountUsdc).toBe(FORMATION_FEE);
  expect(payments.find(given)?.amountUsdc).toBe(CUSTOMER_FEE);
});

// ── the formation quota ─────────────────────────────────────────────────────────────────────

test("three ready customer companies do not block a formation company's creation", () => {
  for (let i = 0; i < 3; i++) customerCompany("ready");
  const created = createCompany(createDeps(), TENANT, {
    partyId: newParty(),
    names: ["Example Robotics LLC", "Example Automata", "Example Mechanicals"],
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: DEFAULT_INDUSTRY,
  });
  expect(created).toEqual({ companyId: expect.any(String) });
  expect(companies.countChargeableByTenant(TENANT)).toBe(1);
});

test("the formation quota counts a formation company owing its fee, never a customer company owing its own", () => {
  const cfg = paymentCfg(payments, { byoFeeAtomic: CUSTOMER_FEE });
  insertQuote(cfg, customerCompany("draft"), NOW, CUSTOMER_FEE);
  expect(companies.countChargeableByTenant(TENANT)).toBe(0);
  insertQuote(cfg, formationCompany("draft"), NOW);
  expect(companies.countChargeableByTenant(TENANT)).toBe(1);
});

// ── the filing loop ─────────────────────────────────────────────────────────────────────────

test("listUnopened never returns a customer company", () => {
  // The filing loop opens the companies of the one provider this code files with, and no other.
  const formation = formationCompany("ready", "doola");
  expect(parties.bindToCompany(newParty(), formation, TENANT)).toBe(true);
  const customer = customerCompany("ready");
  expect(requests.listUnopenedFormations("sandbox", 10)).toEqual([formation]);
  // Its provider alone keeps it out: not even a formation party bound to it, which no door
  // does, puts it in reach.
  expect(parties.bindToCompany(newParty(), customer, TENANT)).toBe(true);
  expect(requests.listUnopenedFormations("sandbox", 10)).toEqual([formation]);
});
