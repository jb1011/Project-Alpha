/**
 * The formation door gate (design §2/§5) — ONE function, so REST /onboard and MCP onboard_agent
 * cannot disagree about the ORDER of the checks or the wording of a refusal.
 *
 * The spend controls are the money-facing half (audit H6): formation is $100–150 each in
 * production, so an exhausted quota or ceiling refuses BEFORE the entity is minted. An entity is
 * never left live with a mandatory formation that can never happen.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  formationCeilingReachedMessage,
  formationDoorRefusal,
  formationPartyRequiredMessage,
  formationPartyUnavailableMessage,
  formationQuotaExhaustedMessage,
  formationUnavailableMessage,
  sqliteUtcTimestamp,
} from "../../src/formation";
import { companyNameOptions } from "../../src/formation/intake";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";
const NOW = Date.parse("2026-08-21T12:00:00Z");

let db: DatabaseType.Database;
let parties: SqliteFormationPartyRepository;
let quota: SqliteFormationRepository;
let companies: SqliteCompanyRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  parties = new SqliteFormationPartyRepository(db);
  quota = new SqliteFormationRepository(db);
  companies = new SqliteCompanyRepository(db);
});
afterEach(() => db.close());

function newParty(tenantId = TENANT): string {
  return parties.create({
    tenantId,
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
}

function deps(
  over: {
    required?: boolean;
    maxPerTenant?: number;
    dailyCeiling?: number;
    maxAgentsPerCompany?: number;
  } = {},
) {
  return {
    formation: {
      required: over.required ?? true,
      maxPerTenant: over.maxPerTenant ?? 3,
      dailyCeiling: over.dailyCeiling ?? 10,
      maxAgentsPerCompany: over.maxAgentsPerCompany ?? 10,
      parties,
      requests: quota,
      companies,
    },
    now: () => NOW,
  };
}

/** A company the tenant owns, in whatever state the case under test needs. */
function newCompany(
  over: { tenantId?: string; status?: "draft" | "ready" | "abandoned"; companyId?: string } = {},
): string {
  return companies.create({
    companyId: over.companyId,
    tenantId: over.tenantId ?? TENANT,
    status: over.status ?? "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: companyNameOptions("Acme"),
    businessPurpose: "purpose",
    industryLabel: "Software development",
    intakeSynthesized: true,
  });
}

/** A past formation for `tenantId`: an entity row plus its create_provider row (what the quota
 *  actually counts — the join is how a per-tenant limit reaches rows keyed only by entity). */
function pastFormation(key: string, tenantId: string, atUtc = sqliteUtcTimestamp(NOW - 60_000)) {
  // The quota counts `create_provider` rows, which are keyed by COMPANY since the re-key — so a
  // past formation is a company with an opened filing, and the tenant join goes through it.
  newCompany({ tenantId, companyId: key });
  db.prepare(
    "INSERT INTO formation_requests (company_id, step, state, created_at) VALUES (?,?,?,?)",
  ).run(key, "create_provider", "confirmed", atUtc);
}

// ── availability ────────────────────────────────────────────────────────────────────────────

test("a deployment that forms nothing: no gate at all, but a partyId is REFUSED not ignored", () => {
  expect(formationDoorRefusal({}, { tenantId: TENANT })).toBeNull();
  // Silently dropping a legal identity the caller believed they were filing with is the worse
  // failure, so the absent-provider case has its own named message.
  expect(formationDoorRefusal({}, { tenantId: TENANT, partyId: "p" })).toBe(
    formationUnavailableMessage(),
  );
});

// ── the party gate: required / optional × present / missing / foreign / bound ────────────────

test("REQUIRED + no partyId → the single-sourced refusal", () => {
  expect(formationDoorRefusal(deps(), { tenantId: TENANT })).toBe(formationPartyRequiredMessage());
});

test("REQUIRED + a valid unbound party → allowed", () => {
  expect(formationDoorRefusal(deps(), { tenantId: TENANT, partyId: newParty() })).toBeNull();
});

test("NOT required + no partyId → allowed (formation is opt-in there)", () => {
  expect(formationDoorRefusal(deps({ required: false }), { tenantId: TENANT })).toBeNull();
});

test("NOT required + a valid party → allowed, and still ownership-checked", () => {
  const mine = newParty();
  const theirs = newParty(OTHER);
  const d = deps({ required: false });
  expect(formationDoorRefusal(d, { tenantId: TENANT, partyId: mine })).toBeNull();
  expect(formationDoorRefusal(d, { tenantId: TENANT, partyId: theirs })).toBe(
    formationPartyUnavailableMessage(),
  );
});

