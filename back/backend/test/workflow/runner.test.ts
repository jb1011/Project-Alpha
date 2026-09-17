import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadConfig } from "../../src/config/env";
import { resolveFormationDeployment } from "../../src/formation";
import { createCompany } from "../../src/formation/company";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
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

/** The minimum loadConfig needs; the formation tests below add the doola half on top. */
const CFG_BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

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
  // The ref suffix (Q4) is part of the STORED error — asserted here rather than relaxed to a
  // substring, so this still pins the whole string.
  expect(row.error).toMatch(/^provision blew up \(ref [0-9a-f]{8}\)$/);
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

// ── A FUND FAILURE IS A RECORDED FAILURE (2026-09-14) ─────────────────────────────────────────

/**
 * The 2026-09-14 incident: the platform wallet was nearly empty, `fundTreasury` reverted, and
 * NOTHING WAS EVER WRITTEN — no status change, no `error`, no event. The wizard's FundStep polls
 * for `funded` or `failed`, so it span forever on a fund that had already failed.
 *
 * The cause was the crash handler's terminal guard: a fund saga always runs on a `bound` or
 * `funded` entity, both of which are in TERMINAL, so every fund failure was swallowed by design.
 * The status still must not move (`bound` is the truth about the entity — it IS bound), so the
 * failure has to be recorded BESIDE the status: `error` on the row, and one event on the trail.
 */
const SEPTEMBER_MESSAGE = [
  "HTTP request failed.",
  "",
  "Status: 500",
  "URL: https://arc-sepolia.example.com/v2/AbCdEf0123456789SECRET",
  `Request body: {"method":"eth_sendRawTransaction","params":["0x02f8b2${"ab".repeat(120)}"]}`,
].join("\n");

test("a fund saga that throws on a BOUND entity records the failure instead of swallowing it", async () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async () => {
      throw new Error("on-chain fundTreasury tx reverted");
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const bound = seedRecord({
    idempotencyKey: `${TENANT}:FundFail`,
    status: "bound",
    treasury: "0x00000000000000000000000000000000000000Fe",
  });

  runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("2") });
  await runner.settled();

  const row = repo.findByIdempotencyKey(bound.idempotencyKey)!;
  // The status is still the truth about the entity: it IS bound, and a failed transfer does not
  // un-bind it. What changed is that the attempt is now visible.
  expect(row.status).toBe("bound");
  expect(row.error).toMatch(/^on-chain fundTreasury tx reverted \(ref [0-9a-f]{8}\)$/);
  // …and the trail shows the attempt, which is what an operator reads after the fact.
  const events = repo.listEvents(bound.idempotencyKey).filter((e) => e.step === "fundTreasury");
  expect(events).toHaveLength(1);
  expect(events[0]!.status).toBe("failed");
  expect(JSON.parse(events[0]!.detail!).error).toMatch(
    /^on-chain fundTreasury tx reverted \(ref [0-9a-f]{8}\)$/,
  );
  // ⚠ THE QUOTA IS UNTOUCHED. `sumFundedByTenant` counts `fundTreasury`/`funded` events only, so
  // a `failed` one beside them must not consume a cent of the tenant's lifetime allowance.
  expect(repo.sumFundedByTenant(TENANT)).toBe(0n);
});

test("the recorded fund error is the PUBLIC message — no key, no path, no raw tx in the database", async () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async () => {
      throw new Error(SEPTEMBER_MESSAGE);
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const bound = seedRecord({ idempotencyKey: `${TENANT}:FundLeak`, status: "bound" });

  runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("1") });
  await runner.settled();

  const row = repo.findByIdempotencyKey(bound.idempotencyKey)!;
  const stored = `${row.error} ${repo.listEvents(bound.idempotencyKey)[0]?.detail}`;
  expect(stored).not.toContain("AbCdEf0123456789SECRET");
  expect(stored).not.toContain("/v2/");
  expect(stored).not.toContain("0x02f8b2abab");
  // The host survives, because "which RPC refused us" is the first thing an operator asks.
  expect(row.error).toContain("https://arc-sepolia.example.com");
});

