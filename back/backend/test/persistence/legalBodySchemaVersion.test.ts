import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import {
  LEGAL_BODIES_DDL,
  LEGAL_BODIES_SCHEMA_VERSION,
  applyLegalBodySchema,
  migrate,
  normalizeSchemaSql,
  openDatabase,
} from "../../src/persistence/db";

const TENANT = "0x00000000000000000000000000000000000000A1";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const BODY_ID = `lb_${"1".padStart(36, "0")}`;
const VERSION_KEY = "legal_bodies_schema_version";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── The DDL text and its version move together ──

/**
 * sha256 of `LEGAL_BODIES_DDL`, per schema version. A database that already ran the DDL only
 * takes an edit to it when the version is raised, so an edit without a bump must not pass.
 */
const DDL_SHA256_BY_VERSION: Record<number, string> = {
  1: "56e84256a0c0d9992d087f1406adf36f4fae9244674e559ed46d3b28dc8237b4",
  2: "108e8ca9a3f40a8aa793ed90c30085750aaad1a92c9627914cab1f93dcac114a",
};

test("the DDL text is pinned to its schema version", () => {
  const sha256 = createHash("sha256").update(LEGAL_BODIES_DDL).digest("hex");
  expect(
    DDL_SHA256_BY_VERSION[LEGAL_BODIES_SCHEMA_VERSION],
    `LEGAL_BODIES_DDL does not match the text recorded for schema version ${LEGAL_BODIES_SCHEMA_VERSION}. If you edited the DDL: raise LEGAL_BODIES_SCHEMA_VERSION by one and ADD the line "${LEGAL_BODIES_SCHEMA_VERSION + 1}: \\"${sha256}\\"" to DDL_SHA256_BY_VERSION. Do not replace the hash of a version that has already been deployed: databases that ran it only take the new definition when the version goes up.`,
  ).toBe(sha256);
  // Every version up to the current one is on record, so none was skipped or rewritten away.
  expect(Object.keys(DDL_SHA256_BY_VERSION).map(Number)).toEqual(
    Array.from({ length: LEGAL_BODIES_SCHEMA_VERSION }, (_, i) => i + 1),
  );
});

// ── What migrate does to a database, by what it finds there ──

interface SchemaObject {
  type: string;
  name: string;
  sql: string;
}
const OBJECTS = `SELECT type, name, sql FROM sqlite_master
  WHERE tbl_name IN ('legal_bodies','legal_body_events') AND sql IS NOT NULL ORDER BY type, name`;
const objectsOf = (db: Database.Database) => db.prepare(OBJECTS).all() as SchemaObject[];

/** What the code's DDL defines, read from a scratch database that ran nothing else. */
function definedByTheCode(): SchemaObject[] {
  const scratch = new Database(":memory:");
  scratch.exec(LEGAL_BODIES_DDL);
  const objects = objectsOf(scratch);
  scratch.close();
  return objects;
}

const storedVersion = (db: Database.Database) =>
  (
    db.prepare("SELECT value FROM meta WHERE key = ?").get(VERSION_KEY) as
      | { value: string }
      | undefined
  )?.value;
const storeVersion = (db: Database.Database, version: string | null) => {
  db.prepare("DELETE FROM meta WHERE key = ?").run(VERSION_KEY);
  if (version !== null)
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(VERSION_KEY, version);
};

