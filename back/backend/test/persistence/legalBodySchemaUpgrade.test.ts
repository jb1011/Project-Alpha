import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { LEGAL_BODIES_DDL, LEGAL_BODIES_SCHEMA_VERSION, migrate } from "../../src/persistence/db";

const TENANT = "0x00000000000000000000000000000000000000A1";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const BODY_ID = `lb_${"1".padStart(36, "0")}`;
const VERSION_KEY = "legal_bodies_schema_version";

/**
 * `LEGAL_BODIES_DDL` exactly as schema version 1 wrote it, kept as data: a database built from it
 * stands for one that an earlier build created. Version 2 changed two things: an empty signature
 * (`0x`) fits, and the one index on live agentIds became two indexes that include the factory.
 */
const LEGAL_BODIES_DDL_V1 = `
  CREATE TABLE IF NOT EXISTS legal_bodies (
    legal_body_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(legal_body_id) = 'text'
      AND length(CAST(legal_body_id AS BLOB)) = 39 AND length(legal_body_id) = 39
      AND substr(legal_body_id, 1, 3) = 'lb_'),
    public_id TEXT NOT NULL UNIQUE CHECK (typeof(public_id) = 'text'
      AND length(CAST(public_id AS BLOB)) = 36 AND length(public_id) = 36),
    tenant_id TEXT NOT NULL CHECK (typeof(tenant_id) = 'text' AND length(CAST(tenant_id AS BLOB)) = 42 AND length(tenant_id) = 42
      AND substr(tenant_id, 1, 2) = '0x' AND substr(tenant_id, 3) NOT GLOB '*[^0-9a-fA-F]*'),
    company_id TEXT NOT NULL REFERENCES companies(company_id),
    chain_id INTEGER NOT NULL CHECK (typeof(chain_id) = 'integer' AND chain_id > 0),
    factory TEXT NOT NULL CHECK (typeof(factory) = 'text' AND length(CAST(factory AS BLOB)) = 42 AND length(factory) = 42
      AND substr(factory, 1, 2) = '0x' AND substr(factory, 3) NOT GLOB '*[^0-9a-fA-F]*'),
    guardian TEXT NOT NULL,
    amendment_delay INTEGER NOT NULL CHECK (typeof(amendment_delay) = 'integer')
      CHECK (amendment_delay BETWEEN 172800 AND 2592000),
    oa_manifest_hash TEXT CHECK (oa_manifest_hash IS NULL OR (typeof(oa_manifest_hash) = 'text' AND length(CAST(oa_manifest_hash AS BLOB)) = 66 AND length(oa_manifest_hash) = 66
      AND substr(oa_manifest_hash, 1, 2) = '0x' AND substr(oa_manifest_hash, 3) NOT GLOB '*[^0-9a-f]*')),
    oa_manifest_version INTEGER CHECK (oa_manifest_version IS NULL
      OR (typeof(oa_manifest_version) = 'integer' AND oa_manifest_version >= 1)),
    agent_id TEXT CHECK (agent_id IS NULL OR (typeof(agent_id) = 'text'
      AND length(CAST(agent_id AS BLOB)) = length(agent_id) AND length(agent_id) BETWEEN 1 AND 78
      AND agent_id NOT GLOB '*[^0-9]*' AND (agent_id = '0' OR substr(agent_id, 1, 1) != '0'))),
    identity_owner TEXT CHECK (identity_owner IS NULL OR (typeof(identity_owner) = 'text' AND length(CAST(identity_owner AS BLOB)) = 42 AND length(identity_owner) = 42
      AND substr(identity_owner, 1, 2) = '0x' AND substr(identity_owner, 3) NOT GLOB '*[^0-9a-fA-F]*')),
    link_digest TEXT CHECK (link_digest IS NULL OR (typeof(link_digest) = 'text' AND length(CAST(link_digest AS BLOB)) = 66 AND length(link_digest) = 66
      AND substr(link_digest, 1, 2) = '0x' AND substr(link_digest, 3) NOT GLOB '*[^0-9a-f]*')),
    link_deadline INTEGER CHECK (link_deadline IS NULL OR (typeof(link_deadline) = 'integer' AND link_deadline BETWEEN 1 AND 99999999999)),
    link_signature TEXT CHECK (link_signature IS NULL OR (typeof(link_signature) = 'text'
      AND length(CAST(link_signature AS BLOB)) = length(link_signature)
      AND length(link_signature) >= 4 AND length(link_signature) % 2 = 0
      AND substr(link_signature, 1, 2) = '0x' AND substr(link_signature, 3) NOT GLOB '*[^0-9a-f]*')),
    body_address TEXT CHECK (body_address IS NULL OR (typeof(body_address) = 'text' AND length(CAST(body_address AS BLOB)) = 42 AND length(body_address) = 42
      AND substr(body_address, 1, 2) = '0x' AND substr(body_address, 3) NOT GLOB '*[^0-9a-fA-F]*')),
    create_tx_hash TEXT CHECK (create_tx_hash IS NULL OR (typeof(create_tx_hash) = 'text' AND length(CAST(create_tx_hash AS BLOB)) = 66 AND length(create_tx_hash) = 66
      AND substr(create_tx_hash, 1, 2) = '0x' AND substr(create_tx_hash, 3) NOT GLOB '*[^0-9a-f]*')),
    deployed_at INTEGER CHECK (deployed_at IS NULL OR (typeof(deployed_at) = 'integer' AND deployed_at BETWEEN 1 AND 99999999999)),
    binding_state TEXT NOT NULL DEFAULT 'draft'
      CHECK (binding_state IN ('draft','reserved','deployed','linked','broken','lapsed','superseded',
                               'abandoned')),
    pointer_seen_at INTEGER CHECK (pointer_seen_at IS NULL OR (typeof(pointer_seen_at) = 'integer' AND pointer_seen_at BETWEEN 1 AND 99999999999)),
    next_binding_check_at INTEGER CHECK (next_binding_check_at IS NULL
      OR (typeof(next_binding_check_at) = 'integer' AND next_binding_check_at >= 0)),
    binding_check_interval_ms INTEGER CHECK (binding_check_interval_ms IS NULL
      OR (typeof(binding_check_interval_ms) = 'integer' AND binding_check_interval_ms > 0)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (rowid > 0),
    CHECK (guardian = tenant_id),
    CHECK ((oa_manifest_hash IS NULL) = (oa_manifest_version IS NULL)),
    CHECK ((next_binding_check_at IS NULL) = (binding_check_interval_ms IS NULL)),
    CHECK (body_address IS NULL
      OR (lower(body_address) != '0x0000000000000000000000000000000000000000'
          AND lower(body_address) != lower(factory))),
    CHECK (binding_state NOT IN ('draft','abandoned') OR (agent_id IS NULL AND identity_owner IS NULL
      AND link_digest IS NULL AND link_deadline IS NULL AND link_signature IS NULL
      AND body_address IS NULL)),
    CHECK (binding_state IN ('draft','abandoned') OR (
      agent_id IS NOT NULL AND identity_owner IS NOT NULL AND link_digest IS NOT NULL
      AND link_deadline IS NOT NULL AND link_signature IS NOT NULL AND body_address IS NOT NULL
      AND oa_manifest_hash IS NOT NULL)),
    CHECK (binding_state NOT IN ('deployed','linked','broken','superseded')
      OR (create_tx_hash IS NOT NULL AND deployed_at IS NOT NULL)),
    CHECK (deployed_at IS NULL OR binding_state IN ('deployed','linked','broken','superseded')),
    CHECK (create_tx_hash IS NULL OR binding_state NOT IN ('draft','abandoned')),
    CHECK (binding_state != 'linked' OR pointer_seen_at IS NOT NULL),
    CHECK (pointer_seen_at IS NULL OR binding_state IN ('linked','broken','superseded'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_bodies_live_agent
    ON legal_bodies(chain_id, agent_id) WHERE binding_state IN ('reserved','deployed','linked');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_bodies_body
    ON legal_bodies(chain_id, lower(body_address)) WHERE body_address IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_legal_bodies_tenant ON legal_bodies(tenant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_legal_bodies_company ON legal_bodies(company_id);
  CREATE INDEX IF NOT EXISTS idx_legal_bodies_binding_due
    ON legal_bodies(next_binding_check_at) WHERE next_binding_check_at IS NOT NULL;

  CREATE TRIGGER IF NOT EXISTS trg_legal_bodies_write_once
  BEFORE UPDATE ON legal_bodies FOR EACH ROW
  WHEN NEW.rowid IS NOT OLD.rowid
    OR NEW.legal_body_id IS NOT OLD.legal_body_id
    OR NEW.public_id IS NOT OLD.public_id
    OR NEW.tenant_id IS NOT OLD.tenant_id
    OR NEW.company_id IS NOT OLD.company_id
    OR NEW.chain_id IS NOT OLD.chain_id
    OR NEW.factory IS NOT OLD.factory
    OR NEW.guardian IS NOT OLD.guardian
    OR NEW.amendment_delay IS NOT OLD.amendment_delay
    OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.oa_manifest_hash IS NOT NULL AND (NEW.oa_manifest_hash IS NOT OLD.oa_manifest_hash
        OR NEW.oa_manifest_version IS NOT OLD.oa_manifest_version))
    OR (OLD.agent_id IS NOT NULL AND (NEW.agent_id IS NOT OLD.agent_id
        OR NEW.identity_owner IS NOT OLD.identity_owner OR NEW.link_digest IS NOT OLD.link_digest
        OR NEW.link_deadline IS NOT OLD.link_deadline OR NEW.link_signature IS NOT OLD.link_signature
        OR NEW.body_address IS NOT OLD.body_address))
    OR (OLD.deployed_at IS NOT NULL AND (NEW.deployed_at IS NOT OLD.deployed_at
        OR NEW.create_tx_hash IS NOT OLD.create_tx_hash))
  BEGIN
    SELECT RAISE(ABORT, 'legal_bodies: identity, agreement, link and deploy fields are write-once');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_legal_bodies_transitions
  BEFORE UPDATE OF binding_state ON legal_bodies FOR EACH ROW
  WHEN NEW.binding_state IS NOT OLD.binding_state AND NOT IFNULL((
       (OLD.binding_state = 'draft' AND NEW.binding_state IN ('reserved','abandoned'))
    OR (OLD.binding_state = 'reserved' AND NEW.binding_state IN ('deployed','lapsed'))
    OR (OLD.binding_state = 'deployed' AND NEW.binding_state IN ('linked','superseded'))
    OR (OLD.binding_state = 'linked' AND NEW.binding_state = 'broken')
    OR (OLD.binding_state = 'broken' AND NEW.binding_state IN ('linked','superseded'))
    OR (OLD.binding_state = 'superseded' AND NEW.binding_state = 'linked')), 0)
  BEGIN
    SELECT RAISE(ABORT, 'legal_bodies: illegal binding_state transition');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_legal_bodies_insert
  BEFORE INSERT ON legal_bodies FOR EACH ROW
  WHEN NEW.binding_state IS NOT 'draft'
    OR EXISTS (SELECT 1 FROM legal_bodies
                WHERE legal_body_id = NEW.legal_body_id OR public_id = NEW.public_id
                   OR rowid = NEW.rowid)
  BEGIN
    SELECT RAISE(ABORT, 'legal_bodies: rows are born draft and never replaced');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_legal_bodies_company_tenant
  BEFORE INSERT ON legal_bodies FOR EACH ROW
  WHEN EXISTS (SELECT 1 FROM companies
                WHERE company_id = NEW.company_id AND tenant_id IS NOT NEW.tenant_id)
  BEGIN
    SELECT RAISE(ABORT, 'legal_bodies: the company belongs to another tenant');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_legal_bodies_no_delete
  BEFORE DELETE ON legal_bodies
  BEGIN
    SELECT RAISE(ABORT, 'legal_bodies rows are never deleted');
  END;

  CREATE TABLE IF NOT EXISTS legal_body_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
    legal_body_id TEXT NOT NULL REFERENCES legal_bodies(legal_body_id),
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    tx_hash TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_legal_body_events_body ON legal_body_events(legal_body_id, id);
  CREATE TRIGGER IF NOT EXISTS trg_legal_body_events_no_update
  BEFORE UPDATE ON legal_body_events
  BEGIN
    SELECT RAISE(ABORT, 'legal_body_events is append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_legal_body_events_no_delete
  BEFORE DELETE ON legal_body_events
  BEGIN
    SELECT RAISE(ABORT, 'legal_body_events is append-only');
  END;
  -- This trigger relies on no stored id ever being <= 0, which the CHECK on id guarantees: for an
  -- auto-generated id, SQLite's NEW.id in a BEFORE INSERT trigger is a placeholder (-1), not a
  -- real id, so a stored -1 would make every ordinary append look like a REPLACE.
  CREATE TRIGGER IF NOT EXISTS trg_legal_body_events_no_replace
  BEFORE INSERT ON legal_body_events FOR EACH ROW
  WHEN EXISTS (SELECT 1 FROM legal_body_events WHERE id = NEW.id)
  BEGIN
    SELECT RAISE(ABORT, 'legal_body_events is append-only');
  END;
  -- An id written out by hand is at most the next one: ids are handed out in increasing order and
  -- never reused, so a row far ahead of the others would waste every id in between. An automatic
  -- id shows here as the placeholder described above, so ordinary appends pass.
  CREATE TRIGGER IF NOT EXISTS trg_legal_body_events_next_id
  BEFORE INSERT ON legal_body_events FOR EACH ROW
  WHEN NEW.id > (SELECT IFNULL(MAX(id), 0) FROM legal_body_events) + 1
  BEGIN
    SELECT RAISE(ABORT, 'legal_body_events: ids are assigned in order');
  END;
`;