test("a non-terminal failure still becomes `failed`, with the sanitised message", async () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async () => {
      throw new Error(SEPTEMBER_MESSAGE);
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const { id } = runner.start({
    spec,
    userKey: "Leak",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  await runner.settled();
  const row = repo.findByIdempotencyKey(id)!;
  expect(row.status).toBe("failed");
  expect(row.error).not.toContain("AbCdEf0123456789SECRET");
  expect(row.error).not.toContain("0x02f8b2abab");
  expect(row.error).toContain("HTTP request failed.");
});

test("a second fund attempt clears the previous attempt's error BEFORE it runs", async () => {
  // Why this matters: FundStep treats any `error` it sees while polling as belonging to the
  // attempt it just started. Without the clear, the very first poll of a retry reads the OLD
  // failure and reports the retry as failed a second later — while it is still in flight.
  const failing = new OnboardingRunner({
    repo,
    runSaga: async () => {
      throw new Error("first attempt reverted");
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const bound = seedRecord({ idempotencyKey: `${TENANT}:FundRetry`, status: "bound" });
  failing.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("1") });
  await failing.settled();
  expect(repo.findByIdempotencyKey(bound.idempotencyKey)?.error).toMatch(
    /^first attempt reverted \(ref [0-9a-f]{8}\)$/,
  );

  // The retry: the error must be gone the moment `fund()` returns, not when the saga finishes.
  let errorWhileRunning: string | null | undefined = "unread";
  const slow = new OnboardingRunner({
    repo,
    runSaga: async (i) => {
      errorWhileRunning = repo.findByIdempotencyKey(i.idempotencyKey)?.error;
      return repo.findByIdempotencyKey(i.idempotencyKey)!;
    },
    fundCaps: TEST_FUND_CAPS,
  });
  slow.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("1") });
  expect(repo.findByIdempotencyKey(bound.idempotencyKey)?.error).toBeNull();
  await slow.settled();
  expect(errorWhileRunning).toBeNull();
});

test("a SUCCESSFUL fund leaves `error` null even after a failed attempt", async () => {
  const failing = new OnboardingRunner({
    repo,
    runSaga: async () => {
      throw new Error("first attempt reverted");
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const bound = seedRecord({
    idempotencyKey: `${TENANT}:FundThenOk`,
    status: "bound",
    treasury: "0x00000000000000000000000000000000000000Fe",
  });
  failing.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("1") });
  await failing.settled();
  expect(repo.findByIdempotencyKey(bound.idempotencyKey)?.error).not.toBeNull();

  const working = new OnboardingRunner({
    repo,
    runSaga: makeFundingSagaWithEvent(),
    fundCaps: TEST_FUND_CAPS,
  });
  working.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("1") });
  await working.settled();
  const row = repo.findByIdempotencyKey(bound.idempotencyKey)!;
  expect(row.status).toBe("funded");
  expect(row.error).toBeNull();
});

