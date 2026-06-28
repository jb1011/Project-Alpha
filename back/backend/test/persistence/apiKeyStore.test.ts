import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";
let db: Database.Database;
let store: SqliteApiKeyStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqliteApiKeyStore(db);
});
afterEach(() => db.close());

test("mint returns a prefixed plaintext key that verify maps back to the tenant", () => {
  const { id, key } = store.mint(TENANT, "laptop");
  expect(key.startsWith("mcp_")).toBe(true);
  const got = store.verify(key);
  expect(got).toEqual({ tenantId: TENANT, id });
});

test("verify returns null for an unknown key", () => {
  store.mint(TENANT);
  expect(store.verify("mcp_nope")).toBeNull();
});

test("revoke makes the key unverifiable; list reflects revocation, never leaks secrets", () => {
  const { id, key } = store.mint(TENANT, "ci");
  expect(store.revoke(TENANT, id)).toBe(true);
  expect(store.verify(key)).toBeNull();
  const views = store.list(TENANT);
  expect(views).toHaveLength(1);
  expect(views[0]!).toMatchObject({ id, label: "ci" });
  expect(views[0]!.revokedAt).toBeTypeOf("number");
  expect(JSON.stringify(views)).not.toContain("hash");
  expect(JSON.stringify(views)).not.toContain(key);
});

test("revoke is tenant-scoped: another tenant cannot revoke and list is isolated", () => {
  const { id } = store.mint(TENANT);
  expect(store.revoke(OTHER, id)).toBe(false);
  expect(store.list(OTHER)).toHaveLength(0);
});
