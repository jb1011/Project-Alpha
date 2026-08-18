import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SqliteEntityLookup, indexEntities } from "../../src/monitor/entityLookup";
import { EntityLookupError } from "../../src/monitor/errors";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";
import { ADDR, entity } from "./helpers";

function record(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    idempotencyKey: "key-1",
    name: "Acme Agent LLC",
    status: "funded",
    manager: ADDR.controller,
    guardian: ADDR.guardian,
    operator: ADDR.operator,
    amendmentDelay: "86400",
    ein: "00-0000000",
    formationDate: 1_700_000_000,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: "881938",
    proxy: "0x8888888888888888888888888888888888888888",
    treasury: ADDR.treasury,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    error: null,
    publicId: "pub-1",
    ...over,
  } as EntityRecord;
}

/** Build a real legalbody.db with the production migration, then read it as the monitor does. */
function seedMainDb(records: EntityRecord[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "novi-main-db-")), "legalbody.db");
  const db = openDatabase(path);
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  for (const r of records) repo.upsert(r);
  db.close();
  return path;
}

describe("SqliteEntityLookup", () => {
  test("reads entities with an on-chain footprint", () => {
    const lookup = new SqliteEntityLookup(seedMainDb([record()]));
    const [e] = lookup.all();
    expect(e?.agentId).toBe("881938");
    expect(e?.treasury).toBe(ADDR.treasury);
    expect(e?.operator).toBe(ADDR.operator);
    expect(e?.guardian).toBe(ADDR.guardian);
    expect(e?.manager).toBe(ADDR.controller);
    expect(e?.publicId).toBe("pub-1");
    lookup.close();
  });

  test("skips rows with neither a treasury nor an agentId (nothing on-chain to watch)", () => {
    const lookup = new SqliteEntityLookup(
      seedMainDb([
        record(),
        record({ idempotencyKey: "key-2", agentId: null, treasury: null, publicId: "pub-2" }),
      ]),
    );
    expect(lookup.all()).toHaveLength(1);
    lookup.close();
  });

  test("the handle is READ-ONLY — a write against it is refused by better-sqlite3", () => {
    const path = seedMainDb([record()]);
    const lookup = new SqliteEntityLookup(path);
    lookup.all(); // force the connection open
    // Reach into the private handle deliberately: this asserts the guarantee the class claims.
    const db = (lookup as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
    expect(() => db.prepare("DELETE FROM entities").run()).toThrow(/readonly|read.only/i);
    lookup.close();
  });

  test("a missing database is a NAMED recoverable error, not a crash", () => {
    const lookup = new SqliteEntityLookup("/nonexistent/dir/legalbody.db");
    expect(() => lookup.all()).toThrow(EntityLookupError);
    expect(() => lookup.all()).toThrow(/DATA_DIR/);
  });

  test("an un-migrated database surfaces as EntityLookupError, and the handle is dropped", () => {
    const path = join(mkdtempSync(join(tmpdir(), "novi-empty-db-")), "legalbody.db");
    openDatabase(path).close(); // exists, but has no `entities` table
    const lookup = new SqliteEntityLookup(path);
    expect(() => lookup.all()).toThrow(EntityLookupError);
    lookup.close();
  });

  test("reads while the API holds the DB open (WAL: readers never block on a writer)", () => {
    const path = seedMainDb([record()]);
    const writer = openDatabase(path); // simulates the running API
    const repo = new SqliteEntityRepository(writer);
    repo.upsert(record({ idempotencyKey: "key-2", agentId: "999", publicId: "pub-2" }));

    const lookup = new SqliteEntityLookup(path);
    expect(lookup.all()).toHaveLength(2);
    lookup.close();
    writer.close();
  });
});

describe("indexEntities", () => {
  test("indexes by lowercased treasury and by agentId", () => {
    const index = indexEntities([entity()]);
    expect(index.byTreasury.get(ADDR.treasury.toLowerCase())?.name).toBe("Acme Agent LLC");
    expect(index.byAgentId.get("881938")?.name).toBe("Acme Agent LLC");
  });

  test("a row is absent only from the index whose key it lacks", () => {
    const noTreasury = entity({ idempotencyKey: "k1", treasury: null, agentId: "1" });
    const noAgent = entity({ idempotencyKey: "k2", treasury: ADDR.treasury, agentId: null });
    const index = indexEntities([noTreasury, noAgent]);
    expect([...index.byTreasury.keys()]).toEqual([ADDR.treasury.toLowerCase()]);
    expect([...index.byAgentId.keys()]).toEqual(["1"]);
  });
});
