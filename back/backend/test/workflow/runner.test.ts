import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import { usdToUnits } from "../../src/policy/units";
import type { EntityRecord } from "../../src/types";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";

const TENANT = "0x000000000000000000000000000000000000aAaa";
const spec = {
  name: "Demo",
  roles: { manager: "0x00000000000000000000000000000000000000Ma", guardian: TENANT },
} as unknown as AgentSpec;
const passkey = { challenge: "c", attestation: {} } as never;

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

// A fake saga that drives the persisted record to `bound` (mirrors what the real saga upserts).
const runSaga = async (i: {
  idempotencyKey: string;
  tenantId: string;
  specJson: string;
}): Promise<EntityRecord> => {
  const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
  const bound: EntityRecord = {
    ...cur,
    status: "bound" as const,
    agentId: "5",
    treasury: "0x00000000000000000000000000000000000000Fe" as `0x${string}`,
  };
  repo.upsert(bound);
  return bound;
};

/** Minimal EntityRecord seeder for tests that need a specific starting status without running a saga. */
function seedRecord(over: Partial<EntityRecord> & { idempotencyKey: string }): EntityRecord {
  const rec: EntityRecord = {
    name: "Seed",
    status: "pending",
    ownerTenantId: TENANT,
    manager: "0x00000000000000000000000000000000000000Ma",
    guardian: TENANT,
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
    specJson: JSON.stringify(spec),
    error: null,
    ...over,
  };
  repo.upsert(rec);
  return rec;
}

test("start persists a pending record immediately and returns its id", () => {
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: TEST_FUND_CAPS });
  const { id, status } = runner.start({
    spec,
    userKey: "Demo",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  expect(id).toBe(`${TENANT}:Demo`);
  expect(status).toBe("pending");
  const row = repo.findByIdempotencyKey(id)!;
  expect(row.ownerTenantId).toBe(TENANT);
  expect(row.status).toBe("pending");
  expect(row.specJson).toContain("Demo");
});

test("background saga drives the record to bound", async () => {
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: TEST_FUND_CAPS });
  const { id } = runner.start({
    spec,
    userKey: "Demo",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  await runner.settled();
  expect(repo.findByIdempotencyKey(id)?.status).toBe("bound");
});

test("a failing saga marks the record failed with the error", async () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async () => {
      throw new Error("provision blew up");
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const { id } = runner.start({
    spec,
    userKey: "Demo",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  await runner.settled();
  const row = repo.findByIdempotencyKey(id)!;
  expect(row.status).toBe("failed");
  expect(row.error).toBe("provision blew up");
});

test("starting an already in-flight key is a 409 conflict", () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  expect(() =>
    runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey }),
  ).toThrowError(expect.objectContaining({ status: 409 }));
});

test("two tenants may reuse the same userKey", () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  const a = runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  const b = runner.start({
    spec,
    userKey: "Demo",
    tenantId: "0x000000000000000000000000000000000000bBbb",
    guardianPasskey: passkey,
  });
  expect(a.id).not.toBe(b.id);
});

test("reconcileInFlight resumes a record stuck at created (subOrgId present)", async () => {
  // Seed a crashed-mid-flight record: created, with a sub-org id, and persisted spec.
  repo.upsert({
    idempotencyKey: `${TENANT}:Resume`,
    name: "Resume",
    status: "created",
    ownerTenantId: TENANT,
    manager: "0x00000000000000000000000000000000000000Ma",
    guardian: TENANT,
    operator: "0x00000000000000000000000000000000000000Op",
    amendmentDelay: "3600",
    ein: "",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: "5",
    proxy: null,
    treasury: null,
    createTxHash: "0x1",
    bindTxHash: null,
    fundTxHash: null,
    turnkeySubOrgId: "sub_1",
    turnkeyWalletId: "w_1",
    specJson: JSON.stringify(spec),
    error: null,
  });
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: TEST_FUND_CAPS });
  expect(runner.reconcileInFlight()).toBe(1);
  await runner.settled();
  expect(repo.findByIdempotencyKey(`${TENANT}:Resume`)?.status).toBe("bound");
});

