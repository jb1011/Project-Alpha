/**
 * `createCompany` — the ONE domain function every company creation goes through (design §7).
 *
 * It is where the money is spent, so it is where the spend controls live: the per-tenant quota,
 * the platform daily ceiling, the World-ID personhood gate at COMPANY scope, the synthetic-PII
 * refusals and the party bind. Three doors call it — REST, MCP and the A1 shim — and the point of
 * this file is that none of them can disagree about what a company costs, because none of them
 * gets to decide.
 *
 * Everything refuses BEFORE a row is minted, and the mint itself is one transaction.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ApiError } from "../../src/api/errors";
import { type WorldIdDeps, buildWorldIdDeps } from "../../src/api/routes/worldId";
import { loadConfig } from "../../src/config/env";
import {
  formationCeilingReachedMessage,
  formationPartyUnavailableMessage,
  formationQuotaExhaustedMessage,
  sqliteUtcTimestamp,
  syntheticPiiRefusedMessage,
  syntheticPiiRequiredMessage,
} from "../../src/formation";
import { type CreateCompanyDeps, createCompany } from "../../src/formation/company";
import { DEFAULT_DESCRIPTION, DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { hasLivePayment } from "../../src/formation/status";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";
const NOW = Date.parse("2026-08-26T12:00:00Z");

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
});
afterEach(() => db.close());

function deps(over: Partial<CreateCompanyDeps> = {}): CreateCompanyDeps {
  return {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "sandbox" },
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
    transaction: (fn) => db.transaction(fn)(),
    now: () => NOW,
    ...over,
  };
}

function newParty(over: { tenantId?: string; synthetic?: boolean } = {}): string {
  return parties.create({
    tenantId: over.tenantId ?? TENANT,
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
    synthetic: over.synthetic ?? false,
  });
}

const intake = (partyId: string, over: Record<string, unknown> = {}) => ({
  partyId,
  name: "Acme Robotics LLC",
  ...over,
});

// ── the happy path ─────────────────────────────────────────────────────────────────────────

test("A1 mints a READY company with the SYNTHESIZED intake, in the canonical shape", () => {
  const partyId = newParty();
  const result = createCompany(deps(), TENANT, intake(partyId));
  expect("companyId" in result).toBe(true);
  const company = companies.find((result as { companyId: string }).companyId)!;

  // `ready`, never `draft`: payment is off in A1, so a draft would owe a step that does not exist
  // and would never be filed.
  expect(company.status).toBe("ready");
  expect(company.intakeSynthesized).toBe(true);
  // ONE canonical shape, with the entity ending split off — "Acme Robotics LLC" must not be
  // filed as "Acme Robotics LLC LLC".
  expect(company.nameOptions).toEqual([
    { name: "Acme Robotics", entityTypeEnding: "LLC", position: 1 },
  ]);
  expect(company.businessPurpose).toBe(DEFAULT_DESCRIPTION);
  expect(company.industryLabel).toBe(DEFAULT_INDUSTRY);
  // The pin comes from the DEPLOYMENT and is copied onto every agent that attaches later.
  expect([company.provider, company.environment]).toEqual(["doola", "sandbox"]);
  // …and the party is SPENT: bound to this company, inside the same transaction.
  expect(parties.findOwned(TENANT, partyId)!.companyId).toBe(company.companyId);
});

test("a LOST bind CAS rolls the company INSERT back — against a real transaction", () => {
  // The race step 3 cannot close: another request takes this party between the ownership check
  // and the CAS. Simulated at the ONE seam that produces it — a `bindToCompany` that loses —
  // with the real `companies` repository and the real better-sqlite3 transaction, because the
  // bug was precisely that better-sqlite3 commits a callback which merely RETURNS false.
  const partyId = newParty();
  // The real repository with ONE method overridden — prototype-delegating, so every other read
  // (the ownership check in step 3 above all) still goes to the real rows.
  const losingParties: SqliteFormationPartyRepository = Object.create(parties);
  losingParties.bindToCompany = () => false;
  const result = createCompany(deps({ parties: losingParties }), TENANT, intake(partyId));
  expect(result).toEqual({ error: formationPartyUnavailableMessage() });
  // Zero rows. An orphan here would count against the tenant's quota forever, be attachable, and
  // sit inside `listUnopened`'s reach with no party to file with.
  expect((db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n).toBe(0);
});

test("the party bind is a CAS: a second company cannot reuse one person's consent", () => {
  const partyId = newParty();
  expect("companyId" in createCompany(deps(), TENANT, intake(partyId))).toBe(true);
  const second = createCompany(deps(), TENANT, intake(partyId, { name: "Second" }));
  expect(second).toEqual({ error: formationPartyUnavailableMessage() });
  // And the rollback is complete: the refused create left NO company behind.
  expect(companies.listByTenant(TENANT)).toHaveLength(1);
});

test("a party belonging to another tenant is refused with the SAME message", () => {
  const theirs = newParty({ tenantId: OTHER });
  expect(createCompany(deps(), TENANT, intake(theirs))).toEqual({
    error: formationPartyUnavailableMessage(),
  });
  expect(createCompany(deps(), TENANT, intake("00000000-0000-4000-8000-000000000000"))).toEqual({
    error: formationPartyUnavailableMessage(),
  });
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
});

// ── the spend controls ─────────────────────────────────────────────────────────────────────

test("the per-tenant quota counts CHARGEABLE companies and refuses before a row is minted", () => {
  const d = deps({ maxPerTenant: 2 });
  expect("companyId" in createCompany(d, TENANT, intake(newParty()))).toBe(true);
  expect("companyId" in createCompany(d, TENANT, intake(newParty()))).toBe(true);
  expect(createCompany(d, TENANT, intake(newParty()))).toEqual({
    error: formationQuotaExhaustedMessage(2),
  });
  expect(companies.listByTenant(TENANT)).toHaveLength(2);
  // Another tenant is unaffected — the quota is per tenant, not per deployment.
  expect("companyId" in createCompany(d, OTHER, intake(newParty({ tenantId: OTHER })))).toBe(true);
});

test("a DRAFT company does not consume the quota — only spent or committed ones do", () => {
  // With payment on (B1) a company can sit in draft for days. Counting drafts would let an
  // abandoned form exhaust a real quota.
  companies.create({
    tenantId: TENANT,
    status: "draft",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: [],
    businessPurpose: "p",
    industryLabel: "i",
    intakeSynthesized: true,
  });
  expect(companies.countChargeableByTenant(TENANT)).toBe(0);
  expect("companyId" in createCompany(deps({ maxPerTenant: 1 }), TENANT, intake(newParty()))).toBe(
    true,
  );
});

test("the platform DAILY ceiling counts create_provider rows, where the fee is incurred", () => {
  // A company row is not a fee. The `create_provider` row is: it is the request that costs money.
  for (const c of ["c1", "c2"]) {
    db.prepare(
      `INSERT INTO companies (company_id, tenant_id, status, provider, environment,
                              name_options, business_purpose, industry_label)
       VALUES (?, ?, 'ready', 'doola', 'sandbox', '[]', 'p', 'i')`,
    ).run(c, OTHER);
    db.prepare(
      "INSERT INTO formation_requests (company_id, step, state, created_at) VALUES (?,?,?,?)",
    ).run(c, "create_provider", "confirmed", sqliteUtcTimestamp(NOW - 60_000));
  }
  expect(createCompany(deps({ dailyCeiling: 2 }), TENANT, intake(newParty()))).toEqual({
    error: formationCeilingReachedMessage(2),
  });
  // …and it EXPIRES: a row from before the window does not count.
  db.prepare("UPDATE formation_requests SET created_at = ?").run(
    sqliteUtcTimestamp(NOW - 25 * 60 * 60 * 1000),
  );
  expect("companyId" in createCompany(deps({ dailyCeiling: 2 }), TENANT, intake(newParty()))).toBe(
    true,
  );
});

// ── the synthetic-PII refusals, in BOTH directions ─────────────────────────────────────────

test("a SANDBOX deployment refuses real intake, and a production one refuses synthetic", () => {
  // Never a substitution: quietly swapping in a fixture would leave the caller believing their
  // data had been filed, and quietly accepting `synthetic` in production would file a real
  // Wyoming LLC naming a person who does not exist.
  const sandbox = deps({ sandboxSyntheticPii: true });
  expect(createCompany(sandbox, TENANT, intake(newParty({ synthetic: true })))).toEqual({
    error: syntheticPiiRequiredMessage(),
  });
  expect(createCompany(deps(), TENANT, intake(newParty(), { synthetic: true }))).toEqual({
    error: syntheticPiiRefusedMessage(),
  });
});

test("`synthetic` is written from the DEPLOYMENT, never from the caller's claim", () => {
  const result = createCompany(
    deps({ sandboxSyntheticPii: true }),
    TENANT,
    intake(newParty({ synthetic: true }), { synthetic: true }),
  );
  const company = companies.find((result as { companyId: string }).companyId)!;
  expect(company.synthetic).toBe(true);
});

test("a party whose synthetic flag disagrees with the deployment is refused", () => {
  // The party was minted through the same gate, so a mismatch is a bug — but it would be a bug
  // that files the wrong KIND of company.
  expect(
    createCompany(
      deps({ sandboxSyntheticPii: true }),
      TENANT,
      intake(newParty(), {
        synthetic: true,
      }),
    ),
  ).toEqual({ error: syntheticPiiRequiredMessage() });
});

// ── intake validation ──────────────────────────────────────────────────────────────────────

test("a blank name and an over-long one are refused", () => {
  expect(createCompany(deps(), TENANT, intake(newParty(), { name: "   " }))).toEqual({
    error: "a company name is required",
  });
  expect(createCompany(deps(), TENANT, intake(newParty(), { name: "x".repeat(200) }))).toEqual({
    error: "a company name may be at most 120 characters",
  });
});

test("a name that is NOTHING BUT an entity ending is refused — the guard actually fires", () => {
  // `stripEntityEnding` used to anchor on `[\s,]+`, so a bare "LLC" never matched, and its
  // `|| raw.trim()` fallback handed the ending straight back as the name. The guard below was
  // therefore unreachable and Wyoming would have been asked to file "LLC LLC".
  for (const name of ["LLC", " L.L.C. ", "llc", ",llc"])
    expect(createCompany(deps(), TENANT, intake(newParty(), { name })), name).toEqual({
      error: "a company name must contain something other than an entity ending",
    });
  // …and a real name that merely ENDS in one still keeps its name.
  const ok = createCompany(deps(), TENANT, intake(newParty(), { name: "Acme Robotics L.L.C." }));
  expect(companies.find((ok as { companyId: string }).companyId)!.nameOptions).toEqual([
    { name: "Acme Robotics", entityTypeEnding: "LLC", position: 1 },
  ]);
  // Nothing was minted for any of the refused ones.
  expect(companies.listByTenant(TENANT)).toHaveLength(1);
});

// ── the identity floor (§6.7) ──────────────────────────────────────────────────────────────

function worldDeps(over: Partial<WorldIdDeps> = {}): WorldIdDeps {
  return {
    cfg: { appId: "app", rpId: "rp", rpSigningKey: "k", action: "guardian-verification" },
    attestMinAge: 18,
    store: new SqliteWorldStore(db),
    requireGuardian: true,
    ...over,
  } as WorldIdDeps;
}

test("POST /companies is gated on PERSONHOOD — an unverified guardian cannot buy an LLC", () => {
  const world = worldDeps();
  expect(() => createCompany(deps({ world }), TENANT, intake(newParty()))).toThrow(ApiError);
  expect(() => createCompany(deps({ world }), TENANT, intake(newParty()))).toThrow(
    /World ID verification/,
  );
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
});

test("the per-human ceiling counts COMPANIES, not agents — filings are the thing bounded", () => {
  const store = new SqliteWorldStore(db);
  store.recordVerification({
    nullifier: "null-1",
    action: "guardian-verification",
    tenantId: TENANT,
    credential: "orb",
    verifiedAt: NOW,
    issuerSchemaId: null,
    environment: "staging",
    expiresAtMin: null,
  });
  const world = worldDeps({ store, maxCompaniesPerHuman: 1 });
  expect("companyId" in createCompany(deps({ world }), TENANT, intake(newParty()))).toBe(true);
  expect(() => createCompany(deps({ world }), TENANT, intake(newParty()))).toThrow(
    /already controls 1 companies/,
  );
});

test("the COMPOSITION SEAM wires the company ceiling: config → deps → the door actually counts", () => {
  // The regression this exists for: `WORLD_MAX_COMPANIES_PER_HUMAN` parsed, the boot invariant
  // demanded it for production formation, `assertGuardianAllowed`'s company scope read it — and
  // `api/main.ts` built its `WorldIdDeps` literal WITHOUT it. Zero production callers, so a box
  // that believed it was bounded let one verified human buy unlimited Wyoming LLCs. Asserted
  // from `loadConfig` through the real builder, because a hand-written deps object in a test
  // proves only that the test wired it.
  const cfg = loadConfig({
    ARC_TESTNET_RPC_URL: "https://rpc.example",
    PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
    WORLD_APP_ID: "app_staging_1",
    WORLD_RP_ID: "app.example",
    WORLD_RP_SIGNING_KEY: "0xsigning",
    WORLD_REQUIRE_GUARDIAN: "true",
    WORLD_MAX_COMPANIES_PER_HUMAN: "2",
  });
  expect(cfg.world?.maxCompaniesPerHuman).toBe(2);

  const store = new SqliteWorldStore(db);
  store.recordVerification({
    nullifier: "null-seam",
    action: cfg.world!.action,
    tenantId: TENANT,
    credential: "orb",
    verifiedAt: NOW,
    issuerSchemaId: null,
    environment: "staging",
    expiresAtMin: null,
  });
  let counted = 0;
  const spy: SqliteWorldStore = Object.create(store);
  spy.countCompaniesForNullifier = (n: string, a: string) => {
    counted++;
    return store.countCompaniesForNullifier(n, a);
  };

  const world = buildWorldIdDeps(cfg.world!, spy);
  expect(world.maxCompaniesPerHuman).toBe(2);
  expect("companyId" in createCompany(deps({ world }), TENANT, intake(newParty()))).toBe(true);
  // The ceiling was READ. Without it the company scope returns early and this stays 0.
  expect(counted).toBe(1);
});

test("an UNWIRED World block gates nothing — which is why production formation boot-fails", () => {
  // `assertGuardianAllowed` silently returns when `cfg.world` is undefined. That is the hole the
  // boot invariant closes; here it is, stated, so nobody mistakes it for a gate.
  expect("companyId" in createCompany(deps({ world: undefined }), TENANT, intake(newParty()))).toBe(
    true,
  );
});

// ── the derived paying predicate ───────────────────────────────────────────────────────────

test("hasLivePayment is FALSE until B1 writes a row, and true for a live quote only", () => {
  const id = (createCompany(deps(), TENANT, intake(newParty())) as { companyId: string }).companyId;
  expect(hasLivePayment(companies, id)).toBe(false);

  const quote = (status: string) =>
    db
      .prepare(
        `INSERT INTO formation_payments (payment_id, company_id, status, amount_usdc, nonce, valid_before)
         VALUES (?, ?, ?, '399000000', 'ff', 1)`,
      )
      .run(`pay-${status}`, id, status);

  quote("quoted");
  expect(hasLivePayment(companies, id)).toBe(true);
  // Terminal statuses are not live: a refund or an expired quote needs no second write anywhere,
  // which is the whole reason "paying" is derived rather than stored.
  db.prepare("UPDATE formation_payments SET status = 'refunded' WHERE company_id = ?").run(id);
  expect(hasLivePayment(companies, id)).toBe(false);
  // …and an absent reader answers false rather than throwing (the pre-B1 shape).
  expect(hasLivePayment(undefined, id)).toBe(false);
});
