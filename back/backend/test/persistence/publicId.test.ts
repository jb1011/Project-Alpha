import type Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

const base: EntityRecord = {
  idempotencyKey: "0xA:agent",
  name: "A",
  status: "bound",
  manager: "0x0000000000000000000000000000000000000001",
  guardian: "0x0000000000000000000000000000000000000002",
  operator: null,
  amendmentDelay: "0",
  ein: "",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: null,
  proxy: null,
  treasury: null,
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
};

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});

test("findByPublicId round-trips a stored publicId", () => {
  repo.upsert({ ...base, publicId: "11111111-1111-1111-1111-111111111111" });
  const got = repo.findByPublicId("11111111-1111-1111-1111-111111111111");
  expect(got?.idempotencyKey).toBe("0xA:agent");
  expect(repo.findByPublicId("no-such-id")).toBeUndefined();
});

test("the unique index tolerates multiple null publicIds", () => {
  repo.upsert({ ...base, idempotencyKey: "0xA:one" });
  repo.upsert({ ...base, idempotencyKey: "0xA:two" });
  expect(repo.findByIdempotencyKey("0xA:one")?.publicId ?? null).toBeNull();
  expect(repo.findByIdempotencyKey("0xA:two")?.publicId ?? null).toBeNull();
});