function migrated(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** One legal body with its `created` event, written as an earlier run would have left it. */
function addBody(db: Database.Database) {
  db.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Acme LLC"]', 'existing', 'existing')`,
  ).run(TENANT);
  db.prepare(
    `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
     VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
  ).run(BODY_ID, "1".padStart(36, "0"), TENANT, FACTORY, TENANT);
  db.prepare(
    "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES (?, 'created', 'system')",
  ).run(BODY_ID);
}
const rowsOf = (db: Database.Database) => ({
  bodies: db.prepare("SELECT rowid, * FROM legal_bodies").all(),
  events: db.prepare("SELECT * FROM legal_body_events").all(),
});

/** An earlier definition of the transition rule, which let every move through. */
const OLDER_TRIGGER = `DROP TRIGGER trg_legal_bodies_transitions;
  CREATE TRIGGER trg_legal_bodies_transitions BEFORE UPDATE OF binding_state ON legal_bodies
  BEGIN SELECT 1; END;`;
/** An earlier definition of an index. */
const OLDER_INDEX = `DROP INDEX idx_legal_bodies_tenant;
  CREATE INDEX idx_legal_bodies_tenant ON legal_bodies(tenant_id);`;
const illegalMove = (db: Database.Database) =>
  db
    .prepare("UPDATE legal_bodies SET binding_state = 'lapsed' WHERE legal_body_id = ?")
    .run(BODY_ID);

/** Runs `fn` and returns the lines it wrote to the operations log about this schema. */
function opsLinesOf(fn: () => void): Record<string, unknown>[] {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    fn();
    return log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("legal_body"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    log.mockRestore();
  }
}
const sqlOf = (objects: SchemaObject[], name: string) =>
  objects.find((o) => o.name === name)?.sql ?? "";
const triggersOf = (objects: SchemaObject[]) => objects.filter((o) => o.type === "trigger");
const TRIGGERS_ON_LEGAL_BODIES = definedByTheCode()
  .filter((o) => o.type === "trigger" && o.name.startsWith("trg_legal_bodies_"))
  .map((o) => o.name);

/**
 * Rebuild `legal_bodies` the way a written migration does: a new table with the body the DDL
 * defines, the rows copied, the old table dropped, the new one renamed. Dropping the old table
 * takes its indexes and triggers with it; the migration recreates the indexes, either on the new
 * table before the rename or under the final name after it.
 */
function rebuildLegalBodies(db: Database.Database, indexes: "before" | "after") {
  const defined = definedByTheCode();
  const create = (o: SchemaObject, table: string) =>
    db.exec(o.sql.replace(/\blegal_bodies\b/, table));
  const indexesOfTheTable = defined.filter(
    (o) => o.type === "index" && o.name.startsWith("idx_legal_bodies_"),
  );
  // The event log references the table that is dropped, so foreign keys are off for the rebuild.
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    for (const o of defined.filter((d) => d.type === "table" && d.name === "legal_bodies"))
      create(o, "legal_bodies_new");
    db.exec("INSERT INTO legal_bodies_new SELECT * FROM legal_bodies");
    db.exec("DROP TABLE legal_bodies");
    if (indexes === "before") for (const o of indexesOfTheTable) create(o, "legal_bodies_new");
    db.exec("ALTER TABLE legal_bodies_new RENAME TO legal_bodies");
    if (indexes === "after") for (const o of indexesOfTheTable) db.exec(o.sql);
  })();
  db.pragma("foreign_keys = ON");
}

test("a fresh database gets every object of the DDL and the schema version", () => {
  const db = migrated();
  const objects = objectsOf(db);
  expect(objects).toEqual(definedByTheCode());
  expect(objects.filter((o) => o.type === "table").map((o) => o.name)).toEqual([
    "legal_bodies",
    "legal_body_events",
  ]);
  expect(objects.filter((o) => o.type === "trigger").length).toBeGreaterThanOrEqual(9);
  expect(storedVersion(db)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
});

test("migrate is idempotent: a second run changes no definition, no row and no version", () => {
  const db = migrated();
  addBody(db);
  const before = { objects: objectsOf(db), rows: rowsOf(db), version: storedVersion(db) };
  migrate(db);
  migrate(db);
  expect({ objects: objectsOf(db), rows: rowsOf(db), version: storedVersion(db) }).toEqual(before);
});

test("an in-sync schema with no stored version, or a lower one, only has the version recorded", () => {
  for (const stored of [null, "0"]) {
    const db = migrated();
    addBody(db);
    storeVersion(db, stored);
    const before = { objects: objectsOf(db), rows: rowsOf(db) };
    migrate(db);
    expect({ objects: objectsOf(db), rows: rowsOf(db) }).toEqual(before);
    expect(storedVersion(db), String(stored)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
  }
  // When the tables exist, a newer stored version is left untouched, even when the definitions
  // are the same.
  const db = migrated();
  storeVersion(db, String(LEGAL_BODIES_SCHEMA_VERSION + 1));
  migrate(db);
  expect(storedVersion(db)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION + 1));
});

test("an older schema with empty tables is dropped and recreated from the DDL", () => {
  for (const [label, older] of [
    ["an older trigger", OLDER_TRIGGER],
    ["an older index", OLDER_INDEX],
    ["an older trigger and index", `${OLDER_TRIGGER} ${OLDER_INDEX}`],
    [
      "an older table",
      `DROP TABLE legal_body_events; DROP TABLE legal_bodies;
       CREATE TABLE legal_bodies (legal_body_id TEXT PRIMARY KEY, binding_state TEXT);
       CREATE TABLE legal_body_events (id INTEGER PRIMARY KEY, legal_body_id TEXT);`,
    ],
    ["an interrupted run: one table only", "DROP TABLE legal_body_events;"],
    [
      "a trigger the DDL no longer defines",
      "CREATE TRIGGER trg_legal_bodies_retired BEFORE UPDATE ON legal_bodies BEGIN SELECT 1; END;",
    ],
  ] as const)
    for (const stored of [null, "0"]) {
      const db = migrated();
      db.exec(older);
      storeVersion(db, stored);
      expect(objectsOf(db), label).not.toEqual(definedByTheCode());
      migrate(db);
      expect(objectsOf(db), label).toEqual(definedByTheCode());
      expect(storedVersion(db), label).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
    }
});

test("an older trigger with rows present: the triggers are reconciled and every row is kept", () => {
  for (const stored of [null, "0"]) {
    const db = migrated();
    addBody(db);
    db.exec(OLDER_TRIGGER);
    db.exec(
      "CREATE TRIGGER trg_legal_bodies_retired BEFORE UPDATE ON legal_bodies BEGIN SELECT 1; END;",
    );
    db.exec("DROP TRIGGER trg_legal_body_events_no_update;");
    storeVersion(db, stored);
    const rows = rowsOf(db);
    // An upgrade is expected to change triggers: it does not report them as changed by hand.
    expect(opsLinesOf(() => migrate(db))).toEqual([]);
    expect(objectsOf(db)).toEqual(definedByTheCode());
    expect(rowsOf(db)).toEqual(rows);
    expect(storedVersion(db)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
    // The rule the older trigger did not enforce is enforced again.
    expect(() => illegalMove(db)).toThrow(/illegal binding_state transition/);
  }
});

test("an older index or table with rows present: migrate refuses and names it, and changes nothing", () => {
  for (const [older, names] of [
    [OLDER_INDEX, ["idx_legal_bodies_tenant"]],
    ["DROP INDEX idx_legal_bodies_company;", ["idx_legal_bodies_company"]],
    ["CREATE INDEX idx_legal_bodies_extra ON legal_bodies(factory);", ["idx_legal_bodies_extra"]],
    ["ALTER TABLE legal_bodies ADD COLUMN note TEXT;", ["legal_bodies"]],
    [
      `${OLDER_INDEX} ALTER TABLE legal_body_events ADD COLUMN note TEXT;`,
      ["idx_legal_bodies_tenant", "legal_body_events"],
    ],
  ] as const) {
    const db = migrated();
    addBody(db);
    db.exec(older);
    db.exec(OLDER_TRIGGER); // a trigger that differs as well: it must not be half-reconciled
    storeVersion(db, null);
    const before = { objects: objectsOf(db), rows: rowsOf(db) };
    expect(() => migrate(db), older).toThrow(
      `legal-body schema needs a written migration: ${names.join(", ")}`,
    );
    expect({ objects: objectsOf(db), rows: rowsOf(db) }, older).toEqual(before);
    expect(storedVersion(db), older).toBeUndefined();
    expect(db.inTransaction).toBe(false);
  }
});

test("a schema from a newer build is left untouched, with one line in the operations log", () => {
  for (const withRows of [false, true]) {
    const db = migrated();
    if (withRows) addBody(db);
    db.exec(OLDER_TRIGGER); // stands for any definition this build does not know
    db.exec("CREATE INDEX idx_legal_bodies_newer ON legal_bodies(factory);");
    storeVersion(db, String(LEGAL_BODIES_SCHEMA_VERSION + 1));
    const before = { objects: objectsOf(db), rows: rowsOf(db) };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => migrate(db)).not.toThrow();
    expect({ objects: objectsOf(db), rows: rowsOf(db) }).toEqual(before);
    expect(storedVersion(db)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION + 1));
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("legal_body"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      opslog: "legal_body_schema_newer_than_code",
      storedVersion: LEGAL_BODIES_SCHEMA_VERSION + 1,
      codeVersion: LEGAL_BODIES_SCHEMA_VERSION,
      differing: "idx_legal_bodies_newer, trg_legal_bodies_transitions",
    });
    log.mockRestore();
  }
});

test("a schema that differs at the SAME version is refused, naming what differs", () => {
  for (const withRows of [false, true]) {
    const db = migrated();
    if (withRows) addBody(db);
    db.exec(OLDER_TRIGGER);
    db.exec(OLDER_INDEX);
    const before = { objects: objectsOf(db), rows: rowsOf(db) };
    expect(() => migrate(db)).toThrow(
      new RegExp(
        `legal-body schema differs from its definition at version ${LEGAL_BODIES_SCHEMA_VERSION}.*idx_legal_bodies_tenant, trg_legal_bodies_transitions`,
        "s",
      ),
    );
    expect({ objects: objectsOf(db), rows: rowsOf(db) }).toEqual(before);
    expect(storedVersion(db)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
  }
});

/** One legal body and its company, with no event: the event log stays empty. */
function addBodyWithoutAnEvent(db: Database.Database) {
  db.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Acme LLC"]', 'existing', 'existing')`,
  ).run(TENANT);
  db.prepare(
    `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
     VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
  ).run(BODY_ID, "1".padStart(36, "0"), TENANT, FACTORY, TENANT);
}
/** Every object the database holds, whichever table it belongs to. */
const wholeSchemaOf = (db: Database.Database) =>
  db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();

test("a legal-body table stored under another letter case is refused at every stored version, and its row is kept", () => {
  // SQLite matches table names without regard to case, so a statement written for `legal_bodies`
  // reaches a table stored as `Legal_Bodies`.
  const definedTable = sqlOf(definedByTheCode(), "legal_bodies");
  const underAnotherCase = definedTable.replace(
    /^CREATE TABLE legal_bodies\b/,
    "CREATE TABLE Legal_Bodies",
  );
  expect(underAnotherCase).not.toBe(definedTable);
  for (const [shape, change] of [
    ["created under that name", `DROP TABLE legal_bodies; ${underAnotherCase};`],
    [
      "renamed to that name through another one",
      "ALTER TABLE legal_bodies RENAME TO legal_bodies_aside; ALTER TABLE legal_bodies_aside RENAME TO Legal_Bodies;",
    ],
  ] as const)
    for (const stored of [
      null,
      "0",
      String(LEGAL_BODIES_SCHEMA_VERSION),
      String(LEGAL_BODIES_SCHEMA_VERSION + 1),
    ]) {
      const label = `${shape}, stored version ${stored}`;
      const db = migrated();
      db.exec(change);
      // The body has no event: this table holds the only row, and the event log is empty.
      addBodyWithoutAnEvent(db);
      storeVersion(db, stored);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = ?")
          .pluck()
          .all("legal_bodies"),
        label,
      ).toEqual(["Legal_Bodies"]);
      const before = { schema: wholeSchemaOf(db), rows: rowsOf(db), version: storedVersion(db) };
      expect(before.rows.bodies, label).toHaveLength(1);
      expect(before.rows.events, label).toHaveLength(0);

      expect(() => migrate(db), label).toThrow(
        /^legal-body schema holds a table whose name differs in letter case: "Legal_Bodies"\./,
      );
      expect(
        { schema: wholeSchemaOf(db), rows: rowsOf(db), version: storedVersion(db) },
        label,
      ).toEqual(before);
      expect(db.inTransaction, label).toBe(false);
    }
});

// ── What a correct migration, or a hand on the database, leaves behind at the SAME version ──

test("a table rebuilt from the same definition, with a row present, is accepted: at the same version, and as the upgrade a migration prepared", () => {
  const same = String(LEGAL_BODIES_SCHEMA_VERSION);
  for (const indexes of ["before", "after"] as const)
    for (const stored of [same, "0", null]) {
      const label = `indexes ${indexes} the rename, stored version ${stored}`;
      const db = migrated();
      addBody(db);
      const rows = rowsOf(db);
      rebuildLegalBodies(db, indexes);
      storeVersion(db, stored);
      // SQLite wrote the renamed table's name in quotes: the stored text is no longer the DDL's.
      const rebuilt = objectsOf(db);
      const defined = definedByTheCode();
      expect(sqlOf(rebuilt, "legal_bodies"), label).toMatch(/^CREATE TABLE "legal_bodies"/);
      expect(sqlOf(rebuilt, "legal_bodies"), label).not.toBe(sqlOf(defined, "legal_bodies"));
      if (indexes === "before")
        expect(sqlOf(rebuilt, "idx_legal_bodies_company")).toContain('ON "legal_bodies"(');
      expect(triggersOf(rebuilt).map((o) => o.name)).not.toContain("trg_legal_bodies_transitions");

      const lines = opsLinesOf(() => migrate(db));
      // The table and its indexes are left as the rebuild wrote them, and the rows with them.
      const after = objectsOf(db);
      expect(
        after.filter((o) => o.type !== "trigger"),
        label,
      ).toEqual(rebuilt.filter((o) => o.type !== "trigger"));
      expect(rowsOf(db), label).toEqual(rows);
      expect(storedVersion(db), label).toBe(same);
      // The triggers the rebuild dropped with the old table are back, and enforced.
      expect(triggersOf(after), label).toEqual(triggersOf(defined));
      expect(() => illegalMove(db), label).toThrow(/illegal binding_state transition/);
      // Restoring triggers is only worth a line when nothing announced it: at the same version.
      if (stored === same) {
        expect(lines, label).toHaveLength(1);
        expect(lines[0], label).toMatchObject({
          opslog: "legal_body_schema_triggers_restored",
          version: LEGAL_BODIES_SCHEMA_VERSION,
          triggers: [...TRIGGERS_ON_LEGAL_BODIES].sort().join(", "),
        });
      } else expect(lines, label).toEqual([]);
      // The next start finds nothing to do, and says nothing.
      expect(
        opsLinesOf(() => migrate(db)),
        label,
      ).toEqual([]);
      expect(objectsOf(db), label).toEqual(after);
    }
});

test("a column added to legal_bodies by ALTER TABLE, with a row present, reads back as the DDL with that column declared last", () => {
  const db = migrated();
  addBody(db);
  const rows = rowsOf(db);
  // A nullable column, its CHECK written on the column; a column CHECK may name another column.
  const column =
    "reserved_at_block INTEGER CHECK (reserved_at_block IS NULL OR (typeof(reserved_at_block) = 'integer' AND reserved_at_block >= 0 AND binding_state != 'draft'))";
  db.exec(`ALTER TABLE legal_bodies ADD COLUMN ${column}`);

  // The DDL with the same column declared last among the columns, before the table constraints.
  const lastColumn = "    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n";
  expect(LEGAL_BODIES_DDL.split(lastColumn)).toHaveLength(2);
  const scratch = new Database(":memory:");
  scratch.exec(LEGAL_BODIES_DDL.replace(lastColumn, `${lastColumn}    ${column},\n`));
  const defined = sqlOf(objectsOf(scratch), "legal_bodies");
  scratch.close();
  expect(defined).toContain(column);

  // Normalised as the schema step normalises a table, the two definitions are the same.
  expect(normalizeSchemaSql(sqlOf(objectsOf(db), "legal_bodies"))).toBe(
    normalizeSchemaSql(defined),
  );
  // The row is still there, with the new column empty.
  expect(rowsOf(db)).toEqual({
    bodies: rows.bodies.map((body) => ({ ...(body as object), reserved_at_block: null })),
    events: rows.events,
  });
});

test("a column added to legal_body_events by ALTER TABLE, with a row present, reads back as the DDL with that column declared last", () => {
  const db = migrated();
  addBody(db);
  const rows = rowsOf(db);
  db.exec("ALTER TABLE legal_body_events ADD COLUMN note TEXT");
  // The table has no table constraint, so SQLite writes the column just before the closing
  // bracket, after the line break that preceded it: the stored text is laid out unlike the DDL's.
  const stored = sqlOf(objectsOf(db), "legal_body_events");
  expect(stored).toContain("CURRENT_TIMESTAMP\n  , note TEXT)");

  // The DDL with the same column declared last.
  const lastColumn = "    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n  );";
  expect(LEGAL_BODIES_DDL.split(lastColumn)).toHaveLength(2);
  const scratch = new Database(":memory:");
  scratch.exec(
    LEGAL_BODIES_DDL.replace(
      lastColumn,
      "    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    note TEXT\n  );",
    ),
  );
  const defined = sqlOf(objectsOf(scratch), "legal_body_events");
  scratch.close();
  expect(defined).toContain("CURRENT_TIMESTAMP,\n    note TEXT\n  )");

  // Normalised as the schema step normalises a table, the two definitions are the same.
  expect(normalizeSchemaSql(stored)).toBe(normalizeSchemaSql(defined));
  // The rows are still there, with the new column empty.
  expect(rowsOf(db)).toEqual({
    bodies: rows.bodies,
    events: rows.events.map((event) => ({ ...(event as object), note: null })),
  });
});

test("a trigger dropped by hand at the same version is created again: the row is kept, and the operations log names it", () => {
  for (const withRows of [true, false]) {
    const db = migrated();
    if (withRows) addBody(db);
    db.exec(
      "DROP TRIGGER trg_legal_bodies_transitions; DROP TRIGGER trg_legal_body_events_no_update;",
    );
    const rows = rowsOf(db);
    const lines = opsLinesOf(() => migrate(db));
    expect(objectsOf(db)).toEqual(definedByTheCode());
    expect(rowsOf(db)).toEqual(rows);
    expect(storedVersion(db)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
    if (withRows) expect(() => illegalMove(db)).toThrow(/illegal binding_state transition/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      opslog: "legal_body_schema_triggers_restored",
      version: LEGAL_BODIES_SCHEMA_VERSION,
      triggers: "trg_legal_bodies_transitions, trg_legal_body_events_no_update",
    });
    expect(opsLinesOf(() => migrate(db))).toEqual([]);
  }
});

test("a trigger altered by hand at the same version is restored from the DDL, and one the DDL does not define is removed", () => {
  const db = migrated();
  addBody(db);
  db.exec(OLDER_TRIGGER); // same name, another body: it lets every move through
  db.exec(
    "CREATE TRIGGER trg_legal_bodies_by_hand BEFORE UPDATE ON legal_bodies BEGIN SELECT 1; END;",
  );
  // A trigger that only differs in its layout was still not written by the DDL.
  const noDelete = sqlOf(definedByTheCode(), "trg_legal_bodies_no_delete");
  db.exec(`DROP TRIGGER trg_legal_bodies_no_delete; ${noDelete.replace(/\s+/g, " ")}`);
  const untouched = sqlOf(objectsOf(db), "trg_legal_bodies_write_once");
  const rows = rowsOf(db);
  const lines = opsLinesOf(() => migrate(db));
  expect(objectsOf(db)).toEqual(definedByTheCode());
  expect(sqlOf(objectsOf(db), "trg_legal_bodies_write_once")).toBe(untouched);
  expect(rowsOf(db)).toEqual(rows);
  expect(() => illegalMove(db)).toThrow(/illegal binding_state transition/);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    opslog: "legal_body_schema_triggers_restored",
    triggers: "trg_legal_bodies_by_hand, trg_legal_bodies_no_delete, trg_legal_bodies_transitions",
  });
});

test("an index or a table altered at the same version: migrate refuses, names it, and changes nothing", () => {
  for (const withRows of [true, false])
    for (const [altered, names] of [
      [OLDER_INDEX, "idx_legal_bodies_tenant"],
      ["DROP INDEX idx_legal_bodies_company;", "idx_legal_bodies_company"],
      ["CREATE INDEX idx_legal_bodies_extra ON legal_bodies(factory);", "idx_legal_bodies_extra"],
      ["ALTER TABLE legal_body_events ADD COLUMN note TEXT;", "legal_body_events"],
      // A trigger that differs as well is named, and is not restored while the start is refused.
      [
        `${OLDER_INDEX} DROP TRIGGER trg_legal_bodies_no_delete;`,
        "idx_legal_bodies_tenant, trg_legal_bodies_no_delete",
      ],
    ] as const) {
      const db = migrated();
      if (withRows) addBody(db);
      db.exec(altered);
      const before = { objects: objectsOf(db), rows: rowsOf(db) };
      let thrown: unknown;
      const lines = opsLinesOf(() => {
        try {
          migrate(db);
        } catch (e) {
          thrown = e;
        }
      });
      expect(String(thrown), altered).toContain(
        `legal-body schema differs from its definition at version ${LEGAL_BODIES_SCHEMA_VERSION}: ${names}.`,
      );
      expect({ objects: objectsOf(db), rows: rowsOf(db) }, altered).toEqual(before);
      expect(lines, altered).toEqual([]);
      expect(db.inTransaction).toBe(false);
    }
});

test("a table or an index is compared without its layout and its identifier quoting", () => {
  // Through the step itself: an index written with other spacing and the three quoting styles is
  // the same index...
  const db = migrated();
  addBody(db);
  db.exec(`DROP INDEX idx_legal_bodies_company;
    CREATE   INDEX "idx_legal_bodies_company"
      ON [legal_bodies](\`company_id\`)  ;`);
  expect(sqlOf(objectsOf(db), "idx_legal_bodies_company")).not.toBe(
    sqlOf(definedByTheCode(), "idx_legal_bodies_company"),
  );
  expect(opsLinesOf(() => migrate(db))).toEqual([]);
  // ...and one whose text differs inside a string is not.
  db.exec(`DROP INDEX idx_legal_bodies_inflight_agent;
    CREATE UNIQUE INDEX idx_legal_bodies_inflight_agent
      ON legal_bodies(chain_id, factory, agent_id) WHERE binding_state IN ('reserved','"deployed"');`);
  expect(() => migrate(db)).toThrow(
    /differs from its definition.*idx_legal_bodies_inflight_agent/s,
  );

  // The comparison itself. Runs of whitespace become one space, whitespace beside a bracket or a
  // comma goes, and the ends are trimmed.
  expect(normalizeSchemaSql("  CREATE TABLE t (\n    a TEXT,\r\n\tb  INTEGER\n  )\n")).toBe(
    "CREATE TABLE t(a TEXT,b INTEGER)",
  );
  // The three ways to quote an identifier read as the bare name.
  for (const quoted of ['"legal_bodies"', "[legal_bodies]", "`legal_bodies`"])
    expect(normalizeSchemaSql(`CREATE INDEX i ON ${quoted}(a)`), quoted).toBe(
      "CREATE INDEX i ON legal_bodies(a)",
    );
  expect(normalizeSchemaSql('CREATE TABLE"t"(a)')).toBe("CREATE TABLE t(a)");
  // A name that is only a name inside its quotes keeps them, in one spelling.
  for (const quoted of ['"my table"', "[my table]", "`my table`"])
    expect(normalizeSchemaSql(`CREATE INDEX i ON ${quoted}(a)`), quoted).toBe(
      'CREATE INDEX i ON "my table"(a)',
    );
  // A string is data: its spacing, and any quote or bracket inside it, is kept as written.
  for (const text of [
    "CHECK(a NOT GLOB '*[^0-9a-f]*')",
    "CHECK(a != 'two  spaces')",
    "CHECK(a != 'it''s \"quoted\" and `ticked`')",
    "CHECK(a != '')",
  ])
    expect(normalizeSchemaSql(text), text).toBe(text);
  expect(normalizeSchemaSql("CHECK (a != 'x  y')")).not.toBe(
    normalizeSchemaSql("CHECK (a != 'x y')"),
  );
  // So is a comment, which may hold a quote of its own.
  expect(normalizeSchemaSql("a TEXT, -- the owner's  name\n   b TEXT /* [sic]  */  )")).toBe(
    "a TEXT,-- the owner's  name\nb TEXT /* [sic]  */)",
  );
  // Anything else that differs still differs.
  for (const [one, other] of [
    ["CHECK (a > 0)", "CHECK (a >= 0)"],
    ["a TEXT NOT NULL", "a TEXT"],
    ["CHECK (a IN ('draft'))", "CHECK (a IN ('Draft'))"],
    ["REFERENCES companies(company_id)", 'REFERENCES "companies_old"(company_id)'],
  ] as const)
    expect(normalizeSchemaSql(one), one).not.toBe(normalizeSchemaSql(other));
});

