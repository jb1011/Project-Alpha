import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { Address, EntityRecord } from "../../src/types";

/**
 * `findByPocketAddress` — the payer-keyed lookup the legal-body check stands on (design
 * 2026-09-10 D2). Its whole reason to exist is that the address a seller is handed is the PAYER
 * address, not the treasury.
 */

let db: Database.Database;
let repo: SqliteEntityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

const record = (over: Partial<EntityRecord> = {}): EntityRecord => ({
  idempotencyKey: "key-1",
  name: "Demo Agent",
  status: "funded",
  manager: "0x000000000000000000000000000000000000aAaa" as Address,
  guardian: "0x000000000000000000000000000000000000bBbb" as Address,
  operator: null,
  amendmentDelay: "86400",
  ein: "STUB-NOT-FILED",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: "843704",
  proxy: "0x00000000000000000000000000000000000000cD" as Address,
  treasury: "0x00000000000000000000000000000000000000Ab" as Address,
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  ...over,
});

const POCKET = "0xeE85Fd00521d1Aa4c510BDdAb78F375830119354";

test("findByPocketAddress finds the entity that pays from that address", () => {
  repo.upsert(record({ pocketAddress: POCKET }));
  expect(repo.findByPocketAddress(POCKET)?.idempotencyKey).toBe("key-1");
});

test("a checksummed stored spelling is found by a lowercase key", () => {
  // The stored spelling is whatever custody produced: viem checksums a derived pocket, Circle
  // hands back lowercase. Neither the caller nor the row gets to decide the casing.
  repo.upsert(record({ pocketAddress: POCKET }));
  expect(repo.findByPocketAddress(POCKET.toLowerCase())?.idempotencyKey).toBe("key-1");
});

test("a lowercase stored spelling is found by a checksummed key", () => {
  repo.upsert(record({ pocketAddress: POCKET.toLowerCase() }));
  expect(repo.findByPocketAddress(POCKET)?.idempotencyKey).toBe("key-1");
});

test("an address nobody pays from is undefined, and a treasury is not a pocket", () => {
  repo.upsert(record({ pocketAddress: POCKET }));
  expect(repo.findByPocketAddress("0x000000000000000000000000000000000000dead")).toBeUndefined();
  // The treasury index and the pocket index are separate keys onto the same row.
  expect(repo.findByPocketAddress("0x00000000000000000000000000000000000000Ab")).toBeUndefined();
  expect(repo.findByTreasury("0x00000000000000000000000000000000000000Ab")?.idempotencyKey).toBe(
    "key-1",
  );
});

test("a row with no pocket address yet is never matched by a null-ish lookup", () => {
  repo.upsert(record({ pocketAddress: null }));
  expect(repo.findByPocketAddress("")).toBeUndefined();
});
