import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate } from "../../src/persistence/db";

/**
 * S1 one-shot data migration: promote every existing key whose effective capability is 'spend'
 * (stored 'spend' or legacy NULL) to 'provision'. See
 * back/docs/design/2026-07-20-s1-fund-treasury-authorization.md §2.
 *
 * These tests simulate a pre-existing production DB: the api_keys table (with rows already in it)
 * is created by hand, BEFORE the first call to migrate() — mirroring a real deploy where migrate()
 * runs against a database that predates the backfill logic. (Calling migrate() first, as most other
 * tests do, would create the table empty and set the marker on that first call, before any legacy
 * rows exist — which would defeat the point of this test.)
 */
function seedLegacyApiKeysTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE api_keys (
      id           TEXT PRIMARY KEY,
      owner_tenant TEXT NOT NULL,
      hash         TEXT NOT NULL,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      revoked_at   INTEGER,
      entity_id    TEXT,
      capability   TEXT,
      expires_at   INTEGER
    );
  `);
  const insert = db.prepare(
    "INSERT INTO api_keys (id, owner_tenant, hash, label, created_at, entity_id, capability, expires_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  insert.run("legacy-null", "0xTEN", "hash-null", "legacy null cap", Date.now(), null, null, null);
  insert.run(
    "legacy-spend",
    "0xTEN",
    "hash-spend",
    "legacy spend cap",
    Date.now(),
    null,
    "spend",
    null,
  );
  insert.run(
    "legacy-read",
    "0xTEN",
    "hash-read",
    "legacy read cap",
    Date.now(),
    null,
    "read",
    null,
  );
  insert.run(
    "legacy-entity-spend",
    "0xTEN",
    "hash-entity-spend",
    "legacy entity-scoped spend cap",
    Date.now(),
    "0xTEN:agent-1",
    "spend",
    null,
  );
}

function capabilityById(db: Database.Database, id: string): string | null {
  const row = db.prepare("SELECT capability FROM api_keys WHERE id = ?").get(id) as
    | { capability: string | null }
    | undefined;
  return row?.capability ?? null;
}

test("migrate() promotes every effective-spend key (NULL or 'spend') to 'provision', leaves 'read' untouched", () => {
  const db = new Database(":memory:");
  seedLegacyApiKeysTable(db);

  migrate(db);

  expect(capabilityById(db, "legacy-null")).toBe("provision");
  expect(capabilityById(db, "legacy-spend")).toBe("provision");
  expect(capabilityById(db, "legacy-read")).toBe("read");
  expect(capabilityById(db, "legacy-entity-spend")).toBe("provision");

  db.close();
});

test("migrate() is idempotent: a re-run does not re-promote a freshly minted 'spend' key, and leaves the backfilled rows unchanged", () => {
  const db = new Database(":memory:");
  seedLegacyApiKeysTable(db);
  migrate(db); // first run: backfill happens, marker is set

  // Mint a NEW key AFTER the backfill, explicitly 'spend' — this is exactly the "keys minted after
  // the change get the split" behavior the marker exists to protect.
  const apiKeys = new SqliteApiKeyStore(db);
  const { id: freshSpendId } = apiKeys.mint("0xTEN", { capability: "spend" });

  migrate(db); // second run: guarded by the meta marker — must be a no-op for capability

  // The fresh 'spend' key stays 'spend' — it was never promoted.
  expect(capabilityById(db, freshSpendId)).toBe("spend");
  // The rows the first run legitimately backfilled are unchanged (still 'provision', not reset).
  expect(capabilityById(db, "legacy-null")).toBe("provision");
  expect(capabilityById(db, "legacy-spend")).toBe("provision");
  expect(capabilityById(db, "legacy-read")).toBe("read");
  expect(capabilityById(db, "legacy-entity-spend")).toBe("provision");

  db.close();
});

test("migrate() records the backfill marker in the meta table exactly once", () => {
  const db = new Database(":memory:");
  seedLegacyApiKeysTable(db);
  migrate(db);
  migrate(db);
  migrate(db);

  const rows = db
    .prepare("SELECT value FROM meta WHERE key = 'apikey_capability_provision_backfill'")
    .all();
  expect(rows).toHaveLength(1);

  db.close();
});
