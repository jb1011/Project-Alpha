import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";
import { resolveFormationDeployment } from "../../src/formation";
import { createCompany, shimCompanyIntake } from "../../src/formation/company";
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
 * The runner's formation wiring, with the A1 SHIM (design §10).
 *
 * A party-only onboard — every client that exists today — mints its own 1:1 company inside the
 * claim transaction and attaches the new agent to it. The shim calls the ONE domain function, so
 * this fixture is the composition root in miniature.
 */
function formationDeps(
  fx: ReturnType<typeof partyFixture>,
  pin: { provider: string; environment: "sandbox" | "production" } | null,
) {
  if (!pin) return undefined;
  return {
    companies: fx.companies,
    requests: fx.requests,
    maxAgentsPerCompany: 10,
    createCompanyForParty: (tenantId: string, intake: { partyId: string; name: string }) => {
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
        tenantId,
        // The SHARED mapping (A2): four copies of "what the shim sends" is four chances for it
        // to mean something different on one surface.
        shimCompanyIntake(intake, false),
      );
      if ("error" in result) throw new Error(result.error);
      return result.companyId;
    },
  };
}

const doolaCfg = (over: Record<string, string> = {}) =>
  loadConfig({ ...CFG_BASE, DOOLA_API_KEY: "dk", DOOLA_WEBHOOK_SECRET: "whsec", ...over });

test("C5/A1 shim: a party-only claim mints a company, attaches it, and pins FROM ITS ROW", () => {
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, resolveFormationDeployment(doolaCfg())),
  });
  const { id } = runner.start({
    spec,
    userKey: "pin-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    partyId: fx.partyId,
  });
  const rec = repo.findByIdempotencyKey(id)!;
  expect(rec.companyId).toBeTruthy();
  expect(rec.formationProvider).toBe("doola");
  expect(rec.formationEnvironment).toBe("sandbox");
  // Attach and bind are ONE fact: an entity that owes a filing always has an identity behind it.
  expect(fx.parties.findByCompanyId(rec.companyId!)?.partyId).toBe(fx.partyId);
  // The company landed `ready` with the SYNTHESIZED intake — never `draft`, which would owe a
  // payment step that does not exist in A1.
  const company = fx.companies.find(rec.companyId!)!;
  expect(company.status).toBe("ready");
  expect(company.intakeSynthesized).toBe(true);
});

test("ATTACH: a second agent joins an existing company, and the party is NOT reused", () => {
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(fx, resolveFormationDeployment(doolaCfg())),
  });
  const first = runner.start({
    spec,
    userKey: "attach-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    partyId: fx.partyId,
  });
  const companyId = repo.findByIdempotencyKey(first.id)!.companyId!;

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
  const first = runner.start({
    spec,
    userKey: "hist-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    partyId: fx.partyId,
  });
  const companyId = repo.findByIdempotencyKey(first.id)!.companyId!;
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

  // The SHIM path records nothing: the first agent did not JOIN a filing, it created the 1:1
  // company it is attached to, and there is no prior history for an event to describe. A
  // `formationAttached` there would be a spurious `status: "none"` row on every party-only
  // onboard — which is every client that exists today.
  expect(repo.listEvents(first.id).filter((e) => e.step === "formationAttached")).toHaveLength(0);

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
  const first = runner.start({
    spec,
    userKey: "cap-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    partyId: fx.partyId,
  });
  const companyId = repo.findByIdempotencyKey(first.id)!.companyId!;
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
  const first = runner.start({
    spec,
    userKey: "cas-1",
    tenantId: TENANT,
    guardianPasskey: passkey,
    partyId: fx.partyId,
  });
  const companyId = repo.findByIdempotencyKey(first.id)!.companyId!;
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

test("C5: FORMATION_REQUIRED=false still pins and files an onboard that CARRIES a party", () => {
  // ⚠ Supersedes PR 2 decision #2. `required` decides whether the door refuses a handle-less
  // onboard — it does NOT decide whether a supplied party is honoured. Dropping one silently was
  // the bug: a caller posted a real legal identity, handed over its handle, and got a stub.
  const fx = partyFixture();
  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: TEST_FUND_CAPS,
    formation: formationDeps(
      fx,
      resolveFormationDeployment(doolaCfg({ FORMATION_REQUIRED: "false" })),
    ),
  });
  const { id } = runner.start({
    spec,
    userKey: "pin-4",
    tenantId: TENANT,
    guardianPasskey: passkey,
    partyId: fx.partyId,
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
  const { id } = runner.start({
    spec,
    userKey: "pin-3",
    tenantId: TENANT,
    guardianPasskey: passkey,
    partyId: fx.partyId,
  });
  // Even with a party: there is no provider to pin to, so no company is minted, the row is a stub
  // and the party stays UNBOUND — free for a real filing later. The door refuses this combination
  // up front (`formationUnavailableMessage`); this is what the claim does if it gets past it.
  expect(repo.findByIdempotencyKey(id)?.companyId).toBeNull();
  expect(repo.findByIdempotencyKey(id)?.formationProvider).toBeNull();
  expect(fx.parties.findOwned(TENANT, fx.partyId)?.companyId).toBeNull();
});
