/**
 * PII erasure (design §3, audit H7).
 *
 * The retention duty attaches to a *filed* responsible party, not to an abandoned form. So the
 * two erasable populations are the ones whose filing provably never happened — an abandoned
 * `create_provider`, and a handle nobody ever used — and the erasure has to actually remove the
 * data rather than overwrite it with a sentinel, which is why the columns are nullable.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";

const TENANT = "0x000000000000000000000000000000000000000A";

let db: DatabaseType.Database;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
});
afterEach(() => db.close());

function newParty(): string {
  return parties.create({
    tenantId: TENANT,
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

const raw = (partyId: string) =>
  db.prepare("SELECT * FROM formation_parties WHERE party_id = ?").get(partyId) as Record<
    string,
    unknown
  >;

test("the PII columns are NULLABLE — erasure removes data rather than overwriting it", () => {
  const info = db.prepare("PRAGMA table_info(formation_parties)").all() as {
    name: string;
    notnull: number;
  }[];
  for (const col of ["legal_first_name", "legal_last_name", "email", "line1", "city", "country"])
    expect(info.find((c) => c.name === col)?.notnull).toBe(0);
  // The columns that must survive an erasure keep their constraints.
  expect(info.find((c) => c.name === "tenant_id")?.notnull).toBe(1);
});

test("erase() NULLs every PII column, keeps the handle, the owner and the dates, and is idempotent", () => {
  const partyId = newParty();
  expect(parties.erase(partyId)).toBe(true);

  const row = raw(partyId);
  for (const col of [
    "legal_first_name",
    "legal_last_name",
    "email",
    "phone",
    "line1",
    "line2",
    "city",
    "region",
    "postal_code",
    "country",
  ])
    expect(row[col], col).toBeNull();
  // What the audit trail needs, and nothing more.
  expect(row.party_id).toBe(partyId);
  expect(row.tenant_id).toBe(TENANT);
  expect(row.created_at).toBeTruthy();
  expect(row.deleted_at).toBeTruthy();

  // An erased party is gone for every purpose: no reader may resurrect it.
  expect(parties.findOwned(TENANT, partyId)).toBeUndefined();
  expect(parties.bind(partyId, "t:agent-1", TENANT)).toBe(false);
  // Idempotent: a second sweep finds nothing to do.
  expect(parties.erase(partyId)).toBe(false);
});

test("erasable = an ABANDONED filing, or an UNBOUND handle older than the cutoff", () => {
  // 1. bound to an abandoned formation -> the filing will never happen
  const abandoned = newParty();
  parties.bind(abandoned, "t:abandoned", TENANT);
  requests.claimAllSteps("t:abandoned");
  requests.transition("t:abandoned", "create_provider", "pending", "abandoned");

  // 2. bound to a formation that is still going -> NOT erasable
  const live = newParty();
  parties.bind(live, "t:live", TENANT);
  requests.claimAllSteps("t:live");
  requests.transition("t:live", "create_provider", "pending", "confirmed");

  // 3. an unbound handle from last week -> erasable
  const stale = newParty();
  db.prepare("UPDATE formation_parties SET created_at = ? WHERE party_id = ?").run(
    "2026-08-01 00:00:00",
    stale,
  );

  // 4. an unbound handle created just now -> NOT erasable (the wizard may still be open)
  const fresh = newParty();

  const cutoff = "2026-08-14 00:00:00";
  const got = parties.listErasable(cutoff);
  expect(got).toEqual(
    expect.arrayContaining([
      { partyId: abandoned, reason: "abandoned" },
      { partyId: stale, reason: "unbound" },
    ]),
  );
  expect(got).toHaveLength(2);
  expect(got.map((g) => g.partyId)).not.toContain(live);
  expect(got.map((g) => g.partyId)).not.toContain(fresh);
});

test("an already-erased party never re-appears in the candidate list", () => {
  const stale = newParty();
  db.prepare("UPDATE formation_parties SET created_at = ? WHERE party_id = ?").run(
    "2026-08-01 00:00:00",
    stale,
  );
  expect(parties.listErasable("2026-08-14 00:00:00")).toHaveLength(1);
  parties.erase(stale);
  expect(parties.listErasable("2026-08-14 00:00:00")).toHaveLength(0);
});

test("MIGRATION: a database carrying the old NOT NULL shape is rebuilt without losing rows", () => {
  const legacy = openDatabase(":memory:");
  // PR 2 part A's shape, verbatim in the part that matters: NOT NULL on the PII columns.
  legacy.exec(`
    CREATE TABLE formation_parties (
      party_id   TEXT PRIMARY KEY,
      entity_key TEXT UNIQUE,
      tenant_id  TEXT NOT NULL,
      legal_first_name TEXT NOT NULL, legal_last_name TEXT NOT NULL,
      email TEXT NOT NULL, phone TEXT,
      line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL,
      region TEXT,
      postal_code TEXT NOT NULL, country TEXT NOT NULL,
      synthetic INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );
    INSERT INTO formation_parties
      (party_id, entity_key, tenant_id, legal_first_name, legal_last_name, email, phone,
       line1, city, postal_code, country, created_at)
    VALUES ('p1','t:agent-1','${TENANT}','Ada','Lovelace','ada@example.com','+12125550100',
            '1 Analytical Way','Cheyenne','82001','USA','2026-08-20 09:00:00');
  `);
  migrate(legacy);

  const info = legacy.prepare("PRAGMA table_info(formation_parties)").all() as {
    name: string;
    notnull: number;
  }[];
  expect(info.find((c) => c.name === "legal_first_name")?.notnull).toBe(0);
  const row = legacy
    .prepare("SELECT * FROM formation_parties WHERE party_id = 'p1'")
    .get() as Record<string, unknown>;
  // Every column carried across, including the timestamp and the binding.
  expect(row).toMatchObject({
    entity_key: "t:agent-1",
    tenant_id: TENANT,
    legal_first_name: "Ada",
    email: "ada@example.com",
    created_at: "2026-08-20 09:00:00",
  });
  // The unique index the door gate relies on survived the rebuild.
  const idx = legacy.prepare("PRAGMA index_list(formation_parties)").all() as { name: string }[];
  expect(idx.map((i) => i.name)).toContain("idx_formation_parties_tenant");
  // Idempotent: running migrate again is a no-op, not a second rebuild.
  migrate(legacy);
  expect(legacy.prepare("SELECT COUNT(*) AS n FROM formation_parties").get()).toEqual({ n: 1 });
  legacy.close();
});