test("a record already `failed` keeps the FIRST reason a human is reading", async () => {
  // The catch's third branch. A saga that marks the row failed with a reason of its own and then
  // rethrows must not have that reason replaced by whatever the exception happened to say — the
  // specific one is the one somebody is looking at.
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => {
      const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
      repo.upsert({ ...cur, status: "failed", error: "the original reason" });
      throw new Error("and then the wrapper blew up too");
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const { id } = runner.start({
    spec,
    userKey: "AlreadyFailed",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  await runner.settled();
  const row = repo.findByIdempotencyKey(id)!;
  expect(row.status).toBe("failed");
  expect(row.error).toBe("the original reason");
});

/* ── R3: a fund failure is recorded because we RAN a fund, not because the row looks fundable ─ */

test("R3: an ONBOARD tail failure on a bound row is not labelled a fund failure", async () => {
  // The mirror image of the 2026-09-14 bug. `fundAttempt` was inferred from the row's status, but
  // the onboard saga REACHES `bound` and then keeps going (ENS, formation) — so a throw in that
  // tail was recorded as `fundTreasury`/`failed` on an onboarding that never asked to fund, and
  // the error landed in the field the wizard reads.
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => {
      const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
      repo.upsert({ ...cur, status: "bound", agentId: "5" });
      throw new Error("formation lookup blew up after the bind");
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const { id } = runner.start({
    spec,
    userKey: "TailFail",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  await runner.settled();

  const row = repo.findByIdempotencyKey(id)!;
  expect(row.status).toBe("bound");
  // NOT in the field the wizard reads: no fund was attempted, so nothing here is a fund verdict.
  expect(row.error).toBeNull();
  expect(repo.listEvents(id).filter((e) => e.step === "fundTreasury")).toHaveLength(0);
  // It is still on the trail — a tail failure is not nothing.
  const tail = repo.listEvents(id).filter((e) => e.step === "sagaTail");
  expect(tail).toHaveLength(1);
  expect(tail[0]!.status).toBe("failed");
  expect(tail[0]!.detail).toContain("formation lookup blew up");
});

test("R3: a throw AFTER the transfer succeeded never puts an error beside money that moved", async () => {
  // The dangerous direction. Step 7 succeeded (`funded`, `fundTxHash`, `error: null`) and step 8
  // then threw. The wizard checks `error` BEFORE `status`, so writing one here reports a failure
  // for USDC that actually left the platform wallet.
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => {
      const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
      repo.transaction(() => {
        repo.upsert({
          ...cur,
          status: "funded",
          fundTxHash: "0xmoved",
          error: null,
        });
        repo.recordEvent(
          i.idempotencyKey,
          "fundTreasury",
          "funded",
          "0xmoved",
          JSON.stringify({ amount: "1000000" }),
        );
      });
      throw new Error("ENS binding blew up after the money moved");
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const bound = seedRecord({ idempotencyKey: `${TENANT}:AfterMoney`, status: "bound" });

  runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: 1_000_000n });
  await runner.settled();

  const row = repo.findByIdempotencyKey(bound.idempotencyKey)!;
  expect(row.status).toBe("funded");
  expect(row.fundTxHash).toBe("0xmoved");
  // ⚠ THE ASSERTION: no error beside a successful transfer.
  expect(row.error).toBeNull();
  // The fund event stands as `funded`; the tail failure is its own row.
  expect(
    repo
      .listEvents(bound.idempotencyKey)
      .filter((e) => e.step === "fundTreasury")
      .map((e) => e.status),
  ).toEqual(["funded"]);
  expect(repo.listEvents(bound.idempotencyKey).filter((e) => e.step === "sagaTail")).toHaveLength(
    1,
  );
  // The quota counts the transfer that happened.
  expect(repo.sumFundedByTenant(TENANT)).toBe(1_000_000n);
});

test("R3: a genuine fund failure is still recorded as one", async () => {
  // The guard must not swallow the case it was built around: same kind, no transfer.
  const runner = new OnboardingRunner({
    repo,
    runSaga: async () => {
      throw new Error("on-chain fundTreasury tx reverted");
    },
    fundCaps: TEST_FUND_CAPS,
  });
  const bound = seedRecord({ idempotencyKey: `${TENANT}:StillRecorded`, status: "bound" });
  runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: 1_000_000n });
  await runner.settled();

  const row = repo.findByIdempotencyKey(bound.idempotencyKey)!;
  expect(row.error).toContain("on-chain fundTreasury tx reverted");
  expect(
    repo.listEvents(bound.idempotencyKey).filter((e) => e.step === "fundTreasury"),
  ).toHaveLength(1);
});

/* ── Q4: the join key ───────────────────────────────────────────────────────────────────────── */

test("Q4: the stored error carries a ref, and the ops line carries the same ref plus the detail", async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const runner = new OnboardingRunner({
      repo,
      runSaga: async () => {
        throw new Error(SEPTEMBER_MESSAGE);
      },
      fundCaps: TEST_FUND_CAPS,
    });
    const bound = seedRecord({ idempotencyKey: `${TENANT}:Ref`, status: "bound" });
    runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: 1_000_000n });
    await runner.settled();

    const row = repo.findByIdempotencyKey(bound.idempotencyKey)!;
    const ref = /\(ref ([0-9a-f]{8})\)$/.exec(row.error!)?.[1];
    expect(ref, row.error ?? "no error").toBeTruthy();

    const ops = lines
      .filter((l) => l.includes('"opslog"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.opslog === "saga_failed")!;
    // The same key on both sides: a founder's screenshot finds the journald line.
    expect(ops.ref).toBe(ref);
    // The operator's copy has what the sentence had to leave out…
    expect(ops.errorDetail).toContain("HTTP request failed.");
    expect(ops.errorDetail).toContain("https://arc-sepolia.example.com");
    // …and none of what neither may carry. journald is a lower bar than the browser, not a vault.
    expect(JSON.stringify(ops)).not.toContain("AbCdEf0123456789SECRET");
    expect(JSON.stringify(ops)).not.toContain("0x02f8b2abab");
    // The field is named `errorDetail` ON PURPOSE: opsLog's free-text redaction keys on
    // /error|message|reason|detail/i, so a field called `diagnostic` would skip redactPii.
    expect(Object.keys(ops)).toContain("errorDetail");
  } finally {
    spy.mockRestore();
  }
});

test("one ops line per swallowed failure, carrying the PUBLIC message only", async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const runner = new OnboardingRunner({
      repo,
      runSaga: async () => {
        throw new Error(SEPTEMBER_MESSAGE);
      },
      fundCaps: TEST_FUND_CAPS,
    });
    const bound = seedRecord({ idempotencyKey: `${TENANT}:FundOps`, status: "bound" });
    runner.fund({ id: bound.idempotencyKey, tenantId: TENANT, amount: usdToUnits("1") });
    await runner.settled();

    const ops = lines
      .filter((l) => l.includes('"opslog"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.opslog === "saga_failed");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      entity: bound.idempotencyKey,
      status: "bound",
      step: "fundTreasury",
    });
    expect(JSON.stringify(ops[0])).not.toContain("AbCdEf0123456789SECRET");
    expect(JSON.stringify(ops[0])).not.toContain("0x02f8b2abab");
  } finally {
    spy.mockRestore();
  }
});