test("reconcileInFlight fails a pending record with no sub-org (cannot resume without passkey)", async () => {
  repo.upsert({
    idempotencyKey: `${TENANT}:Stuck`,
    name: "Stuck",
    status: "pending",
    ownerTenantId: TENANT,
    manager: "0x00000000000000000000000000000000000000Ma",
    guardian: TENANT,
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
    specJson: JSON.stringify(spec),
    error: null,
  });
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: TEST_FUND_CAPS });
  runner.reconcileInFlight();
  await runner.settled();
  expect(repo.findByIdempotencyKey(`${TENANT}:Stuck`)?.status).toBe("failed");
});

test("fund() throws 409 for statuses that aren't bound or funded yet", () => {
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: TEST_FUND_CAPS });
  const pending = seedRecord({ idempotencyKey: `${TENANT}:Pending`, status: "pending" });
  expect(() =>
    runner.fund({ id: pending.idempotencyKey, tenantId: TENANT, amount: 1_000_000n }),
  ).toThrowError(expect.objectContaining({ status: 409 }));

  const failed = seedRecord({ idempotencyKey: `${TENANT}:Failed`, status: "failed" });
  expect(() =>
    runner.fund({ id: failed.idempotencyKey, tenantId: TENANT, amount: 1_000_000n }),
  ).toThrowError(expect.objectContaining({ status: 409 }));
});

test("fund() succeeds a second time on an already-funded entity (re-fundable, no 409) — audit fix B-safe", async () => {
  // A saga that mirrors the real onboarding.ts step 7: moves USDC and records a fresh fundTxHash from
  // either "bound" (first fund) or "funded" (re-fund/top-up).
  const fundingSaga = async (i: {
    idempotencyKey: string;
    fundAmount?: bigint;
  }): Promise<EntityRecord> => {
    const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
    if (i.fundAmount && i.fundAmount > 0n && (cur.status === "bound" || cur.status === "funded")) {
      const funded: EntityRecord = {
        ...cur,
        status: "funded" as const,
        fundTxHash: `0xfund-${i.fundAmount}` as `0x${string}`,
      };
      repo.upsert(funded);
      return funded;
    }
    return cur;
  };
  const runner = new OnboardingRunner({ repo, runSaga: fundingSaga, fundCaps: TEST_FUND_CAPS });
  const bound = seedRecord({
    idempotencyKey: `${TENANT}:ReFund`,
    status: "bound",
    treasury: "0x00000000000000000000000000000000000000Fe",
  });

  // First fund: bound -> funded.
  runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: 1_000_000n });
  await runner.settled();
  const afterFirst = repo.findByIdempotencyKey(bound.idempotencyKey)!;
  expect(afterFirst.status).toBe("funded");
  expect(afterFirst.fundTxHash).toBe("0xfund-1000000");

  // Second fund on the now-"funded" entity: must not throw 409, and must actually move more USDC
  // (a fresh fundTxHash), not silently no-op.
  expect(() =>
    runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: 500_000n }),
  ).not.toThrow();
  await runner.settled();
  const afterSecond = repo.findByIdempotencyKey(bound.idempotencyKey)!;
  expect(afterSecond.status).toBe("funded");
  expect(afterSecond.fundTxHash).toBe("0xfund-500000");
});

// ── S1: funding caps (per-call + per-tenant lifetime quota) ────────────────────────────────────

test("fund() rejects a non-positive amount before scheduling the saga", () => {
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: TEST_FUND_CAPS });
  const bound = seedRecord({ idempotencyKey: `${TENANT}:Zero`, status: "bound" });
  expect(() =>
    runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: 0n }),
  ).toThrowError(expect.objectContaining({ status: 400, message: "amount must be positive" }));
  expect(() =>
    runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: -1n }),
  ).toThrowError(expect.objectContaining({ status: 400, message: "amount must be positive" }));
});

test("fund() rejects an amount over the per-call cap", () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: { perCall: usdToUnits("25"), perTenantTotal: usdToUnits("100") },
  });
  const bound = seedRecord({ idempotencyKey: `${TENANT}:OverCap`, status: "bound" });
  expect(() =>
    runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("25.000001") }),
  ).toThrowError(
    expect.objectContaining({
      status: 400,
      code: "limit_exceeded",
      message: "amount exceeds the max treasury fund per call",
    }),
  );
  // Exactly at the cap is allowed (boundary check).
  expect(() =>
    runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("25") }),
  ).not.toThrow();
});

/** A saga that mirrors onboarding.ts Step 7: on success, records BOTH the upsert and the
 *  `fundTreasury`/`funded` event that `sumFundedByTenant` sums — the real quota write path. */
