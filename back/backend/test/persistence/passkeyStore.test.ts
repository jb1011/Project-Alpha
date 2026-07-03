import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GuardianPasskey } from "../../src/adapters/turnkey/provisioner";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";
const PK: GuardianPasskey = {
  authenticatorName: "Test Key",
  challenge: "Y2hhbGxlbmdl",
  attestation: {
    credentialId: "cred-1",
    clientDataJson: "e30=",
    attestationObject: "o2M=",
    transports: ["internal"],
  },
};
let db: Database.Database;
let store: SqlitePasskeyStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqlitePasskeyStore(db);
});
afterEach(() => db.close());

test("store then get round-trips the full GuardianPasskey for the owning tenant", () => {
  const id = store.store(TENANT, PK);
  expect(store.get(TENANT, id)).toEqual(PK);
});

test("get is tenant-scoped: another tenant sees null", () => {
  const id = store.store(TENANT, PK);
  expect(store.get(OTHER, id)).toBeNull();
});

test("get returns null for an unknown handle", () => {
  expect(store.get(TENANT, "nope")).toBeNull();
});

test("list returns secret-free metadata for the tenant only", () => {
  store.store(TENANT, PK);
  expect(store.list(OTHER)).toHaveLength(0);
  const views = store.list(TENANT);
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ name: "Test Key" });
  expect(JSON.stringify(views)).not.toContain("attestationObject");
});

test("revoke hides the passkey from get() but keeps it in list() with revokedAt", () => {
  const id = store.store(TENANT, PK);
  expect(store.get(TENANT, id)).not.toBeNull();
  expect(store.revoke(TENANT, id)).toBe(true);
  expect(store.get(TENANT, id)).toBeNull(); // can no longer authorize onboard/bootstrap
  const listed = store.list(TENANT);
  expect(listed).toHaveLength(1);
  expect(listed[0]!.revokedAt).toBeGreaterThan(0);
});

test("revoke is tenant-scoped and idempotent-safe", () => {
  const id = store.store(TENANT, PK);
  expect(store.revoke(OTHER, id)).toBe(false); // wrong tenant → no-op
  expect(store.get(TENANT, id)).not.toBeNull();
  expect(store.revoke(TENANT, id)).toBe(true);
  expect(store.revoke(TENANT, id)).toBe(false); // already revoked → no row updated
});
