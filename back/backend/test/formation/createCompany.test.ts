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
  businessPurposeRequiredMessage,
  businessPurposeTooLongMessage,
  companyNameBlankMessage,
  companyNameCharsetMessage,
  companyNameDuplicateMessage,
  companyNameEndingOnlyMessage,
  companyNameRestrictedMessage,
  companyNameTooLongMessage,
  companyNamesRequiredMessage,
  formationCeilingReachedMessage,
  formationPartyUnavailableMessage,
  formationQuotaExhaustedMessage,
  industryLabelRequiredMessage,
  industryLabelUnknownMessage,
  sqliteUtcTimestamp,
  ssnFormatMessage,
  ssnRefusedHereMessage,
  ssnUnavailableMessage,
  syntheticPiiRefusedMessage,
  syntheticPiiRequiredMessage,
} from "../../src/formation";
import { type CreateCompanyDeps, createCompany } from "../../src/formation/company";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_INDUSTRY,
  NAME_MAX_LENGTH,
  PURPOSE_MAX_LENGTH,
} from "../../src/formation/intake";
import { decryptSsn, parsePiiKey } from "../../src/formation/pii";
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

const SSN = "123-45-6789";
const RING = { current: parsePiiKey(Buffer.alloc(32, 4).toString("base64"), "FORMATION_PII_KEY") };

/**
 * A PRODUCTION deployment: the only one that may be handed an SSN (§4.1), and therefore the only
 * one carrying a keyring. `deps()` above stays sandbox, so every test that does not say
 * "production" is exercising the deployment that must REFUSE the field.
 */
