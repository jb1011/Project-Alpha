/**
 * THE PARTY-EDIT DOOR (design §7, A3) — the exit A2 wrote a park for and could not give.
 *
 * A2's finding 5b: `create_provider` sends TWO bodies, and either can be the one doola refused. A
 * rejected COMPANY intake parks under `awaitingIntakeEdit`, which `PATCH /companies/:id` clears;
 * a rejected responsible PARTY parks under `awaitingPartyEdit`, and none of the four fields that
 * door rewrites is one `createCustomer` reads. `rearmAfterPartyEdit` was exported and waiting.
 *
 * The two properties that matter:
 *
 *  1. a parked party, edited, buys EXACTLY ONE retry — with the new body, and only the party's
 *     own flag cleared;
 *  2. a party whose filing has been SENT is frozen. Not for the company intake's reason (an
 *     idempotency key doola is holding) but for a sharper one: the create step re-sends
 *     `createCustomer` only when `detail.customerId` is absent, so once a customer exists at
 *     doola an edit would change our copy of a person and change NOTHING about the filing, while
 *     telling the caller it had.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  companyUnavailableMessage,
  formationPartyUnavailableMessage,
  partyFrozenMessage,
  partyUnchangedMessage,
  syntheticPiiRefusedMessage,
  syntheticPiiRequiredMessage,
} from "../../src/formation";
import { updateCompanyParty } from "../../src/formation/company";
import { companyNameOptions } from "../../src/formation/intake";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";

let db: DatabaseType.Database;
let parties: SqliteFormationPartyRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  parties = new SqliteFormationPartyRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
});
afterEach(() => db.close());

const deps = (sandboxSyntheticPii = false) => ({
  companies,
  parties,
  requests,
  sandboxSyntheticPii,
  transaction: <T>(fn: () => T) => fn(),
});

const CORRECTED = {
  legalFirstName: "Grace",
  legalLastName: "Hopper",
  email: "grace@example.com",
  phone: "+12125550199",
  line1: "2 Compiler Way",
  line2: null,
  city: "Sheridan",
  region: "WY",
  postalCode: "82801",
  country: "USA",
};

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

function newCompany(partyId: string, tenantId = TENANT): string {
  const companyId = companies.create({
    tenantId,
    status: "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: companyNameOptions("Acme One", "Acme Two", "Acme Three"),
    businessPurpose: "p",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
  parties.bindToCompany(partyId, companyId, tenantId);
  return companyId;
}

/** The shape `onCallFailure` leaves behind when doola REFUSES the party's body. Re-parkable, so
 *  a test can put a company back where a second rejection would. */
function parkAwaitingPartyEdit(companyId: string, detail: Record<string, unknown> = {}) {
  const existing = requests.find(companyId, "create_provider");
  if (!existing) requests.claimStep(companyId, "create_provider");
  requests.transition(companyId, "create_provider", existing?.state ?? "pending", "failed", {
    detail: JSON.stringify({ awaitingPartyEdit: true, ...detail }),
    error: "E_VALIDATION_FAILED: one or more fields are invalid",
  });
}

// ── the synthetic-PII gate, in BOTH directions (§3, audit H7) ───────────────────────────────

/**
 * The edit door is a PII intake, and it was the one that did not run the intake gate.
 *
 * `createFormationParty` refuses real personal data on a `sandboxSyntheticPii` deployment and
 * refuses the synthetic shortcut on a production one; `createCompany` re-asserts the same rule
 * against the party ROW. This door rewrote the ten identity columns with neither check, so on a
 * sandbox box a real name, email, phone and home address could be written into a party the
 * deployment had minted as a labeled fixture — and then filed to doola's DEVELOPMENT environment
 * as the responsible person, which is exactly the harm the sandbox refusal exists to prevent.
 */
test("a SANDBOX deployment refuses a real identity at the edit door, in the create's words", () => {
  const partyId = newParty();
  const companyId = newCompany(partyId);
  parkAwaitingPartyEdit(companyId);

  expect(updateCompanyParty(deps(true), TENANT, companyId, CORRECTED)).toEqual({
    error: syntheticPiiRequiredMessage(),
  });
  // Nothing was written: the refusal is the whole answer, as it is on every other door.
  expect(parties.findOwned(TENANT, partyId)!.legalFirstName).toBe("Ada");
});