test("start() records the guardian passkey's credentialId as root_passkey_id (v2.5 item 4)", () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: runSaga as never,
    fundCaps: TEST_FUND_CAPS,
  });
  const withId = {
    challenge: "c",
    attestation: { credentialId: "cred-abc123", clientDataJson: "", attestationObject: "" },
  } as never;
  const { id } = runner.start({ spec, userKey: "pk1", tenantId: TENANT, guardianPasskey: withId });
  expect(repo.findByIdempotencyKey(id)?.rootPasskeyId).toBe("cred-abc123");
});

test("start() with a passkey lacking credentialId stores null, not a crash", () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: runSaga as never,
    fundCaps: TEST_FUND_CAPS,
  });
  const { id } = runner.start({ spec, userKey: "pk2", tenantId: TENANT, guardianPasskey: passkey });
  expect(repo.findByIdempotencyKey(id)?.rootPasskeyId ?? null).toBeNull();
});

test("fund() refuses when the S5 platform outflow ceiling is reached (after per-tenant checks)", async () => {
  let checked = 0n;
  const runner = new OnboardingRunner({
    repo,
    runSaga: runSaga as never,
    fundCaps: TEST_FUND_CAPS,
    outflows: {
      check(amount: bigint) {
        checked = amount;
        throw new Error("platform-outflow-ceiling");
      },
    },
  });
  const { id } = runner.start({ spec, userKey: "s5", tenantId: TENANT, guardianPasskey: passkey });
  await runner.settled(); // let the start saga finish so the entity is no longer in-flight
  const rec = repo.findByIdempotencyKey(id)!;
  repo.upsert({ ...rec, status: "bound" });
  expect(() => runner.fund({ id, tenantId: TENANT, amount: 1_000n })).toThrow(
    /platform outflow ceiling/,
  );
  expect(checked).toBe(1_000n); // the meter really saw the amount
});

// ── Formation pinning at the claim (design §2, review C1) ───────────────────────────────────

/** A parties repository over the test db, plus one unbound party belonging to TENANT. */
function partyFixture() {
  const parties = new SqliteFormationPartyRepository(db);
  const companies = new SqliteCompanyRepository(db);
  const requests = new SqliteFormationRepository(db);
  const partyId = parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
  return { parties, partyId, companies, requests };
}

/**
 * The runner's formation wiring after A3 (design §3/§7).
 *
 * There is no shim any more: a company is minted at its own door and this fixture only ever
 * ATTACHES to one. `newCompany` is what the composition root's `POST /companies` does, called
 * directly so these tests exercise the claim rather than the create.
 */
function formationDeps(
  fx: ReturnType<typeof partyFixture>,
  pin: { provider: string; environment: "sandbox" | "production" } | null,
) {
  if (!pin) return undefined;
  return { companies: fx.companies, requests: fx.requests, maxAgentsPerCompany: 10 };
}

