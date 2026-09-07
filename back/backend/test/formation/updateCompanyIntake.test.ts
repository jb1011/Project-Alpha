/**
 * EDIT-AND-RETRY (design 2026-08-26 §4.7).
 *
 * Intake is FROZEN once the first create has been sent, and re-openable ONLY after the provider
 * REJECTED it. That is the idempotency contract rather than a UX preference: `rejected` is the one
 * failure that releases doola's key, so it is the one case a new body may be sent at all.
 *
 * The freeze predicate itself is exercised at the repository in
 * test/persistence/ssnStorage.test.ts — this file is about what the DOMAIN function adds on top:
 * ownership, the same validation the create runs, and the SSN re-capture, all in one transaction.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  companyIntakeFrozenMessage,
  companyNameRestrictedMessage,
  companyUnavailableMessage,
  industryLabelUnknownMessage,
  ssnFormatMessage,
  ssnRefusedHereMessage,
} from "../../src/formation";
import {
  type CreateCompanyDeps,
  createCompany,
  updateCompanyIntake,
} from "../../src/formation/company";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { decryptSsn, parsePiiKey } from "../../src/formation/pii";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";
const SSN = "123-45-6789";
const SSN_2 = "987-65-4321";
const RING = { current: parsePiiKey(Buffer.alloc(32, 8).toString("base64"), "FORMATION_PII_KEY") };

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
});
afterEach(() => db.close());

function deps(over: Partial<CreateCompanyDeps> = {}): CreateCompanyDeps {
  return {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "production" },
    sandboxSyntheticPii: false,
    maxPerTenant: 10,
    dailyCeiling: 100,
    pii: RING,
    transaction: (fn) => db.transaction(fn)(),
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

function mint(tenantId = TENANT, ssn: string | undefined = SSN): string {
  const r = createCompany(deps(), tenantId, {
    partyId: newParty(tenantId),
    names: ["Acme One", "Acme Two", "Acme Three"],
    businessPurpose: "Original purpose.",
    industryLabel: DEFAULT_INDUSTRY,
    ssn,
  });
  if ("error" in r) throw new Error(r.error);
  return r.companyId;
}

const EDIT = {
  names: ["Fixed One", "Fixed Two", "Fixed Three"],
  businessPurpose: "Corrected purpose.",
  industryLabel: DEFAULT_INDUSTRY,
};

/** The shape a REJECTED create leaves behind: a burned attempt, so the key is fresh. */
function rejected(companyId: string): void {
  requests.claimAllSteps(companyId);
  requests.transition(companyId, "create_provider", "pending", "submitted", {
    detail: JSON.stringify({ companySentAttempt: 0, ssnIncluded: true }),
  });
  requests.bumpAttempt(companyId, "create_provider", "submitted");
  requests.transition(companyId, "create_provider", "pending", "failed", { error: "rejected" });
}

// ── the happy path ─────────────────────────────────────────────────────────────────────────

test("after a REJECTED create, the intake is re-openable and the SSN re-captured", () => {
  const companyId = mint();
  const before = parties.findSsnByCompanyId(companyId)!;
  rejected(companyId);

  expect(updateCompanyIntake(deps(), TENANT, companyId, { ...EDIT, ssn: SSN_2 })).toEqual({
    companyId,
  });

  const company = companies.find(companyId)!;
  expect(company.nameOptions.map((n) => n.name)).toEqual(["Fixed One", "Fixed Two", "Fixed Three"]);
  expect(company.businessPurpose).toBe("Corrected purpose.");
  // A HUMAN typed it, so the synthesized marker comes off.
  expect(company.intakeSynthesized).toBe(false);

  // The NEW SSN is what the next body will carry, sealed under the same (party, company).
  const after = parties.findSsnByCompanyId(companyId)!;
  expect(after.partyId).toBe(before.partyId);
  expect(decryptSsn(RING, after, { partyId: after.partyId, companyId }).reveal()).toBe(SSN_2);
  // …and the row does not hold a live ciphertext under an "erased on" stamp.
  const row = db
    .prepare("SELECT ssn_deleted_at FROM formation_parties WHERE company_id = ?")
    .get(companyId) as { ssn_deleted_at: string | null };
  expect(row.ssn_deleted_at).toBeNull();
});

test("the intake can be re-opened WITHOUT a new SSN — the old one is kept, not silently dropped", () => {
  // Omitting a field is not the same as clearing it. A caller fixing a NAME must not lose the
  // fast EIN route as a side effect.
  const companyId = mint();
  rejected(companyId);
  expect(updateCompanyIntake(deps(), TENANT, companyId, EDIT)).toEqual({ companyId });
  const stored = parties.findSsnByCompanyId(companyId)!;
  expect(decryptSsn(RING, stored, { partyId: stored.partyId, companyId }).reveal()).toBe(SSN);
});

// ── the freeze ─────────────────────────────────────────────────────────────────────────────