test("whitespace beside a bracket or a comma is not compared, unless it is inside a string; a real difference still is", () => {
  // One definition, spaced in different ways around its brackets and commas, reads the same.
  for (const [one, other] of [
    ["a , b", "a, b"],
    ["a , b", "a,b"],
    ["( x )", "(x)"],
    ["CREATE TABLE t ( a TEXT , b INTEGER )", "CREATE TABLE t(a TEXT,b INTEGER)"],
    ["CHECK (a IN ('x', 'y'))", "CHECK(a IN('x','y'))"],
    // Where SQLite writes an added column, and where a DDL laid out like this one declares it.
    ["DEFAULT CURRENT_TIMESTAMP\n  , note TEXT)", "DEFAULT CURRENT_TIMESTAMP,\n    note TEXT\n  )"],
  ] as const)
    expect(normalizeSchemaSql(one), one).toBe(normalizeSchemaSql(other));
  // Words stay apart: the space between two of them is still one space.
  expect(normalizeSchemaSql("a TEXT , b")).toBe("a TEXT,b");
  // Inside a string, the spacing beside a bracket or a comma is data, and is kept.
  for (const [one, other] of [
    ["CHECK (a != 'x , y')", "CHECK (a != 'x, y')"],
    ["CHECK (a != '( x )')", "CHECK (a != '(x)')"],
  ] as const)
    expect(normalizeSchemaSql(one), one).not.toBe(normalizeSchemaSql(other));
  // A changed CHECK and a missing column are still differences.
  for (const [one, other] of [
    [
      "CREATE TABLE t (a INTEGER CHECK (length(a) >= 2), b TEXT)",
      "CREATE TABLE t (a INTEGER CHECK (length(a) >= 4), b TEXT)",
    ],
    ["CREATE TABLE t (a INTEGER, b TEXT)", "CREATE TABLE t (a INTEGER)"],
  ] as const)
    expect(normalizeSchemaSql(one), one).not.toBe(normalizeSchemaSql(other));

  // Through the step, with a row present at the same version: an index spaced that way is the
  // same index, and nothing is reported...
  const db = migrated();
  addBody(db);
  db.exec(`DROP INDEX idx_legal_bodies_tenant;
    CREATE INDEX idx_legal_bodies_tenant ON legal_bodies ( tenant_id , created_at DESC );`);
  expect(sqlOf(objectsOf(db), "idx_legal_bodies_tenant")).not.toBe(
    sqlOf(definedByTheCode(), "idx_legal_bodies_tenant"),
  );
  expect(opsLinesOf(() => migrate(db))).toEqual([]);
  // ...while a table that lost a column is refused, and named.
  db.exec("ALTER TABLE legal_body_events DROP COLUMN detail;");
  const before = { objects: objectsOf(db), rows: rowsOf(db) };
  expect(() => migrate(db)).toThrow(
    `legal-body schema differs from its definition at version ${LEGAL_BODIES_SCHEMA_VERSION}: legal_body_events.`,
  );
  expect({ objects: objectsOf(db), rows: rowsOf(db) }).toEqual(before);
});

