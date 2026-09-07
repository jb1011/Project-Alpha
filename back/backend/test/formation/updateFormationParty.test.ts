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
import { formationPartyUnavailableMessage, partyFrozenMessage } from "../../src/formation";
import { updateFormationParty } from "../../src/formation/company";
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

const deps = () => ({ parties, requests, transaction: <T>(fn: () => T) => fn() });

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

function newCompany(partyId: string): string {
  const companyId = companies.create({
    tenantId: TENANT,
    status: "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: companyNameOptions("Acme One", "Acme Two", "Acme Three"),
    businessPurpose: "p",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
  parties.bindToCompany(partyId, companyId, TENANT);
  return companyId;
}

/** The shape `onCallFailure` leaves behind when doola REFUSES the party's body. */
function parkAwaitingPartyEdit(companyId: string, detail: Record<string, unknown> = {}) {
  requests.claimStep(companyId, "create_provider");
  requests.transition(companyId, "create_provider", "pending", "failed", {
    detail: JSON.stringify({ awaitingPartyEdit: true, ...detail }),
    error: "E_VALIDATION_FAILED: one or more fields are invalid",
  });
}

// ── ownership ───────────────────────────────────────────────────────────────────────────────

test("unknown, FOREIGN and erased parties get the SAME message the other doors give", () => {
  const foreign = newParty(OTHER);
  const erased = newParty();
  parties.erase(erased);
  for (const partyId of ["00000000-0000-4000-8000-000000000000", foreign, erased])
    expect(updateFormationParty(deps(), TENANT, partyId, CORRECTED)).toEqual({
      error: formationPartyUnavailableMessage(),
    });
});

// ── the park, and its one retry ─────────────────────────────────────────────────────────────

test("a PARKED party is edited, and the edit buys exactly one retry with the new body", () => {
  const partyId = newParty();
  const companyId = newCompany(partyId);
  parkAwaitingPartyEdit(companyId);

  expect(updateFormationParty(deps(), TENANT, partyId, CORRECTED)).toEqual({ partyId });

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
  expect(updateFormationParty(deps(), TENANT, partyId, CORRECTED)).toEqual({ partyId });
  expect(JSON.parse(requests.find(companyId, "create_provider")!.detail!)).not.toHaveProperty(
    "awaitingPartyEdit",
  );
});

test("it clears its OWN flag only — an intake park is NOT re-armed by a party edit", () => {
  // Finding 5b, from the other side. A door that cleared both would re-arm a retry of a company
  // body nobody had changed, which is the exact loop the park exists to stop.
  const partyId = newParty();
  const companyId = newCompany(partyId);
  parkAwaitingPartyEdit(companyId, { awaitingIntakeEdit: true });

  updateFormationParty(deps(), TENANT, partyId, CORRECTED);
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

  expect(updateFormationParty(deps(), TENANT, partyId, CORRECTED)).toEqual({
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
    expect(updateFormationParty(deps(), TENANT, partyId, CORRECTED), label).toEqual({
      error: partyFrozenMessage(),
    });
  }

  // …and the everyday case: a company whose filing has not been opened at all.
  const partyId = newParty();
  newCompany(partyId);
  expect(updateFormationParty(deps(), TENANT, partyId, CORRECTED)).toEqual({ partyId });
});

test("an UNBOUND party is editable — nothing has been filed with it", () => {
  const partyId = newParty();
  expect(updateFormationParty(deps(), TENANT, partyId, CORRECTED)).toEqual({ partyId });
  expect(parties.findOwned(TENANT, partyId)!.legalFirstName).toBe("Grace");
});

// ── what it must NOT touch ──────────────────────────────────────────────────────────────────

test("the bind, the synthetic marker and the SSN columns all survive an edit", () => {
  const partyId = newParty();
  const companyId = newCompany(partyId);
  db.prepare(
    `UPDATE formation_parties
        SET synthetic = 1, ssn_ciphertext = X'0102', ssn_iv = X'03', ssn_key_id = 'fpk1:abc',
            ssn_captured_at = '2026-09-01 00:00:00'
      WHERE party_id = ?`,
  ).run(partyId);

  expect(updateFormationParty(deps(), TENANT, partyId, CORRECTED)).toEqual({ partyId });

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
  expect(row.synthetic).toBe(1);
  expect(row.tenant_id).toBe(TENANT);
  expect(row.ssn_ciphertext).not.toBeNull();
  expect(row.ssn_key_id).toBe("fpk1:abc");
  expect(row.ssn_captured_at).toBe("2026-09-01 00:00:00");
});