/** A company the tenant owns, through the ONE domain function every real door calls. */
function newCompany(
  fx: ReturnType<typeof partyFixture>,
  pin: { provider: string; environment: "sandbox" | "production" },
  partyId = fx.partyId,
): string {
  const result = createCompany(
    {
      companies: fx.companies,
      parties: fx.parties,
      requests: fx.requests,
      pin,
      sandboxSyntheticPii: false,
      maxPerTenant: 3,
      dailyCeiling: 10,
      transaction: (fn) => fn(),
    },
    TENANT,
    {
      partyId,
      names: ["Demo Alpha LLC", "Demo Beta LLC", "Demo Gamma LLC"],
      businessPurpose: "An autonomous software agent.",
      industryLabel: "Software development",
    },
  );
  if ("error" in result) throw new Error(result.error);
  return result.companyId;
}

const doolaCfg = (over: Record<string, string> = {}) =>
  loadConfig({ ...CFG_BASE, DOOLA_API_KEY: "dk", DOOLA_WEBHOOK_SECRET: "whsec", ...over });

test("A3: an attaching claim pins FROM THE COMPANY ROW, never from config", () => {
  // Replaces the A1 shim's own test. The shim minted a company inside the claim; A3 removed it,
  // so the claim's whole formation job is: re-read the company, copy its pin, attach.
  const fx = partyFixture();
  const pin = resolveFormationDeployment(doolaCfg())!;
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, pin),
  });
  const companyId = newCompany(fx, pin);
  const { id } = runner.start({
    spec,
    userKey: "pin-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId,
  });
  const rec = repo.findByIdempotencyKey(id)!;
  expect(rec.companyId).toBe(companyId);
  expect(rec.formationProvider).toBe("doola");
  expect(rec.formationEnvironment).toBe("sandbox");
  // The bind happened at the CREATE door, not here — but it is still one fact: an entity that
  // owes a filing always has an identity behind it.
  expect(fx.parties.findByCompanyId(companyId)?.partyId).toBe(fx.partyId);
  const company = fx.companies.find(companyId)!;
  expect(company.status).toBe("ready");
  // A HUMAN typed this intake. `intake_synthesized` survives only on rows the migration wrote.
  expect(company.intakeSynthesized).toBe(false);
});

test("A3: the claim no longer takes a partyId at all — the shim's door is gone", () => {
  // The type says so, and this asserts the RUNTIME shape behind it: a caller who somehow reaches
  // `start` with a party handle gets an unpinned stub rather than a silently minted company.
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, resolveFormationDeployment(doolaCfg())),
  });
  const { id } = runner.start({
    spec,
    userKey: "no-shim",
    tenantId: TENANT,
    guardianPasskey: passkey,
    ...({ partyId: fx.partyId } as unknown as Record<string, never>),
  });
  const rec = repo.findByIdempotencyKey(id)!;
  expect(rec.companyId).toBeNull();
  expect(rec.formationProvider).toBeNull();
  // …and the party is untouched, free for a real company at the door that mints one.
  expect(fx.parties.findOwned(TENANT, fx.partyId)?.companyId).toBeNull();
});

test("ATTACH: a second agent joins an existing company, and the party is NOT reused", () => {
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, resolveFormationDeployment(doolaCfg())),
  });
  const companyId = newCompany(fx, resolveFormationDeployment(doolaCfg())!);
  runner.start({
    spec,
    userKey: "attach-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId,
  });

  const second = runner.start({
    spec,
    userKey: "attach-2",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId,
  });
  const rec = repo.findByIdempotencyKey(second.id)!;
  expect(rec.companyId).toBe(companyId);
  // Billing is per COMPANY: attaching is free, so no second party and no second filing.
  expect(fx.companies.countAgents(companyId)).toBe(2);
  expect(fx.requests.stepsOf(companyId)).toHaveLength(0);
});

