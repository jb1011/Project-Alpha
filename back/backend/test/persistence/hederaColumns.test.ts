import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { hederaDb } from "../helpers/hederaApp";

test("migrate twice on one db is idempotent", () => {
  const db = new Database(":memory:");
  migrate(db);
  expect(() => migrate(db)).not.toThrow();
  db.close();
});

test("upsert an entity, setHederaLink, findByPublicId returns the four link fields", () => {
  const { repo, rec } = hederaDb();
  repo.setHederaLink(rec.idempotencyKey, {
    accountId: "0.0.10412694",
    agentPublicKey: "02abc",
    guardianPublicKey: "03def",
    linkedAt: 1_789_100_000,
  });
  const found = repo.findByPublicId(rec.publicId as string);
  expect(found?.hederaAccountId).toBe("0.0.10412694");
  expect(found?.hederaAgentPublicKey).toBe("02abc");
  expect(found?.hederaGuardianPublicKey).toBe("03def");
  expect(found?.hederaLinkedAt).toBe(1_789_100_000);
});

test("setHederaIdentity returns the three identity fields", () => {
  const { repo, rec } = hederaDb();
  repo.setHederaIdentity(rec.idempotencyKey, {
    agentId: "886257",
    registerTx: "0xregistertx",
    uaid: "uaid:novicorpus:FormationE2E_1:1:mcp:eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf",
  });
  const found = repo.findByPublicId(rec.publicId as string);
  expect(found?.hederaAgentId).toBe("886257");
  expect(found?.hederaRegisterTx).toBe("0xregistertx");
  expect(found?.uaid).toBe(
    "uaid:novicorpus:FormationE2E_1:1:mcp:eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf",
  );
});

test("an entity never linked returns null for all seven Hedera fields", () => {
  const { repo, rec } = hederaDb();
  const found = repo.findByPublicId(rec.publicId as string);
  expect(found?.hederaAccountId).toBeNull();
  expect(found?.hederaAgentPublicKey).toBeNull();
  expect(found?.hederaGuardianPublicKey).toBeNull();
  expect(found?.hederaLinkedAt).toBeNull();
  expect(found?.hederaAgentId).toBeNull();
  expect(found?.hederaRegisterTx).toBeNull();
  expect(found?.uaid).toBeNull();
});
