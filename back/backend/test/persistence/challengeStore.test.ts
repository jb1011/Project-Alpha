import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { SqliteChallengeStore } from "../../src/persistence/challengeStore";
import { migrate } from "../../src/persistence/db";

function store() {
  const db = new Database(":memory:");
  migrate(db);
  return new SqliteChallengeStore(db);
}

test("issues then consumes once (burn-on-consume), tenant-scoped", () => {
  const s = store();
  const ch = s.issue("tenantA", 1_000, 60_000);
  expect(s.consume("tenantB", ch, 2_000)).toBe(false); // wrong tenant
  expect(s.consume("tenantA", ch, 2_000)).toBe(true); // ok, and burns it
  expect(s.consume("tenantA", ch, 3_000)).toBe(false); // already consumed
});

test("rejects an expired challenge (and burns it)", () => {
  const s = store();
  const ch = s.issue("tenantA", 1_000, 10);
  expect(s.consume("tenantA", ch, 2_000)).toBe(false); // expired
});
