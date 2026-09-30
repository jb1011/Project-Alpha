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
  1: "3e21175cb634fea7d2ee3374fa2d143105c03c82eae5013f8ba0385bae3d0a46",
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
  // A higher stored version is never lowered, even when the definitions are the same.
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
    migrate(db);
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
      /legal-body schema differs from its definition at version 1.*idx_legal_bodies_tenant, trg_legal_bodies_transitions/s,
    );
    expect({ objects: objectsOf(db), rows: rowsOf(db) }).toEqual(before);
    expect(storedVersion(db)).toBe(String(LEGAL_BODIES_SCHEMA_VERSION));
  }
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

test("the schema step takes the write lock before it looks: two processes cannot interleave in it", () => {
  // Two connections to one file stand for two processes starting together. While one of them is
  // writing, the other must not even compare the schema: what it read could be stale by the time
  // it acted on it. It waits for the lock instead (here, with no wait allowed, it is refused).
  const dir = mkdtempSync(join(tmpdir(), "legal-body-schema-"));
  const path = join(dir, "bodies.db");
  const connections: Database.Database[] = [];
  try {
    const first = openDatabase(path);
    connections.push(first);
    migrate(first);
    const second = new Database(path, { timeout: 0 });
    connections.push(second);
    first.exec("BEGIN IMMEDIATE");
    expect(() => applyLegalBodySchema(second)).toThrow(/database is locked/);
    first.exec("COMMIT");
    expect(() => applyLegalBodySchema(second)).not.toThrow();
    expect(objectsOf(second)).toEqual(definedByTheCode());
  } finally {
    for (const c of connections) c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
