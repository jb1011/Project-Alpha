// backend/test/entityRepository.turnkey.test.ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../src/persistence/db";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";

function repo() {
  const db = new Database(":memory:");
  migrate(db);
  return new SqliteEntityRepository(db);
}

test("persists + reads the per-agent Turnkey ids and the provisioned status", () => {
  const r = repo();
  r.upsert({
    idempotencyKey: "k1",
    name: "Agent",
    status: "provisioned",
    manager: `0x${"a".repeat(40)}`,
    guardian: `0x${"b".repeat(40)}`,
    operator: `0x${"c".repeat(40)}`,
    amendmentDelay: 3600n,
    ein: "STUB",
    formationDate: 0,
    turnkeySubOrgId: "suborg-1",
    turnkeyWalletId: "wallet-1",
  } as never);
  const got = r.findByIdempotencyKey("k1");
  expect(got?.status).toBe("provisioned");
  expect(got?.turnkeySubOrgId).toBe("suborg-1");
  expect(got?.turnkeyWalletId).toBe("wallet-1");
});