test("unknown, FOREIGN and already-BOUND parties are refused with the SAME message", () => {
  const foreign = newParty(OTHER);
  const bound = newParty();
  parties.bindToCompany(bound, newCompany(), TENANT);

  // One message for all three: distinguishing them turns the door into an existence oracle over
  // another tenant's party ids.
  for (const partyId of ["00000000-0000-4000-8000-000000000000", foreign, bound])
    expect(formationDoorRefusal(deps(), { tenantId: TENANT, partyId })).toBe(
      formationPartyUnavailableMessage(),
    );
});

// ── spend controls ──────────────────────────────────────────────────────────────────────────

test("the per-tenant LIFETIME quota refuses before the entity is minted", () => {
  pastFormation("k1", TENANT);
  pastFormation("k2", TENANT);
  expect(
    formationDoorRefusal(deps({ maxPerTenant: 3 }), { tenantId: TENANT, partyId: newParty() }),
  ).toBeNull();

  pastFormation("k3", TENANT);
  expect(
    formationDoorRefusal(deps({ maxPerTenant: 3 }), { tenantId: TENANT, partyId: newParty() }),
  ).toBe(formationQuotaExhaustedMessage(3));

  // …and it is PER TENANT: another tenant's three formations do not touch this one's quota.
  expect(
    formationDoorRefusal(deps({ maxPerTenant: 3 }), { tenantId: OTHER, partyId: newParty(OTHER) }),
  ).toBeNull();
});

test("the quota counts FAILED formations too — a failed create can already have cost a company", () => {
  newCompany({ companyId: "kf" });
  db.prepare("INSERT INTO formation_requests (company_id, step, state) VALUES ('kf',?,?)").run(
    "create_provider",
    "failed",
  );
  expect(
    formationDoorRefusal(deps({ maxPerTenant: 1 }), { tenantId: TENANT, partyId: newParty() }),
  ).toBe(formationQuotaExhaustedMessage(1));
});

test("the rolling 24h deployment ceiling counts ACROSS tenants and expires", () => {
  const d = deps({ dailyCeiling: 2, maxPerTenant: 99 });
  pastFormation("a", TENANT, sqliteUtcTimestamp(NOW - 3_600_000)); // 1h ago
  pastFormation("b", OTHER, sqliteUtcTimestamp(NOW - 3_600_000)); // another tenant, same window
  expect(formationDoorRefusal(d, { tenantId: TENANT, partyId: newParty() })).toBe(
    formationCeilingReachedMessage(2),
  );

  // A formation older than the window does not count: move both outside it.
  db.prepare("UPDATE formation_requests SET created_at = ?").run(
    sqliteUtcTimestamp(NOW - 25 * 3_600_000),
  );
  expect(formationDoorRefusal(d, { tenantId: TENANT, partyId: newParty() })).toBeNull();
});

test("ORDER: the party gate runs BEFORE the spend controls (most specific reason first)", () => {
  pastFormation("k1", TENANT);
  // Quota is exhausted AND the party is missing: the caller hears about the party, which is the
  // thing they can act on, and both surfaces hear the same one.
  expect(formationDoorRefusal(deps({ maxPerTenant: 1 }), { tenantId: TENANT })).toBe(
    formationPartyRequiredMessage(),
  );
});

test("C5: spend controls key on the PARTY, not on `required` — an opt-in filing costs the same", () => {
  // Supersedes PR 2 decision #2. A bound party is always pinned and always filed, so an opt-in
  // formation on a `required=false` box spends the same $100–150 as a mandatory one and must
  // count against the same limits. Keyed on `required`, that money was unmetered.
  pastFormation("k1", TENANT);
  pastFormation("k2", TENANT);
  pastFormation("k3", TENANT);
  expect(
    formationDoorRefusal(deps({ required: false, maxPerTenant: 1, dailyCeiling: 1 }), {
      tenantId: TENANT,
      partyId: newParty(),
    }),
  ).toMatch(/formation quota exhausted/);
});

test("C5: no party means no filing, so the controls do not run at all", () => {
  // The wizard's shape today: no partyId, nothing pinned, nothing filed, nothing spent — and
  // therefore nothing to refuse, however exhausted the quota is.
  pastFormation("k1", TENANT);
  pastFormation("k2", TENANT);
  expect(
    formationDoorRefusal(deps({ required: false, maxPerTenant: 1, dailyCeiling: 1 }), {
      tenantId: TENANT,
    }),
  ).toBeNull();
});
