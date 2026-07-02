import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { resolveKey } from "../../src/mcp/auth";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate } from "../../src/persistence/db";

function store() {
  const db = new Database(":memory:");
  migrate(db);
  return new SqliteApiKeyStore(db);
}

test("resolveKey returns the full scope for a valid Bearer key", () => {
  const s = store();
  const { key } = s.mint("tenantA", { entityId: "ent-1", capability: "spend" });
  expect(resolveKey(`Bearer ${key}`, s)).toEqual({
    tenantId: "tenantA",
    id: expect.any(String),
    entityId: "ent-1",
    capability: "spend",
  });
});

test("resolveKey returns null for missing/malformed/invalid auth", () => {
  const s = store();
  expect(resolveKey(undefined, s)).toBeNull();
  expect(resolveKey("Basic xyz", s)).toBeNull();
  expect(resolveKey("Bearer not-a-key", s)).toBeNull();
});
