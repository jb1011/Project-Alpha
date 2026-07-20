import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../src/persistence/db";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import type { EntityRecord } from "../src/types";

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
  status: "translating",
  manager: "0x000000000000000000000000000000000000aAaa",
  guardian: "0x000000000000000000000000000000000000bBbb",
  operator: null,
  amendmentDelay: "86400",
  ein: "STUB-NOT-FILED",
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

test("upsert then findByIdempotencyKey round-trips, incl. bigint-as-string + json", () => {
  repo.upsert(
    record({
      treasuryConfig: {
        usdc: "0x3600000000000000000000000000000000000000",
        payoutAddress: "0x000000000000000000000000000000000000cCcc",
        cap: 1_000_000n,
        period: 2_592_000n,
        allowlistEnabled: false,
      },
    }),
  );
  const got = repo.findByIdempotencyKey("key-1");
  expect(got?.name).toBe("Demo Agent");
  expect(got?.treasuryConfig?.cap).toBe(1_000_000n);
  expect(got?.treasuryConfig?.period).toBe(2_592_000n);
});

test("upsert updates an existing row (same idempotencyKey)", () => {
  repo.upsert(record());
  repo.upsert(
    record({
      status: "created",
      agentId: "0",
      proxy: "0x000000000000000000000000000000000000dEaD",
    }),
  );
  const got = repo.findByIdempotencyKey("key-1");
  expect(got?.status).toBe("created");
  expect(got?.agentId).toBe("0");
  expect(repo.list()).toHaveLength(1);
});

test("findByAgentId locates a created entity", () => {
  repo.upsert(record({ status: "created", agentId: "42" }));
  expect(repo.findByAgentId("42")?.idempotencyKey).toBe("key-1");
});

test("recordEvent + listEvents append-only audit trail", () => {
  repo.upsert(record());
  repo.recordEvent("key-1", "createEntity", "created", "0xabc", "{}");
  repo.recordEvent("key-1", "setAgentWallet", "bound", "0xdef", "{}");
  expect(repo.listEvents("key-1").map((e) => e.step)).toEqual(["createEntity", "setAgentWallet"]);
});

test("transaction rolls back all writes if the body throws (atomic upsert + event)", () => {
  expect(() =>
    repo.transaction(() => {
      repo.upsert(record());
      repo.recordEvent("key-1", "createEntity", "created", "0xabc", "{}");
      throw new Error("boom");
    }),
  ).toThrow("boom");
  // Nothing should have persisted: the entity insert and the event are rolled back together.
  expect(repo.findByIdempotencyKey("key-1")).toBeUndefined();
  expect(repo.listEvents("key-1")).toHaveLength(0);
});

test("transaction commits both writes on success", () => {
  repo.transaction(() => {
    repo.upsert(record());
    repo.recordEvent("key-1", "createEntity", "created", "0xabc", "{}");
  });
  expect(repo.findByIdempotencyKey("key-1")?.status).toBe("translating");
  expect(repo.listEvents("key-1")).toHaveLength(1);
});

test("claimKey returns true when the idempotency key is unclaimed", () => {
  expect(repo.claimKey(record())).toBe(true);
  // the claim persisted the row so it can be resumed/observed.
  expect(repo.findByIdempotencyKey("key-1")?.status).toBe("translating");
});

test("claimKey returns false on a second claim and does NOT overwrite the existing row", () => {
  expect(repo.claimKey(record({ status: "pending", name: "First" }))).toBe(true);
  // A second runner racing the same key loses the claim...
  expect(repo.claimKey(record({ status: "created", name: "Second", agentId: "99" }))).toBe(false);
  // ...and crucially the first owner's row is untouched (unlike upsert, which would overwrite).
  const got = repo.findByIdempotencyKey("key-1");
  expect(got?.status).toBe("pending");
  expect(got?.name).toBe("First");
  expect(got?.agentId).toBeNull();
});

test("findByTreasury returns the entity owning a treasury address (case-insensitive)", () => {
  const rec = record({ status: "bound" });
  rec.treasury = "0x000000000000000000000000000000000000000F" as `0x${string}`;
  repo.upsert(rec);
  expect(repo.findByTreasury("0x000000000000000000000000000000000000000f")?.idempotencyKey).toBe(
    rec.idempotencyKey,
  );
  expect(repo.findByTreasury("0x0000000000000000000000000000000000000001")).toBeUndefined();
});

test("perTxCap round-trips as bigint (set and unset)", () => {
  // With a cap set: stored as decimal string, read back as bigint
  repo.upsert(record({ perTxCap: 50_000n }));
  const got = repo.findByIdempotencyKey("key-1");
  expect(got?.perTxCap).toBe(50_000n);

  // Update to null (no cap)
  repo.upsert(record({ perTxCap: null }));
  const got2 = repo.findByIdempotencyKey("key-1");
  expect(got2?.perTxCap).toBeNull();
});

test("perTxCap defaults to null when not provided (backward compat)", () => {
  // The record() helper doesn't set perTxCap — the row reads back as null
  repo.upsert(record());
  const got = repo.findByIdempotencyKey("key-1");
  expect(got?.perTxCap).toBeNull();
});

test("sumFundedByTenant sums only funded fundTreasury events for the target tenant", () => {
  const TENANT_A = "0x000000000000000000000000000000000000aAaa";
  const TENANT_B = "0x000000000000000000000000000000000000bBbb";

  // Tenant A, entity 1: two successful funds.
  repo.upsert(record({ idempotencyKey: "a-1", ownerTenantId: TENANT_A }));
  repo.recordEvent("a-1", "fundTreasury", "funded", "0x1", JSON.stringify({ amount: "2000000" }));
  repo.recordEvent("a-1", "fundTreasury", "funded", "0x2", JSON.stringify({ amount: "1000000" }));

  // Tenant A, entity 2: one successful fund — same tenant, different entity, must be included.
  repo.upsert(record({ idempotencyKey: "a-2", ownerTenantId: TENANT_A }));
  repo.recordEvent("a-2", "fundTreasury", "funded", "0x3", JSON.stringify({ amount: "500000" }));

  // Tenant B, entity 1: a successful fund that must NOT leak into tenant A's total.
  repo.upsert(record({ idempotencyKey: "b-1", ownerTenantId: TENANT_B }));
  repo.recordEvent("b-1", "fundTreasury", "funded", "0x4", JSON.stringify({ amount: "9000000" }));

  expect(repo.sumFundedByTenant(TENANT_A)).toBe(3_500_000n);
  expect(repo.sumFundedByTenant(TENANT_B)).toBe(9_000_000n);
});

test("sumFundedByTenant ignores non-funded status and non-fundTreasury steps", () => {
  const TENANT_A = "0x000000000000000000000000000000000000aAaa";
  repo.upsert(record({ idempotencyKey: "a-1", ownerTenantId: TENANT_A }));
  // A failed fund attempt (no successful on-chain tx) must not count toward the quota.
  repo.recordEvent("a-1", "fundTreasury", "failed", null, JSON.stringify({ amount: "2000000" }));
  // A different step name, even if its detail also carries an "amount" key, must not count.
  repo.recordEvent("a-1", "createEntity", "funded", "0x1", JSON.stringify({ amount: "7000000" }));

  expect(repo.sumFundedByTenant(TENANT_A)).toBe(0n);
});

test("sumFundedByTenant returns 0 for a tenant with no entities/events", () => {
  expect(repo.sumFundedByTenant("0x000000000000000000000000000000000000cCcc")).toBe(0n);
});
