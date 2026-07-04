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
  const { id, key } = store.mint(TENANT, { label: "laptop" });
  expect(key.startsWith("mcp_")).toBe(true);
  const got = store.verify(key);
  expect(got).toEqual({ tenantId: TENANT, id, entityId: null, capability: "spend" });
});

test("verify returns null for an unknown key", () => {
  store.mint(TENANT);
  expect(store.verify("mcp_nope")).toBeNull();
});

test("revoke makes the key unverifiable; list reflects revocation, never leaks secrets", () => {
  const { id, key } = store.mint(TENANT, { label: "ci" });
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

test("mint scoped to an entity + capability round-trips via verify", () => {
  const { key } = store.mint(TENANT, { entityId: "ent-1", capability: "spend" });
  const v = store.verify(key);
  expect(v).toEqual({
    tenantId: TENANT,
    id: expect.any(String),
    entityId: "ent-1",
    capability: "spend",
  });
});

test("verify rejects an expired key", () => {
  const { key } = store.mint(TENANT, { ttlMs: -1 }); // already expired
  expect(store.verify(key)).toBeNull();
});

test("mint with no opts stays tenant-wide with default capability (back-compat)", () => {
  const { key } = store.mint(TENANT);
  expect(store.verify(key)).toEqual({
    tenantId: TENANT,
    id: expect.any(String),
    entityId: null,
    capability: "spend",
  });
});

test("list() surfaces entityId + capability (per-agent and tenant-wide)", () => {
  const tenant = "0xTEN";
  store.mint(tenant, {
    entityId: `${tenant}:agent-1`,
    capability: "read",
    label: `connect:${tenant}:agent-1`,
  });
  store.mint(tenant, { capability: "spend", label: "bootstrap:pk-1" }); // tenant-wide: no entityId
  const rows = store.list(tenant);

  const connect = rows.find((r) => r.label === `connect:${tenant}:agent-1`);
  expect(connect?.entityId).toBe(`${tenant}:agent-1`);
  expect(connect?.capability).toBe("read");

  const boot = rows.find((r) => r.label === "bootstrap:pk-1");
  expect(boot?.entityId).toBeNull();
  expect(boot?.capability).toBe("spend");
});