test("a LIVE key freezes the intake, and the refusal names the one case that is not frozen", () => {
  const companyId = mint();
  // Sent under the CURRENT attempt and parked WITHOUT a burn — a lost answer. doola may hold a
  // body under the key the next pass will use.
  requests.claimAllSteps(companyId);
  requests.transition(companyId, "create_provider", "pending", "submitted", {
    detail: JSON.stringify({ companySentAttempt: 0, ssnIncluded: true }),
  });
  requests.transition(companyId, "create_provider", "submitted", "failed", { error: "lost" });

  expect(updateCompanyIntake(deps(), TENANT, companyId, { ...EDIT, ssn: SSN_2 })).toEqual({
    error: companyIntakeFrozenMessage(),
  });
  // NOTHING moved — not the names, and not the SSN the frozen body carries.
  expect(companies.find(companyId)!.businessPurpose).toBe("Original purpose.");
  const stored = parties.findSsnByCompanyId(companyId)!;
  expect(decryptSsn(RING, stored, { partyId: stored.partyId, companyId }).reveal()).toBe(SSN);
});

test("a CORRUPT detail blob answers 'frozen' — it does not throw a 500 out of the door", () => {
  // `json_extract` on a blob that is not JSON is a SQLite ERROR, and the freeze predicate lives in
  // the WHERE clause of the UPDATE — so an unreadable `detail` used to take an ordinary PATCH out
  // as a 500 with no answer at all. `json_valid`-guarded it is FROZEN, which is the safe
  // direction: clause 3 cannot be evaluated, and an editable answer would send a new body under a
  // key that may still be live.
  const companyId = mint();
  requests.claimAllSteps(companyId);
  db.prepare(
    "UPDATE formation_requests SET detail = ? WHERE company_id = ? AND step = 'create_provider'",
  ).run("{not json", companyId);

  let answer: unknown;
  expect(() => {
    answer = updateCompanyIntake(deps(), TENANT, companyId, { ...EDIT, ssn: SSN_2 });
  }).not.toThrow();
  expect(answer).toEqual({ error: companyIntakeFrozenMessage() });
  expect(companies.find(companyId)!.businessPurpose).toBe("Original purpose.");
});

test("the whole update is ONE transaction: a frozen row leaves the SSN untouched", () => {
  // The half-applied states are both worse than either half failing: a re-opened intake with the
  // old SSN attached, or a new SSN attached to un-rewritten names.
  const companyId = mint();
  requests.claimAllSteps(companyId);
  requests.transition(companyId, "create_provider", "pending", "confirmed", {
    providerRef: "cmp_1",
  });
  expect(updateCompanyIntake(deps(), TENANT, companyId, { ...EDIT, ssn: SSN_2 })).toEqual({
    error: companyIntakeFrozenMessage(),
  });
  expect(companies.find(companyId)!.nameOptions[0]!.name).toBe("Acme One");
});

// ── ownership and validation ───────────────────────────────────────────────────────────────

test("an unknown or FOREIGN company gets one answer — not an existence oracle", () => {
  const theirs = mint(OTHER, undefined);
  expect(updateCompanyIntake(deps(), TENANT, theirs, EDIT)).toEqual({
    error: companyUnavailableMessage(),
  });
  expect(updateCompanyIntake(deps(), TENANT, "no-such-id", EDIT)).toEqual({
    error: companyUnavailableMessage(),
  });
});

test("it runs the SAME validation as the create — one set of rules, two doors", () => {
  const companyId = mint();
  rejected(companyId);
  expect(
    updateCompanyIntake(deps(), TENANT, companyId, {
      ...EDIT,
      names: ["Acme Bank", "B Works", "C Works"],
    }),
  ).toEqual({ error: companyNameRestrictedMessage(1, "bank") });
  expect(
    updateCompanyIntake(deps(), TENANT, companyId, { ...EDIT, industryLabel: "Nope" }),
  ).toEqual({ error: industryLabelUnknownMessage("Nope") });
  expect(updateCompanyIntake(deps(), TENANT, companyId, { ...EDIT, ssn: "12345" })).toEqual({
    error: ssnFormatMessage(),
  });
  // …and nothing was written by any of them.
  expect(companies.find(companyId)!.businessPurpose).toBe("Original purpose.");
});

test("a SANDBOX deployment refuses the ssn here too — the same gate, one field down", () => {
  const sandbox = deps({ pin: { provider: "doola", environment: "sandbox" } });
  const r = createCompany(sandbox, TENANT, {
    partyId: newParty(),
    names: ["Acme One", "Acme Two", "Acme Three"],
    businessPurpose: "p",
    industryLabel: DEFAULT_INDUSTRY,
  });
  const companyId = (r as { companyId: string }).companyId;
  expect(updateCompanyIntake(sandbox, TENANT, companyId, { ...EDIT, ssn: SSN })).toEqual({
    error: ssnRefusedHereMessage(),
  });
});
