/**
 * PII erasure (design §3, audit H7).
 *
 * The retention duty attaches to a *filed* responsible party, not to an abandoned form. So the
 * two erasable populations are the ones whose filing provably never happened — an abandoned
 * `create_provider`, and a handle nobody ever used — and the erasure has to actually remove the
 * data rather than overwrite it with a sentinel, which is why the columns are nullable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("C10: the migration performs exactly ONE formation_parties rebuild, and it is guarded", () => {
  // There used to be a second one: a 4-step "drop NOT NULL from the PII columns" dance guarded on
  // the columns' own nullability. It could never run. The guarded rebuild above it recreates the
  // table from the CURRENT DDL, in which those columns are already nullable, and no shipped shape
  // has ever had both `party_id` and a NOT NULL `legal_first_name` — only a database created by a
  // mid-branch build of this PR could, and none exists outside a developer's laptop.
  //
  // Dead migration code that performs a DROP is the worst kind to keep, because the day it
  // becomes reachable is the day it deletes something. This test is what stops it coming back.
  const source = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "persistence", "db.ts"),
    "utf8",
  );
  expect(source.match(/DROP TABLE formation_parties/g)?.length ?? 0).toBe(1);
  expect(source).not.toContain("formation_parties_new");

  // What the deleted block existed to guarantee still holds, from the DDL itself: a freshly
  // migrated table has NULLABLE PII columns, which is what makes erasure `NULL` rather than a
  // sentinel string.
  const fresh = openDatabase(":memory:");
  migrate(fresh);
  const info = fresh.prepare("PRAGMA table_info(formation_parties)").all() as {
    name: string;
    notnull: number;
  }[];
  for (const col of ["legal_first_name", "legal_last_name", "email", "line1", "city", "country"])
    expect(info.find((c) => c.name === col)?.notnull, col).toBe(0);
  fresh.close();
});