test("a stored version that is not a whole number is refused rather than guessed at", () => {
  for (const junk of ["", "one", "1.5", "-1", " 1"]) {
    const db = migrated();
    db.exec(OLDER_TRIGGER);
    storeVersion(db, junk);
    const before = objectsOf(db);
    expect(() => migrate(db), JSON.stringify(junk)).toThrow(/legal_bodies_schema_version/);
    expect(objectsOf(db)).toEqual(before);
  }
});

test("a failure in the middle of the DDL leaves no partial schema behind", () => {
  // A name the DDL needs late is already taken by something else, so the DDL fails after it has
  // created the first table, its indexes and its triggers.
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE idx_legal_body_events_body (x)");
  expect(() => migrate(db)).toThrow(/already a table named idx_legal_body_events_body/);
  expect(objectsOf(db)).toEqual([]);
  expect(storedVersion(db)).toBeUndefined();
  expect(db.inTransaction).toBe(false);
  // Once the obstacle is gone, the next run creates everything.
  db.exec("DROP TABLE idx_legal_body_events_body");
  migrate(db);
  expect(objectsOf(db)).toEqual(definedByTheCode());
  expect(storedVersion(db)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
});

test("applyLegalBodySchema is what migrate runs: it can be run again on its own", () => {
  const db = migrated();
  addBody(db);
  const before = { objects: objectsOf(db), rows: rowsOf(db), version: storedVersion(db) };
  applyLegalBodySchema(db);
  expect({ objects: objectsOf(db), rows: rowsOf(db), version: storedVersion(db) }).toEqual(before);
});

// ── Locking: two connections to one file stand for two processes ──

/** A temp database file, migrated, and removed with its directory when `fn` is done. */
function withDatabaseFile(
  journal: "wal" | "rollback",
  fn: (first: Database.Database, open: (timeout: number) => Database.Database) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "legal-body-schema-"));
  const path = join(dir, "bodies.db");
  const connections: Database.Database[] = [];
  const track = (db: Database.Database) => {
    connections.push(db);
    return db;
  };
  try {
    const first = track(journal === "wal" ? openDatabase(path) : new Database(path));
    first.pragma("foreign_keys = ON");
    migrate(first);
    fn(first, (timeout) => track(new Database(path, { timeout })));
  } finally {
    for (const c of connections) c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a start that finds the schema in sync takes no write lock: it does not wait for a writer", () => {
  for (const journal of ["wal", "rollback"] as const)
    withDatabaseFile(journal, (first, open) => {
      addBody(first);
      const second = open(50);
      // Another process is in the middle of a write, and stays there.
      first.exec("BEGIN IMMEDIATE");
      first.prepare("UPDATE legal_bodies SET updated_at = '2030-01-01 00:00:00'").run();
      expect(() => second.exec("BEGIN IMMEDIATE"), journal).toThrow(/database is locked/);
      expect(() => migrate(second), journal).not.toThrow();
      expect(() => applyLegalBodySchema(second), journal).not.toThrow();
      expect(second.inTransaction).toBe(false);
      first.exec("COMMIT");
      expect(objectsOf(second)).toEqual(definedByTheCode());
    });
});

