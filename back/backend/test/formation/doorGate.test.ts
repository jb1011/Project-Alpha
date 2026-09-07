/**
 * The formation door gate (design §2/§5/§7) — ONE function, so REST /onboard and MCP
 * onboard_agent cannot disagree about the ORDER of the checks or the wording of a refusal.
 *
 * ⚠ A3 REMOVED THE SHIM, and with it everything this door used to spend. Under A1 a party-only
 * onboard minted a company inside the claim, so the tenant quota, the platform daily ceiling and
 * the party's single-use rule all had to be enforced HERE. They now live in `createCompany`
 * behind `POST /companies` / `create_company`, where the money is actually spent, and
 * `test/formation/createCompany.test.ts` is where they are asserted. What is left is
 * availability, the mandatory flag, and the ATTACH predicate — and the one new rule, which is
 * that a `partyId` at this door is REFUSED rather than ignored.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  companyAgentCapMessage,
  companyUnavailableMessage,
  formationDoorRefusal,
  formationPartyRequiredMessage,
  formationUnavailableMessage,
} from "../../src/formation";
import { companyNameOptions } from "../../src/formation/intake";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";

let db: DatabaseType.Database;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let companies: SqliteCompanyRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  companies = new SqliteCompanyRepository(db);
});
afterEach(() => db.close());

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

function deps(over: { required?: boolean; maxAgentsPerCompany?: number } = {}) {
  return {
    formation: {
      required: over.required ?? true,
      maxAgentsPerCompany: over.maxAgentsPerCompany ?? 10,
      requests,
      companies,
    },
  };
}

/** A company the tenant owns, in whatever state the case under test needs. */
function newCompany(
  over: { tenantId?: string; status?: "draft" | "ready" | "abandoned"; companyId?: string } = {},
): string {
  return companies.create({
    companyId: over.companyId,
    tenantId: over.tenantId ?? TENANT,
    status: over.status ?? "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: companyNameOptions("Acme"),
    businessPurpose: "purpose",
    industryLabel: "Software development",
    intakeSynthesized: true,
  });
}

// ── availability ────────────────────────────────────────────────────────────────────────────

test("a deployment that forms nothing: no gate at all, but a partyId is REFUSED not ignored", () => {
  expect(formationDoorRefusal({}, { tenantId: TENANT })).toBeNull();
  // Silently dropping a legal identity the caller believed they were filing with is the worse
  // failure, so the absent-provider case has its own named message.
  expect(formationDoorRefusal({}, { tenantId: TENANT, partyId: "p" })).toBe(
    formationUnavailableMessage(),
  );
});

// ── the party handle: REFUSED, never ignored (A3) ───────────────────────────────────────────

test("a partyId at THIS door is refused, and the refusal names the door that mints a company", () => {
  // A1's shim turned one into a 1:1 company inside the claim. With it gone, ignoring the field
  // would accept an onboard from a caller who had just registered a real legal identity and
  // believed it was being filed — the exact failure `formationUnavailableMessage` exists to
  // prevent on the other kind of deployment.
  const msg = formationDoorRefusal(deps(), { tenantId: TENANT, partyId: newParty() });
  expect(msg).toBe(formationPartyRequiredMessage());
  expect(msg).toMatch(/POST \/companies/);
  expect(msg).toMatch(/create_company/);
  expect(msg).toMatch(/partyId is not accepted here/);
});

test("…on EVERY deployment that forms, mandatory or not, valid handle or not", () => {
  for (const required of [true, false])
    for (const partyId of [newParty(), "00000000-0000-4000-8000-000000000000", newParty(OTHER)])
      expect(formationDoorRefusal(deps({ required }), { tenantId: TENANT, partyId })).toBe(
        formationPartyRequiredMessage(),
      );
});

test("a partyId BESIDE a valid companyId is still refused — one handle, one meaning", () => {
  // It used to be its own "pass either… not both" sentence. There is no longer a `both` to
  // disambiguate: the party door and the company door are different doors, and neither is here.
  const companyId = newCompany();
  expect(formationDoorRefusal(deps(), { tenantId: TENANT, companyId, partyId: newParty() })).toBe(
    formationPartyRequiredMessage(),
  );
});

// ── the mandatory flag ──────────────────────────────────────────────────────────────────────

test("REQUIRED + no companyId → the single-sourced refusal", () => {
  expect(formationDoorRefusal(deps(), { tenantId: TENANT })).toBe(formationPartyRequiredMessage());
});

test("NOT required + no handle at all → allowed (formation is opt-in there)", () => {
  expect(formationDoorRefusal(deps({ required: false }), { tenantId: TENANT })).toBeNull();
});

// ── attach ──────────────────────────────────────────────────────────────────────────────────

test("a READY company the tenant owns is attachable", () => {
  expect(formationDoorRefusal(deps(), { tenantId: TENANT, companyId: newCompany() })).toBeNull();
});

test("unknown, FOREIGN, DRAFT and ABANDONED companies get the SAME message", () => {
  // One message for all four, for the reason the party rule had one: distinguishing them turns
  // the door into an existence oracle over another tenant's company ids.
  const foreign = newCompany({ tenantId: OTHER, companyId: "c-foreign" });
  const draft = newCompany({ status: "draft", companyId: "c-draft" });
  const abandoned = newCompany({ status: "abandoned", companyId: "c-abandoned" });
  for (const companyId of ["c-nope", foreign, draft, abandoned])
    expect(formationDoorRefusal(deps(), { tenantId: TENANT, companyId })).toBe(
      companyUnavailableMessage(),
    );
});

test("a company whose create_provider FAILED is refused — the filing will not happen", () => {
  const companyId = newCompany({ companyId: "c-failed" });
  db.prepare("INSERT INTO formation_requests (company_id, step, state) VALUES (?,?,?)").run(
    companyId,
    "create_provider",
    "failed",
  );
  expect(formationDoorRefusal(deps(), { tenantId: TENANT, companyId })).toBe(
    companyUnavailableMessage(),
  );
});

test("a company already at the agent cap is refused, and the message says the limit", () => {
  const companyId = newCompany({ companyId: "c-full" });
  db.prepare(
    "INSERT INTO entities (idempotency_key, name, status, manager, guardian, amendment_delay, ein, formation_date, owner_tenant_id, spec_json, company_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("e-1", "n", "bound", "0x1", "0x2", "0", "STUB", 0, TENANT, "{}", companyId);
  expect(
    formationDoorRefusal(deps({ maxAgentsPerCompany: 1 }), { tenantId: TENANT, companyId }),
  ).toBe(companyAgentCapMessage(1));
  // …and one under the cap is still allowed.
  expect(
    formationDoorRefusal(deps({ maxAgentsPerCompany: 2 }), { tenantId: TENANT, companyId }),
  ).toBeNull();
});

test("ORDER: the party refusal runs BEFORE the mandatory flag and before the attach", () => {
  // Both surfaces hear the same primary error, and it is the one the caller can act on: they are
  // holding a handle this door does not take.
  expect(formationDoorRefusal(deps(), { tenantId: TENANT, partyId: newParty() })).toBe(
    formationPartyRequiredMessage(),
  );
  expect(
    formationDoorRefusal(deps(), { tenantId: TENANT, partyId: newParty(), companyId: "c-nope" }),
  ).toBe(formationPartyRequiredMessage());
});