/** sha256 of version 1's text, as recorded for version 1 next to the DDL's own pin. */
const DDL_V1_SHA256 = "56e84256a0c0d9992d087f1406adf36f4fae9244674e559ed46d3b28dc8237b4";

interface SchemaObject {
  type: string;
  name: string;
  sql: string;
}
const OBJECTS = `SELECT type, name, sql FROM sqlite_master
  WHERE tbl_name IN ('legal_bodies','legal_body_events') AND sql IS NOT NULL ORDER BY type, name`;
const objectsOf = (db: Database.Database) => db.prepare(OBJECTS).all() as SchemaObject[];
const indexNamesOf = (db: Database.Database) =>
  objectsOf(db)
    .filter((o) => o.type === "index")
    .map((o) => o.name);

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

/**
 * A database as a build at schema version 1 left it: every other table as this build makes it, the
 * legal-body tables from version 1's DDL, and version 1 stored.
 */
function versionOneDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.exec("DROP TABLE legal_body_events; DROP TABLE legal_bodies;");
  db.exec(LEGAL_BODIES_DDL_V1);
  db.prepare("UPDATE meta SET value = '1' WHERE key = ?").run(VERSION_KEY);
  expect(storedVersion(db)).toBe("1");
  return db;
}

/** One legal body with its `created` event, written as a version-1 build would have left it. */
function addBody(db: Database.Database) {
  db.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Example Holdings LLC"]', 'existing', 'existing')`,
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

test("the version-1 fixture is the text version 1 recorded, and the code's DDL has moved on from it", () => {
  expect(createHash("sha256").update(LEGAL_BODIES_DDL_V1).digest("hex")).toBe(DDL_V1_SHA256);
  expect(LEGAL_BODIES_DDL).not.toBe(LEGAL_BODIES_DDL_V1);
});

test("a fresh database gets version 2: an empty signature fits, and both agentId indexes include the factory", () => {
  expect(LEGAL_BODIES_SCHEMA_VERSION).toBe(2);
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  expect(storedVersion(db)).toBe("2");
  expect(objectsOf(db)).toEqual(definedByTheCode());
  const indexes = indexNamesOf(db);
  expect(indexes).toContain("idx_legal_bodies_inflight_agent");
  expect(indexes).toContain("idx_legal_bodies_linked_agent");
  expect(indexes).not.toContain("idx_legal_bodies_live_agent");
  for (const name of ["idx_legal_bodies_inflight_agent", "idx_legal_bodies_linked_agent"])
    expect(objectsOf(db).find((o) => o.name === name)?.sql, name).toContain(
      "ON legal_bodies(chain_id, factory, agent_id)",
    );
});

test("a version-1 database with empty tables is upgraded to version 2", () => {
  const db = versionOneDatabase();
  expect(objectsOf(db)).not.toEqual(definedByTheCode());
  expect(indexNamesOf(db)).toContain("idx_legal_bodies_live_agent");
  migrate(db);
  expect(objectsOf(db)).toEqual(definedByTheCode());
  expect(indexNamesOf(db)).not.toContain("idx_legal_bodies_live_agent");
  expect(storedVersion(db)).toBe("2");
  expect(db.inTransaction).toBe(false);
});

test("a version-1 database with a row is refused, naming what differs, and nothing is changed", () => {
  const db = versionOneDatabase();
  addBody(db);
  const before = { objects: objectsOf(db), rows: rowsOf(db) };
  expect(before.rows.bodies).toHaveLength(1);
  // No written migration takes version 1 to version 2: no database can hold a version-1 row, so
  // one that does is the signal to look, never to convert.
  expect(() => migrate(db)).toThrow(
    "legal-body schema needs a written migration: idx_legal_bodies_inflight_agent, idx_legal_bodies_linked_agent, idx_legal_bodies_live_agent, legal_bodies",
  );
  expect({ objects: objectsOf(db), rows: rowsOf(db) }).toEqual(before);
  expect(storedVersion(db)).toBe("1");
  expect(db.inTransaction).toBe(false);
});
