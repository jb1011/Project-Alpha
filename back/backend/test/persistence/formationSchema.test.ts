/**
 * doola formation schema (design §3): the four new tables, the additive `entities`/`documents`
 * columns, and the ALTER-if-missing idiom holding on a PRE-EXISTING database — the shape the
 * prod box actually upgrades through.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";

let db: DatabaseType.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const columnsOf = (d: DatabaseType.Database, table: string) =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

test("the four formation tables exist with their documented keys", () => {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(tables).toEqual(
    expect.arrayContaining([
      "formation_requests",
      "oa_anchors",
      "doola_webhook_events",
      "formation_parties",
    ]),
  );
});

test("no new EntityStatus value: the entities CHECK is byte-identical to the pre-formation one", () => {
  const sql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entities'").get() as { sql: string }
  ).sql;
  const check = sql.match(/CHECK \(status IN \(([^)]*)\)\)/)?.[1];
  expect(check).toBe("'pending','provisioned','translating','created','bound','funded','failed'");
});

test("entities gains exactly the nine additive formation columns, all nullable", () => {
  const cols = columnsOf(db, "entities");
  for (const c of [
    "formation_provider",
    "formation_environment",
    "ein_real",
    "formation_filed_at",
    "formation_filing_number",
    "oa_manifest_version",
    "oa_manifest_anchored_hash",
    "oa_manifest_pending_hash",
    "oa_amendment_executable_at",
  ])
    expect(cols).toContain(c);
  const notNull = (
    db.prepare("PRAGMA table_info(entities)").all() as { name: string; notnull: number }[]
  )
    // `formation_date` is the ORIGINAL on-chain column (NOT NULL since v1) — not one of ours.
    .filter(
      (c) =>
        c.name !== "formation_date" &&
        (c.name.startsWith("formation_") || c.name.startsWith("oa_manifest")),
    );
  expect(notNull.every((c) => c.notnull === 0)).toBe(true);
});

test("documents gains the legal-PDF index columns; `path NOT NULL` is untouched", () => {
  const cols = columnsOf(db, "documents");
  for (const c of ["entity_key", "doc_type", "sha256", "content_type", "size", "provider_doc_id"])
    expect(cols).toContain(c);
  const path = (
    db.prepare("PRAGMA table_info(documents)").all() as { name: string; notnull: number }[]
  ).find((c) => c.name === "path");
  expect(path?.notnull).toBe(1);
});

test("the webhook-events index is PARTIAL on processed_at IS NULL (the sweeper's only query)", () => {
  const idx = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_doola_events_pending") as { sql: string } | undefined
  )?.sql;
  expect(idx).toContain("WHERE processed_at IS NULL");
});

test("every PII column in formation_parties is NULLABLE — that is what ERASURE needs (H7)", () => {
  const cols = db.prepare("PRAGMA table_info(formation_parties)").all() as {
    name: string;
    notnull: number;
  }[];
  expect(cols.find((c) => c.name === "region")?.notnull).toBe(0);
  expect(cols.find((c) => c.name === "deleted_at")?.notnull).toBe(0);
  // PR 2 part A declared the legally-required fields NOT NULL. Part B has to erase them: the
  // sweeper NULLs every PII column for a party whose filing provably never happened, and a NOT
  // NULL constraint would force it to overwrite personal data with a sentinel string instead of
  // removing it. "Erased" has to mean the column holds nothing. What a FILING requires is still
  // required — enforced where it belongs, at the intake schema (POST /formation-party), which is
  // the only writer.
  for (const pii of [
    "legal_first_name",
    "legal_last_name",
    "email",
    "phone",
    "line1",
    "line2",
    "city",
    "postal_code",
    "country",
  ])
    expect(cols.find((c) => c.name === pii)?.notnull, pii).toBe(0);
  // The columns that must survive an erasure keep their constraints.
  expect(cols.find((c) => c.name === "tenant_id")?.notnull).toBe(1);
});

test("formation_parties is keyed by party_id, with a NULLABLE UNIQUE entity_key + a tenant", () => {
  // The intake handle exists BEFORE the entity does (design §5): PII is collected, a partyId is
  // returned, and onboard binds it. A table keyed by entity_key cannot express that.
  const cols = db.prepare("PRAGMA table_info(formation_parties)").all() as {
    name: string;
    notnull: number;
    pk: number;
  }[];
  expect(cols.find((c) => c.name === "party_id")?.pk).toBe(1);
  expect(cols.find((c) => c.name === "entity_key")?.pk).toBe(0);
  expect(cols.find((c) => c.name === "entity_key")?.notnull).toBe(0);
  expect(cols.find((c) => c.name === "tenant_id")?.notnull).toBe(1);

  const insert = db.prepare(
    `INSERT INTO formation_parties (party_id, entity_key, tenant_id, legal_first_name,
       legal_last_name, email, line1, city, postal_code, country)
     VALUES (?,?,?,'A','L','a@b.c','1 Way','Cheyenne','82001','USA')`,
  );
  insert.run("p1", "ent-1", "0xA");
  // One party per entity: a second party binding the same entity is refused by the schema, not
  // by a code path that could be forgotten.
  expect(() => insert.run("p2", "ent-1", "0xA")).toThrow(/UNIQUE/);
  // …and two UNBOUND parties coexist (NULLs do not collide in a SQLite UNIQUE index).
  insert.run("p3", null, "0xA");
  insert.run("p4", null, "0xA");
  expect(
    (
      db.prepare("SELECT COUNT(*) c FROM formation_parties WHERE entity_key IS NULL").get() as {
        c: number;
      }
    ).c,
  ).toBe(2);
});

test("a PR-1-shaped formation_parties table is REBUILT in place (it never held a row)", () => {
  // The prod-box upgrade: PR 1 created the table keyed by entity_key and shipped no writer for
  // it, so the migration drops and recreates rather than attempting a 12-step ALTER.
  const old = new Database(":memory:");
  old.exec(`
    CREATE TABLE formation_parties (
      entity_key TEXT PRIMARY KEY,
      legal_first_name TEXT NOT NULL, legal_last_name TEXT NOT NULL,
      email TEXT NOT NULL, phone TEXT,
      line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL,
      region TEXT, postal_code TEXT NOT NULL, country TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
    );
  `);
  migrate(old);
  migrate(old);
  expect(columnsOf(old, "formation_parties")).toEqual(
    expect.arrayContaining(["party_id", "entity_key", "tenant_id", "synthetic"]),
  );
  old.close();
});

test("C10: a PR-1-shaped formation_parties table with ROWS in it refuses the migration", () => {
  // The rebuild above is a DROP, and this is the only table in the system holding personal data.
  // "PR 1 shipped no writer" is an argument about the code that shipped — it is not a proof that
  // nothing ever wrote a row (a fixture, a hand-run INSERT, a restored backup from a fork). So a
  // legacy-shaped table with any rows in it stops the boot by name instead of destroying data
  // that cannot be reconstructed: the new shape's keys do not exist in the old one to derive.
  const old = new Database(":memory:");
  old.exec(`
    CREATE TABLE formation_parties (
      entity_key TEXT PRIMARY KEY,
      legal_first_name TEXT NOT NULL, legal_last_name TEXT NOT NULL,
      email TEXT NOT NULL, phone TEXT,
      line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL,
      region TEXT, postal_code TEXT NOT NULL, country TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
    );
    INSERT INTO formation_parties
      (entity_key, legal_first_name, legal_last_name, email, line1, city, postal_code, country)
    VALUES ('t:agent-1', 'Ada', 'Lovelace', 'ada@example.com', '1 Analytical Way', 'Cheyenne', '82001', 'USA');
  `);
  expect(() => migrate(old)).toThrow(/refusing to migrate: formation_parties/);
  // And the row is STILL THERE: a refusal that had already dropped the table would be worse than
  // no refusal at all.
  expect(
    (old.prepare("SELECT COUNT(*) AS n FROM formation_parties").get() as { n: number }).n,
  ).toBe(1);
  expect(columnsOf(old, "formation_parties")).not.toContain("party_id");
  old.close();
});

test("C10: the unreachable second formation_parties rebuild is gone", () => {
  // The migration had a SECOND block that rebuilt the table to drop NOT NULL from the PII
  // columns. It could never run: the guard above recreates the table from the current DDL, in
  // which those columns are already nullable, and no shipped shape has ever had both `party_id`
  // and a NOT NULL `legal_first_name`. Dead migration code that performs a DROP is the worst kind
  // to keep, because the day it becomes reachable is the day it deletes something.
  const source = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "persistence", "db.ts"),
    "utf8",
  );
  expect(source).not.toContain("formation_parties_new");
  // Exactly one DROP of this table, and it is the guarded one.
  expect(source.match(/DROP TABLE formation_parties/g)?.length ?? 0).toBe(1);
});

test("the CHECKs refuse an unknown step/state (typos become errors, not silent rows)", () => {
  expect(() =>
    db
      .prepare("INSERT INTO formation_requests (entity_key, step, state) VALUES (?,?,?)")
      .run("k", "not_a_step", "pending"),
  ).toThrow(/CHECK/);
  expect(() =>
    db
      .prepare("INSERT INTO formation_requests (entity_key, step, state) VALUES (?,?,?)")
      .run("k", "await_ein", "not_a_state"),
  ).toThrow(/CHECK/);
  expect(() =>
    db
      .prepare(
        "INSERT INTO oa_anchors (entity_key, version, manifest_hash, state) VALUES (?,?,?,?)",
      )
      .run("k", 1, "0xabc", "not_a_state"),
  ).toThrow(/CHECK/);
});

test("oa_anchors is keyed per VERSION: two cycles for one entity coexist (audit H1)", () => {
  const ins = db.prepare(
    "INSERT INTO oa_anchors (entity_key, version, manifest_hash, state) VALUES (?,?,?,?)",
  );
  ins.run("ent", 1, "0x01", "executed");
  ins.run("ent", 2, "0x02", "scheduled");
  expect(
    (
      db.prepare("SELECT COUNT(*) c FROM oa_anchors WHERE entity_key = 'ent'").get() as {
        c: number;
      }
    ).c,
  ).toBe(2);
  // …but the SAME version cannot be opened twice.
  expect(() => ins.run("ent", 2, "0xdeadbeef", "pending")).toThrow(/UNIQUE/);
});

test("timestamps default to CURRENT_TIMESTAMP as TEXT (bridge_legs consistency)", () => {
  db.prepare("INSERT INTO formation_requests (entity_key, step, state) VALUES (?,?,?)").run(
    "k",
    "create_provider",
    "pending",
  );
  const row = db.prepare("SELECT created_at, updated_at FROM formation_requests").get() as {
    created_at: string;
    updated_at: string;
  };
  expect(typeof row.created_at).toBe("string");
  expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  expect(typeof row.updated_at).toBe("string");
});

test("ALTER-if-missing: a PRE-FORMATION database migrates in place, twice, without data loss", () => {
  // Build the v1 shape of the two tables the migration ALTERs, then run the real migrate() over
  // it — the upgrade the prod box performs. A second migrate() must be a no-op (idempotent).
  const old = new Database(":memory:");
  old.exec(`
    CREATE TABLE entities (
      idempotency_key TEXT PRIMARY KEY, name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','provisioned','translating','created','bound','funded','failed')),
      manager TEXT NOT NULL, guardian TEXT NOT NULL,
      amendment_delay TEXT NOT NULL, ein TEXT NOT NULL, formation_date INTEGER NOT NULL,
      agent_id TEXT, proxy TEXT, treasury TEXT, owner_tenant_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, oa_hash TEXT, path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO entities (idempotency_key, name, status, manager, guardian, amendment_delay, ein, formation_date)
      VALUES ('legacy-1', 'Legacy Agent', 'funded', '0xA', '0xB', '86400', 'STUB-NOT-FILED', 0);
    INSERT INTO documents (id, path) VALUES ('oa-legacy-1.md', '/data/documents/oa-legacy-1.md');
  `);

  migrate(old);
  migrate(old);

  expect(columnsOf(old, "entities")).toContain("oa_manifest_anchored_hash");
  expect(columnsOf(old, "documents")).toContain("provider_doc_id");
  const legacy = old.prepare("SELECT * FROM entities WHERE idempotency_key = 'legacy-1'").get() as
    | Record<string, unknown>
    | undefined;
  expect(legacy?.name).toBe("Legacy Agent");
  expect(legacy?.status).toBe("funded");
  // The whole point of "legacy rows are stub forever": the migration backfills NOTHING.
  expect(legacy?.formation_provider).toBeNull();
  expect(legacy?.oa_manifest_version).toBeNull();
  expect(
    (old.prepare("SELECT * FROM documents WHERE id = 'oa-legacy-1.md'").get() as { path: string })
      .path,
  ).toBe("/data/documents/oa-legacy-1.md");
  old.close();
});