function makeFundingSagaWithEvent() {
  return async (i: {
    idempotencyKey: string;
    fundAmount?: bigint;
  }): Promise<EntityRecord> => {
    const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
    if (i.fundAmount && i.fundAmount > 0n && (cur.status === "bound" || cur.status === "funded")) {
      const funded: EntityRecord = {
        ...cur,
        status: "funded" as const,
        fundTxHash: `0xfund-${i.fundAmount}` as `0x${string}`,
      };
      repo.transaction(() => {
        repo.upsert(funded);
        repo.recordEvent(
          i.idempotencyKey,
          "fundTreasury",
          "funded",
          `0xfund-${i.fundAmount}`,
          JSON.stringify({ amount: i.fundAmount?.toString() }),
        );
      });
      return funded;
    }
    return cur;
  };
}

test("fund() enforces the per-tenant lifetime quota: fund 2 then fund 2 (limit 3) rejects the second", async () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: makeFundingSagaWithEvent(),
    fundCaps: { perCall: usdToUnits("25"), perTenantTotal: usdToUnits("3") },
  });
  const bound = seedRecord({
    idempotencyKey: `${TENANT}:Quota`,
    status: "bound",
    treasury: "0x00000000000000000000000000000000000000Fe",
  });

  // First fund: 2 USDC — within the 3 USDC lifetime quota.
  runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("2") });
  await runner.settled();
  expect(repo.findByIdempotencyKey(bound.idempotencyKey)?.status).toBe("funded");
  expect(repo.sumFundedByTenant(TENANT)).toBe(usdToUnits("2"));

  // Second fund: another 2 USDC would bring the tenant total to 4 USDC — over the 3 USDC quota.
  expect(() =>
    runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("2") }),
  ).toThrowError(
    expect.objectContaining({
      status: 400,
      code: "limit_exceeded",
      message: "tenant treasury funding quota exhausted",
    }),
  );
  // The rejected call must not have moved anything: the tenant total is unchanged.
  expect(repo.sumFundedByTenant(TENANT)).toBe(usdToUnits("2"));
});

test("fund() a FAILED fund attempt does not consume the tenant's quota (no funded event written)", async () => {
  const QUOTA_TENANT = "0x000000000000000000000000000000000000dDdd";
  const throwingSaga = async (): Promise<EntityRecord> => {
    throw new Error("on-chain fundTreasury tx reverted");
  };
  const runner = new OnboardingRunner({
    repo,
    runSaga: throwingSaga,
    fundCaps: { perCall: usdToUnits("25"), perTenantTotal: usdToUnits("3") },
  });
  const bound = seedRecord({
    idempotencyKey: `${QUOTA_TENANT}:FailedFund`,
    ownerTenantId: QUOTA_TENANT,
    status: "bound",
  });

  // Attempt the FULL quota amount; the background saga throws before any event is recorded.
  // "bound" is already a terminal onboarding status, so a failed re-fund attempt leaves it as-is
  // (the runner's crash handler only downgrades non-terminal statuses) — the entity itself is
  // untouched; what matters here is that NO fundTreasury/funded event was written.
  runner.fund({ id: bound.idempotencyKey, tenantId: QUOTA_TENANT, amount: usdToUnits("3") });
  await runner.settled();
  expect(repo.findByIdempotencyKey(bound.idempotencyKey)?.status).toBe("bound");
  expect(repo.sumFundedByTenant(QUOTA_TENANT)).toBe(0n);

  // Fund the SAME full quota amount again with a working saga — it must succeed, proving the
  // earlier failure consumed nothing from the tenant's lifetime quota.
  const workingRunner = new OnboardingRunner({
    repo,
    runSaga: makeFundingSagaWithEvent(),
    fundCaps: { perCall: usdToUnits("25"), perTenantTotal: usdToUnits("3") },
  });
  expect(() =>
    workingRunner.fund({
      id: bound.idempotencyKey,
      tenantId: QUOTA_TENANT,
      amount: usdToUnits("3"),
    }),
  ).not.toThrow();
  await workingRunner.settled();
  expect(repo.findByIdempotencyKey(bound.idempotencyKey)?.status).toBe("funded");
  expect(repo.sumFundedByTenant(QUOTA_TENANT)).toBe(usdToUnits("3"));
});