test("a PRODUCTION deployment refuses to edit a SYNTHETIC party, in the create's words", () => {
  // The mirror image, and the reason it is checked against the ROW rather than the request: the
  // party was minted through the same gate, so a mismatch is a bug — but a bug that would put a
  // real person's identity onto a filing labeled synthetic on every surface that shows it.
  const partyId = parties.create({
    tenantId: TENANT,
    legalFirstName: "Sandbox",
    legalLastName: "Fixture",
    email: "sandbox@novicorpus.com",
    phone: "+13075550100",
    line1: "1 Demo Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: true,
  });
  const companyId = newCompany(partyId);
  parkAwaitingPartyEdit(companyId);

  expect(updateCompanyParty(deps(false), TENANT, companyId, CORRECTED)).toEqual({
    error: syntheticPiiRefusedMessage(),
  });
  expect(parties.findOwned(TENANT, partyId)!.legalFirstName).toBe("Sandbox");
});

// ── ownership ───────────────────────────────────────────────────────────────────────────────

test("unknown and FOREIGN companies get the SAME message every other company door gives", () => {
  const foreign = newCompany(newParty(OTHER), OTHER);
  for (const companyId of ["00000000-0000-4000-8000-000000000000", foreign])
    expect(updateCompanyParty(deps(), TENANT, companyId, CORRECTED)).toEqual({
      error: companyUnavailableMessage(),
    });
  // …and the other tenant's identity is untouched.
  expect(parties.findByCompanyId(foreign)!.legalFirstName).toBe("Ada");
});

/**
 * THE REASON THE DOOR IS ADDRESSED BY COMPANY (§7).
 *
 * Its first version took a `partyId`, so the only thing between a mistyped uuid and an identity
 * swap on the WRONG Wyoming LLC was `partyEditAllowed` — and both of this tenant's companies are
 * parked, so both pass it. Addressed by company the party is RESOLVED rather than named, and
 * "edit the other company's person" is not a request that can be expressed.
 */