test("ATTACH records what the agent JOINED — an agent attached after the filing has a history", () => {
  // The sub-saga fans its events out over whichever agents are attached AT THE MOMENT a fact
  // lands. An agent that joins afterwards — which is the entire point of N:1 — was attached to a
  // real, filed Wyoming LLC and had a completely empty formation history, because every event
  // describing that filing had already been written.
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, resolveFormationDeployment(doolaCfg())),
  });
  const companyId = newCompany(fx, resolveFormationDeployment(doolaCfg())!);
  const first = runner.start({
    spec,
    userKey: "hist-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId,
  });
  // The filing happens BEFORE the second agent exists.
  fx.requests.claimAllSteps(companyId);
  fx.requests.transition(companyId, "create_provider", "pending", "confirmed", {
    providerRef: "cmp-live-1",
  });
  fx.requests.transition(companyId, "await_filing", "pending", "confirmed");
  fx.companies.recordFilingFacts(companyId, { filedAt: 1_756_000_000, filingNumber: "WY-2026-1" });
  fx.companies.recordEin(companyId, "88-1234567");

  const second = runner.start({
    spec,
    userKey: "hist-2",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId,
  });

  // EVERY attach records one now, because every attach IS a join: the first agent joined a
  // company that already existed, before it had been filed, so its row is the honest `none`.
  // (Under A1's shim the first agent CREATED its company inside the claim and a
  // `formationAttached` there would have been a spurious row on every client that existed.)
  const firstEvents = repo.listEvents(first.id).filter((e) => e.step === "formationAttached");
  expect(firstEvents).toHaveLength(1);
  expect(JSON.parse(firstEvents[0]!.detail!)).toMatchObject({
    companyId,
    status: "none",
    ein: false,
  });

  const events = repo.listEvents(second.id).filter((e) => e.step === "formationAttached");
  expect(events).toHaveLength(1);
  const detail = JSON.parse(events[0]!.detail!);
  expect(detail).toMatchObject({
    companyId,
    provider: "doola",
    environment: "sandbox",
    status: "filed",
    providerRef: "cmp-live-1",
    filedAt: 1_756_000_000,
    filingNumber: "WY-2026-1",
    // PRESENCE only. An EIN is a tax identifier and the audit trail is the one place the
    // processor deliberately keeps it out of.
    ein: true,
  });
  expect(JSON.stringify(detail)).not.toContain("88-1234567");
});

test("ATTACH is bounded: FORMATION_MAX_AGENTS_PER_COMPANY refuses inside the claim", () => {
  const fx = partyFixture();
  const deps = formationDeps(fx, resolveFormationDeployment(doolaCfg()))!;
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: { ...deps, maxAgentsPerCompany: 1 },
  });
  const companyId = newCompany(fx, resolveFormationDeployment(doolaCfg())!);
  runner.start({
    spec,
    userKey: "cap-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId,
  });
  expect(() =>
    runner.start({
      spec,
      userKey: "cap-2",
      tenantId: TENANT,
      guardianPasskey: passkey,
      companyId,
    }),
  ).toThrow(/agent\(s\) attached/);
  // The whole claim rolled back: no entity, and the count is unchanged.
  expect(repo.findByIdempotencyKey(`${TENANT}:cap-2`)).toBeUndefined();
  expect(fx.companies.countAgents(companyId)).toBe(1);
});

test("ATTACH refuses an ABANDONED company — the CAS re-reads it inside the transaction", () => {
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, resolveFormationDeployment(doolaCfg())),
  });
  const companyId = newCompany(fx, resolveFormationDeployment(doolaCfg())!);
  runner.start({
    spec,
    userKey: "cas-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId,
  });
  // The race the door check cannot close: the company is abandoned between the door and here.
  fx.companies.setStatus(companyId, "ready", "abandoned");
  expect(() =>
    runner.start({
      spec,
      userKey: "cas-2",
      tenantId: TENANT,
      guardianPasskey: passkey,
      companyId,
    }),
  ).toThrow(/not available for attachment/);
  expect(repo.findByIdempotencyKey(`${TENANT}:cas-2`)).toBeUndefined();
});

test("C5: no party and no company pins NOTHING, even with the credentials present", () => {
  // The wizard's shape today. The door is what refuses a handle-less onboard where formation is
  // mandatory; the CLAIM's job is only to never pin an entity it cannot file for.
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, resolveFormationDeployment(doolaCfg())),
  });
  const { id } = runner.start({
    spec,
    userKey: "pin-2",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  const rec = repo.findByIdempotencyKey(id)!;
  expect(rec.formationProvider).toBeNull();
  expect(rec.formationEnvironment).toBeNull();
});

