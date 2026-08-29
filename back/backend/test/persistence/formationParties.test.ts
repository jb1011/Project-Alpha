/**
 * The PII table (design §3/§5). Three properties are load-bearing:
 *  - a party exists BEFORE its entity does, so it is keyed by partyId and owns its own tenant;
 *  - it binds to at most ONE entity, exactly once (re-using a bound party would file two
 *    companies on one person's consent);
 *  - ownership is enforced in the query, not by the caller, and an erased party is invisible to
 *    every read — a lookup that ignored `deleted_at` would file with data we destroyed.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type NewFormationParty,
  SqliteFormationPartyRepository,
} from "../../src/persistence/formationPartyRepository";

const TENANT_A = "0x000000000000000000000000000000000000000A";
const TENANT_B = "0x000000000000000000000000000000000000000B";

function party(tenantId: string, over: Partial<NewFormationParty> = {}): NewFormationParty {
  return {
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
    ...over,
  };
}

let db: DatabaseType.Database;
let parties: SqliteFormationPartyRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  parties = new SqliteFormationPartyRepository(db);
});
afterEach(() => db.close());

test("the table is keyed by partyId, carries its tenant, and starts UNBOUND", () => {
  const id = parties.create(party(TENANT_A));
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // a uuid, minted here — never caller-supplied
  const rec = parties.findOwned(TENANT_A, id)!;
  expect(rec.entityKey).toBeNull();
  expect(rec.tenantId).toBe(TENANT_A);
  expect(rec.synthetic).toBe(false);
  expect(rec.region).toBe("WY");
});

test("tenant isolation: another tenant cannot read a party by its id", () => {
  const id = parties.create(party(TENANT_A));
  expect(parties.findOwned(TENANT_B, id)).toBeUndefined();
  expect(parties.findOwned(TENANT_A, id)).toBeDefined();
});

test("the company bind is a CAS: it moves once, for the owner only, and never twice", () => {
  const id = parties.create(party(TENANT_A));

  // A foreign tenant cannot bind it, even knowing the id.
  expect(parties.bindToCompany(id, "company-b", TENANT_B)).toBe(false);

  expect(parties.bindToCompany(id, "company-a", TENANT_A)).toBe(true);
  expect(parties.findOwned(TENANT_A, id)!.companyId).toBe("company-a");

  // Second bind — the SINGLE-USE rule, "two companies on one consent" — loses.
  expect(parties.bindToCompany(id, "company-other", TENANT_A)).toBe(false);
  expect(parties.findOwned(TENANT_A, id)!.companyId).toBe("company-a");
});

test("one party per company: the UNIQUE company_id refuses a second binding to the same company", () => {
  const first = parties.create(party(TENANT_A));
  const second = parties.create(party(TENANT_A));
  expect(parties.bindToCompany(first, "company-a", TENANT_A)).toBe(true);
  expect(() => parties.bindToCompany(second, "company-a", TENANT_A)).toThrow(/UNIQUE/);
});

test("findByCompanyId is what create_provider files with", () => {
  const id = parties.create(party(TENANT_A, { legalFirstName: "Grace" }));
  expect(parties.findByCompanyId("company-a")).toBeUndefined();
  parties.bindToCompany(id, "company-a", TENANT_A);
  expect(parties.findByCompanyId("company-a")!.legalFirstName).toBe("Grace");
});

test("an ERASED party is invisible to every read (the H7 retention marker)", () => {
  const id = parties.create(party(TENANT_A));
  parties.bindToCompany(id, "company-a", TENANT_A);
  db.prepare("UPDATE formation_parties SET deleted_at = CURRENT_TIMESTAMP WHERE party_id = ?").run(
    id,
  );
  expect(parties.findOwned(TENANT_A, id)).toBeUndefined();
  expect(parties.findByCompanyId("company-a")).toBeUndefined();
});

test("a synthetic party is stored as such — the flag is not a rendering decision", () => {
  const id = parties.create(party(TENANT_A, { synthetic: true }));
  expect(parties.findOwned(TENANT_A, id)!.synthetic).toBe(true);
});

test("nullable by design: region and phone (most countries have neither shape)", () => {
  const id = parties.create(party(TENANT_A, { region: null, phone: null, country: "FRA" }));
  const rec = parties.findOwned(TENANT_A, id)!;
  expect([rec.region, rec.phone]).toEqual([null, null]);
  expect(rec.country).toBe("FRA");
});