test("a start that must change the schema takes the write lock first, and waits its turn for it", () => {
  for (const [label, change] of [
    ["a trigger to restore", "DROP TRIGGER trg_legal_bodies_transitions;"],
    ["a version to store", `DELETE FROM meta WHERE key = '${VERSION_KEY}';`],
  ] as const)
    withDatabaseFile("wal", (first, open) => {
      addBody(first);
      first.exec(change);
      const second = open(0);
      const before = { objects: objectsOf(first), version: storedVersion(first) };
      first.exec("BEGIN IMMEDIATE");
      // With no wait allowed, waiting its turn shows as a refusal; nothing was changed.
      expect(() => applyLegalBodySchema(second), label).toThrow(/database is locked/);
      first.exec("COMMIT");
      expect({ objects: objectsOf(first), version: storedVersion(first) }, label).toEqual(before);
      opsLinesOf(() => applyLegalBodySchema(second));
      expect(objectsOf(first), label).toEqual(definedByTheCode());
      expect(storedVersion(first), label).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
    });
});

test("the change is made under the write lock from its first read: no other process writes in between", () => {
  withDatabaseFile("wal", (first, open) => {
    addBody(first);
    first.exec("DROP TRIGGER trg_legal_bodies_transitions;");
    first.pragma("busy_timeout = 0");
    const second = open(0);
    // Just before the step's first statement that changes the schema, the other process tries to
    // start a write of its own.
    const attempts: string[] = [];
    const exec = second.exec.bind(second);
    vi.spyOn(second, "exec").mockImplementation((sql: string) => {
      try {
        first.exec("BEGIN IMMEDIATE; ROLLBACK;");
        attempts.push("the other process got the write lock");
      } catch (e) {
        attempts.push((e as { code?: string }).code ?? String(e));
      }
      return exec(sql);
    });
    opsLinesOf(() => applyLegalBodySchema(second));
    expect(attempts.length).toBeGreaterThan(0);
    expect(new Set(attempts)).toEqual(new Set(["SQLITE_BUSY"]));
    expect(objectsOf(first)).toEqual(definedByTheCode());
  });
});

test("once it holds the write lock the step compares again: work another process did meanwhile is not redone", () => {
  withDatabaseFile("wal", (first, open) => {
    // An older schema with empty tables and no stored version: the step would drop the tables and
    // create them again.
    first.exec(OLDER_INDEX);
    storeVersion(first, null);
    const second = open(0);
    // Between the second process's first look and its turn at the lock, the first process
    // upgrades the schema and writes a body. The step asks for two transactions, the look and
    // the change; the other process gets in before the second one starts.
    let asked = 0;
    const transaction = second.transaction.bind(second);
    vi.spyOn(second, "transaction").mockImplementation(((fn: () => unknown) => {
      asked += 1;
      if (asked === 2) {
        applyLegalBodySchema(first);
        addBody(first);
      }
      return transaction(fn);
    }) as typeof second.transaction);
    applyLegalBodySchema(second);
    expect(asked).toBe(2);
    expect(objectsOf(second)).toEqual(definedByTheCode());
    expect(storedVersion(second)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
    // The body the other process wrote is still there.
    expect(rowsOf(second).bodies).toHaveLength(1);
    expect(rowsOf(second).events).toHaveLength(1);
  });
});
