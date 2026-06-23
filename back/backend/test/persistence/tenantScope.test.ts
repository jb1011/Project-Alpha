import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

let db: Database.Database;
let repo: SqliteEntityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

const rec = (over: Partial<EntityRecord>): EntityRecord => ({
  idempotencyKey: "k",
  name: "A",
  status: "pending",
  manager: "0x000000000000000000000000000000000000aAaa",
  guardian: "0x000000000000000000000000000000000000bBbb",
  operator: null,
  amendmentDelay: "3600",
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
  ...over,
});

test("owner_tenant_id, error, spec_json round-trip; pending/failed accepted", () => {
  repo.upsert(
    rec({
      idempotencyKey: "t1:a",
      ownerTenantId: "t1",
      status: "failed",
      error: "boom",
      specJson: '{"x":1}',
    }),
  );
  const got = repo.findByIdempotencyKey("t1:a");
  expect(got?.ownerTenantId).toBe("t1");
  expect(got?.status).toBe("failed");
  expect(got?.error).toBe("boom");
  expect(got?.specJson).toBe('{"x":1}');
});

test("listByTenant returns only that tenant's rows", () => {
  repo.upsert(rec({ idempotencyKey: "t1:a", ownerTenantId: "t1" }));
  repo.upsert(rec({ idempotencyKey: "t2:a", ownerTenantId: "t2" }));
  repo.upsert(rec({ idempotencyKey: "t1:b", ownerTenantId: "t1" }));
  expect(
    repo
      .listByTenant("t1")
      .map((r) => r.idempotencyKey)
      .sort(),
  ).toEqual(["t1:a", "t1:b"]);
  expect(repo.listByTenant("t2").map((r) => r.idempotencyKey)).toEqual(["t2:a"]);
});

test("listInFlight returns only non-terminal statuses", () => {
  repo.upsert(rec({ idempotencyKey: "p", status: "pending", ownerTenantId: "t" }));
  repo.upsert(rec({ idempotencyKey: "c", status: "created", ownerTenantId: "t" }));
  repo.upsert(rec({ idempotencyKey: "b", status: "bound", ownerTenantId: "t" }));
  repo.upsert(rec({ idempotencyKey: "f", status: "funded", ownerTenantId: "t" }));
  repo.upsert(rec({ idempotencyKey: "x", status: "failed", ownerTenantId: "t" }));
  expect(
    repo
      .listInFlight()
      .map((r) => r.idempotencyKey)
      .sort(),
  ).toEqual(["c", "p"]);
});