function prodDeps(over: Partial<CreateCompanyDeps> = {}): CreateCompanyDeps {
  return deps({ pin: { provider: "doola", environment: "production" }, pii: RING, ...over });
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

/**
 * The PRODUCTION intake (A2 §5) — what REST and MCP send. Three ranked candidates, the company's
 * own purpose, a listed industry.
 */
const intake = (partyId: string, over: Record<string, unknown> = {}) => ({
  partyId,
  names: ["Acme Robotics LLC", "Acme Automata", "Acme Mechanicals"],
  businessPurpose: "Operating autonomous software agents.",
  industryLabel: DEFAULT_INDUSTRY,
  ...over,
});

/** A second, distinct set of candidates, for the tests that mint twice. */
const SECOND_NAMES = ["Beta Works", "Beta Systems", "Beta Foundry"];

/** The A1 SHIM's intake, which is the ONLY caller that may derive a name (§10). */
const shimIntake = (partyId: string, over: Record<string, unknown> = {}) => ({
  partyId,
  synthesizedName: "Acme Robotics LLC",
  ...over,
});

// ── the happy path ─────────────────────────────────────────────────────────────────────────

test("A2 mints a READY company from the REAL intake, in the canonical shape", () => {
  const partyId = newParty();
  const result = createCompany(deps(), TENANT, intake(partyId));
  expect("companyId" in result).toBe(true);
  const company = companies.find((result as { companyId: string }).companyId)!;

  // `ready`, never `draft`: payment is off in A1/A2, so a draft would owe a step that does not
  // exist and would never be filed.
  expect(company.status).toBe("ready");
  // A HUMAN typed this one.
  expect(company.intakeSynthesized).toBe(false);
  // ONE canonical shape, three positions, with the entity ending split off — "Acme Robotics LLC"
  // must not be filed as "Acme Robotics LLC LLC".
  expect(company.nameOptions).toEqual([
    { name: "Acme Robotics", entityTypeEnding: "LLC", position: 1 },
    { name: "Acme Automata", entityTypeEnding: "LLC", position: 2 },
    { name: "Acme Mechanicals", entityTypeEnding: "LLC", position: 3 },
  ]);
  // The company's OWN purpose, not the agent's description and not the default.
  expect(company.businessPurpose).toBe("Operating autonomous software agents.");
  expect(company.industryLabel).toBe(DEFAULT_INDUSTRY);
  // The pin comes from the DEPLOYMENT and is copied onto every agent that attaches later.
  expect([company.provider, company.environment]).toEqual(["doola", "sandbox"]);
  // …and the party is SPENT: bound to this company, inside the same transaction.
  expect(parties.findOwned(TENANT, partyId)!.companyId).toBe(company.companyId);
});

test("the A1 SHIM still mints its 1:1 synthesized company — every existing client keeps working", () => {
  // §10: the synthesized path survives A2 for the shim ALONE, and is removed in A3. It is spelled
  // `synthesizedName` rather than `name` precisely so a production door cannot reach it.
  const result = createCompany(deps(), TENANT, shimIntake(newParty()));
  const company = companies.find((result as { companyId: string }).companyId)!;
  expect(company.intakeSynthesized).toBe(true);
  expect(company.nameOptions).toEqual([
    { name: "Acme Robotics", entityTypeEnding: "LLC", position: 1 },
  ]);
  expect(company.businessPurpose).toBe(DEFAULT_DESCRIPTION);
  expect(company.industryLabel).toBe(DEFAULT_INDUSTRY);
});

test("the production doors REQUIRE the full shape — no defaults, no single name", () => {
  // A door that could fall back to a derived name is a door that files a company nobody
  // described, under a purpose nobody wrote.
  expect(createCompany(deps(), TENANT, intake(newParty(), { names: undefined }))).toEqual({
    error: companyNamesRequiredMessage(),
  });
  expect(createCompany(deps(), TENANT, intake(newParty(), { businessPurpose: undefined }))).toEqual(
    { error: businessPurposeRequiredMessage() },
  );
  expect(createCompany(deps(), TENANT, intake(newParty(), { industryLabel: undefined }))).toEqual({
    error: industryLabelRequiredMessage(),
  });
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
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
  const second = createCompany(deps(), TENANT, intake(partyId, { names: SECOND_NAMES }));
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

// ── intake validation (A2 §5) ──────────────────────────────────────────────────────────────
//
// Every refusal NAMES the field and, where there is one, the offending value. That is the design
// of them: the alternative is a caller who cannot proceed and cannot tell why, on a form whose
// next step spends real money.

test("names must be EXACTLY three — not one, not two, not four", () => {
  // Wyoming refuses a name that is already taken, and a second attempt is a second fee. The
  // alternates are what let one filing succeed.
  for (const names of [[], ["One"], ["One", "Two"], ["One", "Two", "Three", "Four"]])
    expect(createCompany(deps(), TENANT, intake(newParty(), { names })), String(names)).toEqual({
      error: companyNamesRequiredMessage(),
    });
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
});

test("each candidate is checked in POSITION order, and the message names the position", () => {
  const at = (i: number, value: unknown) => {
    const names = ["Alpha Works", "Beta Works", "Gamma Works"];
    names[i] = value as string;
    return intake(newParty(), { names });
  };
  expect(createCompany(deps(), TENANT, at(1, "   "))).toEqual({
    error: companyNameBlankMessage(2),
  });
  expect(createCompany(deps(), TENANT, at(2, "x".repeat(200)))).toEqual({
    error: companyNameTooLongMessage(3, NAME_MAX_LENGTH),
  });
  // The ending is a separate field on the wire; a candidate that is nothing else has no name.
  for (const ending of ["LLC", " L.L.C. ", "llc", ",llc"])
    expect(createCompany(deps(), TENANT, at(0, ending)), ending).toEqual({
      error: companyNameEndingOnlyMessage(1),
    });
});

test("the charset refusal NAMES the character, so the caller can act on it", () => {
  // "invalid characters" on a form is not something anyone can act on.
  const withChar = (ch: string) =>
    intake(newParty(), { names: [`Acme${ch}Works`, "Beta Works", "Gamma Works"] });
  expect(createCompany(deps(), TENANT, withChar("™"))).toEqual({
    error: companyNameCharsetMessage(1, "™"),
  });
  // Accented letters are out too: the Secretary of State's standard is English letters, and a
  // canonicalized "Café" would be FILED as typed.
  expect(createCompany(deps(), TENANT, withChar("é"))).toEqual({
    error: companyNameCharsetMessage(1, "é"),
  });
  // …while the punctuation Wyoming does accept passes.
  const ok = createCompany(
    deps(),
    TENANT,
    intake(newParty(), { names: ["Acme & Co.", "Beta-Works, Inc", "Gamma (Works) +1"] }),
  );
  expect("companyId" in ok).toBe(true);
});

test("a Wyoming RESTRICTED word is refused at the door, before the fee", () => {
  // It would come back `rejected` after the filing fee was paid, and park the company.
  expect(
    createCompany(
      deps(),
      TENANT,
      intake(newParty(), { names: ["Acme Bank", "Beta Works", "Gamma Works"] }),
    ),
  ).toEqual({ error: companyNameRestrictedMessage(1, "bank") });
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
});

test("DUPLICATE candidates are refused, in the form Wyoming would compare them", () => {
  // Three candidates that are really one leave the filing with no fallback at all — which is the
  // entire reason three are demanded.
  for (const names of [
    ["Acme Works", "Acme Works", "Gamma Works"],
    ["Acme Works", "acme  works", "Gamma Works"], // case + whitespace
    ["Acme Works", "Acme Works LLC", "Gamma Works"], // …and the entity ending
  ])
    expect(createCompany(deps(), TENANT, intake(newParty(), { names })), String(names)).toEqual({
      error: companyNameDuplicateMessage(2),
    });
});

test("purpose and industry are required, bounded, and the industry must be a LISTED label", () => {
  expect(createCompany(deps(), TENANT, intake(newParty(), { businessPurpose: "  " }))).toEqual({
    error: businessPurposeRequiredMessage(),
  });
  expect(
    createCompany(deps(), TENANT, intake(newParty(), { businessPurpose: "x".repeat(600) })),
  ).toEqual({ error: businessPurposeTooLongMessage(PURPOSE_MAX_LENGTH) });
  // An unlisted label reaches doola and comes back rejected on a real fee.
  expect(
    createCompany(deps(), TENANT, intake(newParty(), { industryLabel: "Interpretive Dance" })),
  ).toEqual({ error: industryLabelUnknownMessage("Interpretive Dance") });
});

test("values are CANONICALIZED (NFC + trim) at intake and stored canonical", () => {
  // Two spellings of one string must not become two candidates, and the stored value is the value
  // SENT — the filer forwards `name_options` verbatim and the §5 matcher compares against them.
  const decomposed = "AcmeÅ"; // "AcmeÅ" as A + combining ring
  const result = createCompany(
    deps(),
    TENANT,
    intake(newParty(), {
      names: ["  Acme Works  ", "Beta Works", "Gamma Works"],
      businessPurpose: "  Building agents.  ",
      industryLabel: `  ${DEFAULT_INDUSTRY}  `,
    }),
  );
  const company = companies.find((result as { companyId: string }).companyId)!;
  expect(company.nameOptions[0]!.name).toBe("Acme Works");
  expect(company.businessPurpose).toBe("Building agents.");
  expect(company.industryLabel).toBe(DEFAULT_INDUSTRY);
  // NFC composes the decomposed form — and the composed result then fails the ASCII charset,
  // which is the deliberate narrow rule, not an accident of ordering.
  expect(
    createCompany(
      deps(),
      TENANT,
      intake(newParty(), { names: [decomposed, "B Works", "C Works"] }),
    ),
  ).toEqual({ error: companyNameCharsetMessage(1, "Å") });
});

// ── THE SSN (§4.1/§4.2) ────────────────────────────────────────────────────────────────────

test("a production REST create takes an SSN, encrypts it, and stores it in the SAME transaction", () => {
  const partyId = newParty();
  const result = createCompany(prodDeps(), TENANT, intake(partyId, { ssn: SSN }));
  const companyId = (result as { companyId: string }).companyId;

  const stored = parties.findSsnByCompanyId(companyId)!;
  expect(stored.partyId).toBe(partyId);
  expect(stored.keyId).toBe(RING.current.id);
  // Sealed under the (party, company) AAD — which is why it had to ride THIS request: the
  // company id did not exist a moment earlier.
  expect(decryptSsn(RING, stored, { partyId, companyId })).toBe(SSN);
  // Not in the row in clear, anywhere.
  const raw = JSON.stringify(
    db.prepare("SELECT * FROM formation_parties WHERE party_id = ?").get(partyId),
  );
  expect(raw).not.toContain(SSN);
  expect(raw).not.toContain("123456789");
});

test("the SSN is OPTIONAL — a non-US applicant files without one", () => {
  const result = createCompany(prodDeps(), TENANT, intake(newParty()));
  expect("companyId" in result).toBe(true);
  expect(parties.findSsnByCompanyId((result as { companyId: string }).companyId)).toBeUndefined();
});

test("a SANDBOX or SYNTHETIC deployment REFUSES the field outright — never ignores it", () => {
  // Quietly dropping it leaves a caller believing they supplied one; quietly accepting it puts a
  // real person's SSN in a partner's DEVELOPMENT environment.
  expect(createCompany(deps(), TENANT, intake(newParty(), { ssn: SSN }))).toEqual({
    error: ssnRefusedHereMessage(),
  });
  expect(
    createCompany(
      prodDeps({ sandboxSyntheticPii: true }),
      TENANT,
      intake(newParty({ synthetic: true }), { ssn: SSN, synthetic: true }),
    ),
  ).toEqual({ error: ssnRefusedHereMessage() });
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
});

test("a malformed SSN is a SPECIFIC refusal, and nothing is minted", () => {
  for (const bad of ["123456789", "123-45-678", "abc-de-fghi", ""])
    expect(createCompany(prodDeps(), TENANT, intake(newParty(), { ssn: bad })), bad).toEqual({
      error: ssnFormatMessage(),
    });
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
});

test("no keyring means REFUSE, never a plaintext write", () => {
  // Unreachable on a correctly-booted production box (FORMATION_PII_KEY is a boot invariant); it
  // exists so a misconfiguration is a refusal rather than an SSN in the clear.
  expect(
    createCompany(prodDeps({ pii: undefined }), TENANT, intake(newParty(), { ssn: SSN })),
  ).toEqual({ error: ssnUnavailableMessage() });
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
});

test("a LOST bind CAS takes the SSN down with the company — one transaction", () => {
  const partyId = newParty();
  const losingParties: SqliteFormationPartyRepository = Object.create(parties);
  losingParties.bindToCompany = () => false;
  expect(
    createCompany(prodDeps({ parties: losingParties }), TENANT, intake(partyId, { ssn: SSN })),
  ).toEqual({ error: formationPartyUnavailableMessage() });
  expect((db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n).toBe(0);
  // An SSN that outlived the company row it was sealed against could never be decrypted again —
  // and would sit in the database with no filing to justify it.
  expect(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM formation_parties WHERE ssn_ciphertext IS NOT NULL")
        .get() as { n: number }
    ).n,
  ).toBe(0);
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
