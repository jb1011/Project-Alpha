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

test("bind is a CAS: it moves once, for the owner only, and never twice", () => {
  const id = parties.create(party(TENANT_A));

  // A foreign tenant cannot bind it, even knowing the id.
  expect(parties.bind(id, "0xB:agent", TENANT_B)).toBe(false);

  expect(parties.bind(id, "0xA:agent", TENANT_A)).toBe(true);
  expect(parties.findOwned(TENANT_A, id)!.entityKey).toBe("0xA:agent");

  // Second bind — the "two entities on one consent" case — loses.
  expect(parties.bind(id, "0xA:other", TENANT_A)).toBe(false);
  expect(parties.findOwned(TENANT_A, id)!.entityKey).toBe("0xA:agent");
});

test("one party per entity: the UNIQUE entity_key refuses a second binding to the same entity", () => {
  const first = parties.create(party(TENANT_A));
  const second = parties.create(party(TENANT_A));
  expect(parties.bind(first, "0xA:agent", TENANT_A)).toBe(true);
  expect(() => parties.bind(second, "0xA:agent", TENANT_A)).toThrow(/UNIQUE/);
});

test("findByEntityKey is what create_provider files with", () => {
  const id = parties.create(party(TENANT_A, { legalFirstName: "Grace" }));
  expect(parties.findByEntityKey("0xA:agent")).toBeUndefined();
  parties.bind(id, "0xA:agent", TENANT_A);
  expect(parties.findByEntityKey("0xA:agent")!.legalFirstName).toBe("Grace");
});

test("an ERASED party is invisible to every read (the H7 retention marker)", () => {
  const id = parties.create(party(TENANT_A));
  parties.bind(id, "0xA:agent", TENANT_A);
  db.prepare("UPDATE formation_parties SET deleted_at = CURRENT_TIMESTAMP WHERE party_id = ?").run(
    id,
  );
  expect(parties.findOwned(TENANT_A, id)).toBeUndefined();
  expect(parties.findByEntityKey("0xA:agent")).toBeUndefined();
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