test("C5: FORMATION_REQUIRED=false still pins an onboard that CARRIES a company", () => {
  // ⚠ Supersedes PR 2 decision #2, restated at company scope. `required` decides whether the door
  // refuses a handle-less onboard — it does NOT decide whether a supplied handle is honoured.
  // Dropping one silently was the bug: a caller who had paid for a legal body, handed over its
  // handle, and got a stub.
  const fx = partyFixture();
  const pin = resolveFormationDeployment(doolaCfg({ FORMATION_REQUIRED: "false" }))!;
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, pin),
  });
  const { id } = runner.start({
    spec,
    userKey: "pin-4",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId: newCompany(fx, pin),
  });
  const rec = repo.findByIdempotencyKey(id)!;
  expect(rec.formationProvider).toBe("doola");
  expect(rec.formationEnvironment).toBe("sandbox");
});

test("C1: a credential-less deployment pins nothing — the stub shape, unchanged", () => {
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, resolveFormationDeployment(loadConfig(CFG_BASE))),
  });
  // A company id from a box that HAD credentials, arriving at one that does not. There is no
  // formation block to attach through, so the row is a stub — the door refuses this combination
  // up front (`formationUnavailableMessage`); this is what the claim does if it gets past it.
  const { id } = runner.start({
    spec,
    userKey: "pin-3",
    tenantId: TENANT,
    guardianPasskey: passkey,
    companyId: "company-from-another-box",
  });
  expect(repo.findByIdempotencyKey(id)?.companyId).toBeNull();
  expect(repo.findByIdempotencyKey(id)?.formationProvider).toBeNull();
  expect(fx.parties.findOwned(TENANT, fx.partyId)?.companyId).toBeNull();
});

test("A3: `company_attach` carries the count BEFORE the attach — reuse is a query over it", () => {
  // §7 names two events, `company_attach` and `company_reused`, and the second was written as a
  // line whose only difference from the first was that it fired when `agents > 0`: same ids, same
  // number, same attach. So there is ONE line and the fan-out question is a query over it —
  // `company_attach agents>0` is the N:1 sharing actually happening, which is what bounds the
  // anchor traffic (agents × late facts × two sponsored writes) and what makes two agents
  // publicly linkable through their manifests.
  //
  // The property that makes the query answerable is asserted here: `agents` is the count BEFORE
  // this attach, so the FIRST agent on a company reads 0 and the second reads 1.
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const fx = partyFixture();
    const pin = resolveFormationDeployment(doolaCfg())!;
    const runner = new OnboardingRunner({
      repo,
      runSaga,
      fundCaps: TEST_FUND_CAPS,
      formation: formationDeps(fx, pin),
    });
    const companyId = newCompany(fx, pin);

    runner.start({
      spec,
      userKey: "reuse-1",
      tenantId: TENANT,
      guardianPasskey: passkey,
      companyId,
    });
    const ops = () =>
      lines
        .filter((l) => l.includes('"opslog"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ops().filter((l) => l.opslog === "company_attach")).toHaveLength(1);
    // …and the count it carries is the one BEFORE this attach, read in the same transaction as
    // the cap check: zero agents, so no reuse.
    expect(ops().find((l) => l.opslog === "company_attach")).toMatchObject({
      companyId,
      agents: 0,
    });
    // …and no second line saying the same thing: one attach, one event.
    expect(ops().filter((l) => l.opslog === "company_reused")).toHaveLength(0);

    runner.start({
      spec,
      userKey: "reuse-2",
      tenantId: TENANT,
      guardianPasskey: passkey,
      companyId,
    });
    const attaches = ops().filter((l) => l.opslog === "company_attach");
    expect(attaches).toHaveLength(2);
    // The SECOND attach is the reuse, and it says so with a number rather than with an event.
    expect(attaches[1]).toMatchObject({ companyId, entityKey: `${TENANT}:reuse-2`, agents: 1 });
    expect(ops().filter((l) => l.opslog === "company_reused")).toHaveLength(0);
    // Ids only: a company id is an opaque handle, and nothing about the party behind it belongs
    // in a log line.
    expect(JSON.stringify(attaches[1])).not.toMatch(/Ada|Lovelace|@example/);
  } finally {
    spy.mockRestore();
  }
});