test("two parked companies, one tenant: fixing one cannot touch the other's person", () => {
  const partyA = newParty();
  const companyA = newCompany(partyA);
  parkAwaitingPartyEdit(companyA);
  const partyB = parties.create({
    tenantId: TENANT,
    legalFirstName: "Alan",
    legalLastName: "Turing",
    email: "alan@example.com",
    phone: "+12125550111",
    line1: "3 Bletchley Rd",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
  const companyB = newCompany(partyB);
  parkAwaitingPartyEdit(companyB);

  expect(updateCompanyParty(deps(), TENANT, companyA, CORRECTED)).toEqual({ partyId: partyA });

  // A got the correction; B is untouched, identity and park alike.
  expect(parties.findOwned(TENANT, partyA)!.legalFirstName).toBe("Grace");
  expect(parties.findOwned(TENANT, partyB)!.legalFirstName).toBe("Alan");
  expect(JSON.parse(requests.find(companyB, "create_provider")!.detail!).awaitingPartyEdit).toBe(
    true,
  );
});

test("a company with NO bound party is refused rather than answered with somebody else's", () => {
  // Unreachable through the doors (`createCompany` binds inside the mint transaction), and that
  // is exactly why the refusal must exist: a resolve that found nothing must never fall through
  // to a scan.
  const companyId = companies.create({
    tenantId: TENANT,
    status: "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: companyNameOptions("Orphan One", "Orphan Two", "Orphan Three"),
    businessPurpose: "p",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
  expect(updateCompanyParty(deps(), TENANT, companyId, CORRECTED)).toEqual({
    error: formationPartyUnavailableMessage(),
  });
});

// ── the park, and its one retry ─────────────────────────────────────────────────────────────

test("a PARKED party is edited, and the edit buys exactly one retry with the new body", () => {
  const partyId = newParty();
  const companyId = newCompany(partyId);
  parkAwaitingPartyEdit(companyId);

  expect(updateCompanyParty(deps(), TENANT, companyId, CORRECTED)).toEqual({ partyId });

  // 1. The identity is the NEW one — which is the body the next `createCustomer` will send.
  const after = parties.findOwned(TENANT, partyId)!;
  expect(after).toMatchObject({
    legalFirstName: "Grace",
    legalLastName: "Hopper",
    email: "grace@example.com",
    city: "Sheridan",
  });
  // 2. The park is CLEARED, so the sweeper may touch the row again — and the row is still
  //    `failed` with its error text intact, because the operator trail should still say what
  //    doola refused.
  const row = requests.find(companyId, "create_provider")!;
  expect(row.state).toBe("failed");
  expect(row.error).toMatch(/E_VALIDATION_FAILED/);
  expect(JSON.parse(row.detail!)).not.toHaveProperty("awaitingPartyEdit");
  // 3. ONE retry: a second edit is needed for a second one, which is the whole rule. Re-arming a
  //    row that is not parked is a no-op, so the flag does not come back.
  expect(updateCompanyParty(deps(), TENANT, companyId, { ...CORRECTED, city: "Casper" })).toEqual({
    partyId,
  });
  expect(JSON.parse(requests.find(companyId, "create_provider")!.detail!)).not.toHaveProperty(
    "awaitingPartyEdit",
  );
});

// ── an edit that changes NOTHING ────────────────────────────────────────────────────────────

/**
 * Re-submitting the details already on file is not evidence of anything.
 *
 * The park is cleared because a CHANGED identity is evidence that the next `createCustomer` will
 * carry a different body. An unchanged resubmission re-arms a retry of the exact body doola
 * looked at and refused — the loop the park exists to stop — and burns an attempt doing it.
 *
 * It cannot be detected from the write: SQLite's `changes` counts rows MATCHED, not rows whose
 * values differ, so an UPDATE setting every column to the value it already held reports 1.
 */
test("an UNCHANGED resubmission does not clear the park and does not burn an attempt", () => {
  const partyId = newParty();
  const companyId = newCompany(partyId);
  parkAwaitingPartyEdit(companyId);
  const before = requests.find(companyId, "create_provider")!;

  // The identity exactly as `newParty` wrote it, re-sent field for field.
  const same = {
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
  };
  expect(updateCompanyParty(deps(), TENANT, companyId, same)).toEqual({
    error: partyUnchangedMessage(),
  });

  const after = requests.find(companyId, "create_provider")!;
  expect(JSON.parse(after.detail!).awaitingPartyEdit).toBe(true);
  expect(after.attempt).toBe(before.attempt);
  expect(after.state).toBe(before.state);
});

test("ONE field different is a change — and it re-arms exactly once", () => {
  const partyId = newParty();
  const companyId = newCompany(partyId);
  parkAwaitingPartyEdit(companyId);

  const oneFieldDifferent = {
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    // The one the provider might well have objected to.
    country: "GBR",
  };
  expect(updateCompanyParty(deps(), TENANT, companyId, oneFieldDifferent)).toEqual({ partyId });
  expect(JSON.parse(requests.find(companyId, "create_provider")!.detail!)).not.toHaveProperty(
    "awaitingPartyEdit",
  );
  expect(parties.findOwned(TENANT, partyId)!.country).toBe("GBR");

  // …and re-sending THAT body is now the unchanged case, so it does not re-arm anything either.
  parkAwaitingPartyEdit(companyId);
  expect(updateCompanyParty(deps(), TENANT, companyId, oneFieldDifferent)).toEqual({
    error: partyUnchangedMessage(),
  });
  expect(JSON.parse(requests.find(companyId, "create_provider")!.detail!).awaitingPartyEdit).toBe(
    true,
  );
});

/**
 * THE FREEZE LIVES IN THE STATEMENT, not only above it.
 *
 * The domain function asks the TypeScript predicate so it can return the actionable refusal. This
 * asserts the second lock: a caller reaching `parties.update` directly — a new door, a script, a
 * repository method somebody adds next month — cannot rewrite the identity on a filing that has
 * already been sent.
 */
test("parties.update refuses a frozen row by itself, with no domain function above it", () => {
  const partyId = newParty();
  const companyId = newCompany(partyId);
  requests.claimStep(companyId, "create_provider");
  requests.transition(companyId, "create_provider", "pending", "failed", {
    detail: JSON.stringify({ customerId: "cus-1" }),
  });

  expect(parties.update(partyId, TENANT, companyId, CORRECTED)).toBe(false);
  expect(parties.findOwned(TENANT, partyId)!.legalFirstName).toBe("Ada");

  // …and the statement is bound to the (party, company) PAIR: naming another company does not
  // move this row either.
  const otherParty = parties.create({
    tenantId: TENANT,
    legalFirstName: "Alan",
    legalLastName: "Turing",
    email: "alan@example.com",
    phone: "+12125550111",
    line1: "3 Bletchley Rd",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
  const otherCompany = newCompany(otherParty);
  expect(parties.update(partyId, TENANT, otherCompany, CORRECTED)).toBe(false);
  expect(parties.findOwned(TENANT, partyId)!.legalFirstName).toBe("Ada");
});

test("it clears its OWN flag only — an intake park is NOT re-armed by a party edit", () => {
  // Finding 5b, from the other side. A door that cleared both would re-arm a retry of a company
  // body nobody had changed, which is the exact loop the park exists to stop.
  const partyId = newParty();
  const companyId = newCompany(partyId);
  parkAwaitingPartyEdit(companyId, { awaitingIntakeEdit: true });

  updateCompanyParty(deps(), TENANT, companyId, CORRECTED);
  const detail = JSON.parse(requests.find(companyId, "create_provider")!.detail!);
  expect(detail.awaitingPartyEdit).toBeUndefined();
  expect(detail.awaitingIntakeEdit).toBe(true);
});

// ── the freeze ──────────────────────────────────────────────────────────────────────────────

test("a party whose filing has a CUSTOMER at doola is frozen — the edit would change nothing", () => {
  // The create step re-sends `createCustomer` only when `detail.customerId` is absent. After
  // that, doola has the person and will never be asked for them again.
  const partyId = newParty();
  const companyId = newCompany(partyId);
  requests.claimStep(companyId, "create_provider");
  requests.transition(companyId, "create_provider", "pending", "failed", {
    detail: JSON.stringify({ customerId: "cus-1" }),
  });

  expect(updateCompanyParty(deps(), TENANT, companyId, CORRECTED)).toEqual({
    error: partyFrozenMessage(),
  });
  expect(parties.findOwned(TENANT, partyId)!.legalFirstName).toBe("Ada");
});

test("a SENT, SUBMITTED or FILED company's party is frozen; an unopened one's is not", () => {
  for (const [label, apply] of [
    [
      "submitted",
      (id: string) => requests.transition(id, "create_provider", "pending", "submitted"),
    ],
    [
      "provider_ref",
      (id: string) =>
        requests.transition(id, "create_provider", "pending", "confirmed", { providerRef: "c1" }),
    ],
    [
      "company body sent",
      (id: string) =>
        requests.transition(id, "create_provider", "pending", "failed", {
          detail: JSON.stringify({ companySentAttempt: 0 }),
        }),
    ],
    [
      "unreadable detail",
      (id: string) =>
        db.prepare("UPDATE formation_requests SET detail = '{oops' WHERE company_id = ?").run(id),
    ],
  ] as const) {
    const partyId = newParty();
    const companyId = newCompany(partyId);
    requests.claimStep(companyId, "create_provider");
    apply(companyId);
    expect(updateCompanyParty(deps(), TENANT, companyId, CORRECTED), label).toEqual({
      error: partyFrozenMessage(),
    });
  }

  // …and the everyday case: a company whose filing has not been opened at all.
  const partyId = newParty();
  const companyId = newCompany(partyId);
  expect(updateCompanyParty(deps(), TENANT, companyId, CORRECTED)).toEqual({ partyId });
  expect(parties.findOwned(TENANT, partyId)!.legalFirstName).toBe("Grace");
});

// ── what it must NOT touch ──────────────────────────────────────────────────────────────────

test("the bind, the synthetic marker and the SSN columns all survive an edit", () => {
  const partyId = newParty();
  const companyId = newCompany(partyId);
  // NOT `synthetic = 1`: a synthetic row is unreachable through this door on EITHER kind of
  // deployment (a production box refuses the row, a sandbox box refuses the real body), which is
  // the gate asserted above. What this test pins is that the marker the row does carry is not
  // rewritten by an edit, together with the bind and the sealed SSN.
  db.prepare(
    `UPDATE formation_parties
        SET ssn_ciphertext = X'0102', ssn_iv = X'03', ssn_key_id = 'fpk1:abc',
            ssn_captured_at = '2026-09-01 00:00:00'
      WHERE party_id = ?`,
  ).run(partyId);

  expect(updateCompanyParty(deps(), TENANT, companyId, CORRECTED)).toEqual({ partyId });

  const row = db.prepare("SELECT * FROM formation_parties WHERE party_id = ?").get(partyId) as {
    company_id: string;
    synthetic: number;
    tenant_id: string;
    ssn_ciphertext: Buffer | null;
    ssn_key_id: string | null;
    ssn_captured_at: string | null;
  };
  // The bind is single-use and this is not a re-bind; `synthetic` is a property of the deployment
  // the party was created against, not of a request; and an SSN cannot arrive at this door at all,
  // so nothing here may disturb the one already sealed against (party, company).
  expect(row.company_id).toBe(companyId);
  expect(row.synthetic).toBe(0);
  expect(row.tenant_id).toBe(TENANT);
  expect(row.ssn_ciphertext).not.toBeNull();
  expect(row.ssn_key_id).toBe("fpk1:abc");
  expect(row.ssn_captured_at).toBe("2026-09-01 00:00:00");
});
