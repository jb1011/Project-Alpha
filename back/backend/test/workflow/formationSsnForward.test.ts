/**
 * The SSN's life in the FILER (design 2026-08-26 §4.3/§4.4/§4.5).
 *
 * Three rules, each of which is a real double-filing or double-charging hazard if got wrong:
 *
 *  1. it is forwarded ONCE, as `responsibleParty.ssn`, and nowhere else in the body;
 *  2. it is DELETED in the same transaction that persists `provider_ref` — both on the create
 *     path and on the adopt path, idempotently;
 *  3. the body's SHAPE is FROZEN at first send. `ssnIncluded` and `expedited` are read back from
 *     `detail` for as long as the idempotency key is live, so an erasure can never make a
 *     same-key retry send a different body — and when the frozen body cannot be rebuilt, the step
 *     PARKS for a human rather than sending a different one or re-keying.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type DoolaApi, DoolaApiError } from "../../src/adapters/doola/doolaClient";
import type { CreateCompanyInput } from "../../src/adapters/doola/types";
import { createCompany } from "../../src/formation/company";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { type PiiKeyring, parsePiiKey } from "../../src/formation/pii";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import {
  type FormationRequestRecord,
  SqliteFormationRepository,
  parseDetail,
} from "../../src/persistence/formationRepository";
import {
  type CreateProviderDetail,
  runFormationCreateProvider,
} from "../../src/workflow/formationProvider";

const TENANT = "0x000000000000000000000000000000000000000A";
const SSN = "123-45-6789";
const KEY_A = Buffer.alloc(32, 11).toString("base64");
const KEY_B = Buffer.alloc(32, 22).toString("base64");
const RING: PiiKeyring = { current: parsePiiKey(KEY_A, "FORMATION_PII_KEY") };

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let repo: SqliteEntityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

function newParty(country = "USA"): string {
  return parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: country === "USA" ? "WY" : null,
    postalCode: "82001",
    country,
    synthetic: false,
  });
}

/** A production company, optionally carrying an SSN — minted through the real door. */
function mint(opts: { ssn?: string; country?: string } = {}): string {
  const result = createCompany(
    {
      companies,
      parties,
      requests,
      pin: { provider: "doola", environment: "production" },
      sandboxSyntheticPii: false,
      maxPerTenant: 10,
      dailyCeiling: 100,
      pii: RING,
      transaction: (fn) => db.transaction(fn)(),
    },
    TENANT,
    {
      partyId: newParty(opts.country),
      names: ["Acme Robotics", "Acme Automata", "Acme Mechanicals"],
      businessPurpose: "Operating autonomous software agents.",
      industryLabel: DEFAULT_INDUSTRY,
      ssn: opts.ssn,
    },
  );
  if ("error" in result) throw new Error(result.error);
  return result.companyId;
}

/** Records every create body, and answers however the test wants. */
function doola(over: Partial<DoolaApi> = {}): DoolaApi & { bodies: CreateCompanyInput[] } {
  const bodies: CreateCompanyInput[] = [];
  const api = {
    createCustomer: async () => ({ doolaCustomerId: "cus_1" }),
    createCompany: async (input: CreateCompanyInput) => {
      bodies.push(input);
      return { doolaCompanyId: "cmp_1", formationSubmissionStatus: "PENDING" };
    },
    getCompany: async () => ({ doolaCompanyId: "cmp_1", formationSubmissionStatus: "PENDING" }),
    listCompanies: async () => [],
    listDocuments: async () => [],
    getDocumentDownloadUrl: async () => ({ id: "d", downloadUrl: "https://x" }),
    listRequiredActions: async () => [],
    getComplianceCalendar: async () => [],
    listNaicsCodes: async () => [],
    playgroundCompleteFormation: async () => undefined,
    playgroundCompleteEin: async () => undefined,
    ...over,
    bodies,
  };
  return api as DoolaApi & { bodies: CreateCompanyInput[] };
}

function file(companyId: string, api: DoolaApi, pii: PiiKeyring | undefined = RING): Promise<void> {
  return runFormationCreateProvider({
    company: companies.find(companyId)!,
    companies,
    repo,
    requests,
    parties,
    doola: api,
    environment: "production",
    pii,
  });
}

const rowOf = (companyId: string): FormationRequestRecord =>
  requests.find(companyId, "create_provider")!;
const detailOf = (companyId: string): CreateProviderDetail =>
  parseDetail<CreateProviderDetail>(rowOf(companyId).detail);

// ── §4.3: forwarded ONCE ───────────────────────────────────────────────────────────────────

test("the SSN rides `responsibleParty.ssn` and NOTHING else in the body", async () => {
  const companyId = mint({ ssn: SSN });
  const api = doola();
  await file(companyId, api);

  const body = api.bodies[0]!;
  expect(body.responsibleParty.ssn).toBe(SSN);
  // `createCustomer` takes no SSN, and `members[].ssn` is never populated: doola derives
  // US-vs-non-US from any one person's, and the responsible party is the IRS-relevant one, so
  // sending it once is both sufficient and the minimum exposure (§4.3).
  for (const m of body.members) expect(m.ssn).toBeUndefined();
  expect(JSON.stringify(body).match(new RegExp(SSN, "g"))).toHaveLength(1);
});

test("no SSN means the key is ABSENT from the body, not present-and-undefined", async () => {
  const companyId = mint();
  const api = doola();
  await file(companyId, api);
  expect("ssn" in api.bodies[0]!.responsibleParty).toBe(false);
});

test("EXPEDITE is offered only to a non-US applicant with no SSN (§9)", async () => {
  // A US founder with an SSN takes the ordinary EIN route…
  const us = mint({ ssn: SSN });
  const usApi = doola();
  await file(us, usApi);
  expect(usApi.bodies[0]!.requestedServices).toBeUndefined();

  // …and a non-US applicant with none gets the expedited service.
  const fr = mint({ country: "FRA" });
  const frApi = doola();
  await file(fr, frApi);
  expect(frApi.bodies[0]!.requestedServices).toEqual([
    { service: "EinCreation", variant: "Expedite" },
  ]);
});

// ── §4.4: deleted with the provider_ref ────────────────────────────────────────────────────

test("the SSN dies in the transaction that persists `provider_ref`", async () => {
  const companyId = mint({ ssn: SSN });
  expect(parties.findSsnByCompanyId(companyId)).toBeDefined();

  await file(companyId, doola());
  expect(rowOf(companyId).providerRef).toBe("cmp_1");
  expect(parties.findSsnByCompanyId(companyId)).toBeUndefined();
  // The rest of the party survives: the SSN dies at the ref, the identity lives as long as the
  // filing does.
  const party = db
    .prepare("SELECT * FROM formation_parties WHERE company_id = ?")
    .get(companyId) as Record<string, unknown>;
  expect(party.legal_first_name).toBe("Ada");
  expect(party.ssn_deleted_at).toBeTruthy();
});

test("the ADOPT path erases too — a company found by the lookup, never created here", async () => {
  const companyId = mint({ ssn: SSN });
  // A previous attempt got past the customer create and lost the answer; the pre-create lookup
  // then finds the company. Nothing is created on this pass, but a `provider_ref` IS persisted.
  requests.claimAllSteps(companyId);
  requests.transition(companyId, "create_provider", "pending", "failed", {
    detail: JSON.stringify({ customerId: "cus_1" }),
    error: "lost",
  });
  const api = doola({
    listCompanies: async () => [{ doolaCompanyId: "cmp_adopted", name: "Acme Robotics LLC" }],
  });
  await file(companyId, api);

  expect(api.bodies).toHaveLength(0); // nothing was FILED
  expect(rowOf(companyId).providerRef).toBe("cmp_adopted");
  expect(parties.findSsnByCompanyId(companyId)).toBeUndefined();
});

test("the erasure is IDEMPOTENT — a second pass over a confirmed row changes nothing", async () => {
  const companyId = mint({ ssn: SSN });
  await file(companyId, doola());
  const before = rowOf(companyId).updatedAt;
  await file(companyId, doola());
  expect(parties.findSsnByCompanyId(companyId)).toBeUndefined();
  expect(rowOf(companyId).updatedAt).toBe(before);
});

// ── §4.5: the frozen body ──────────────────────────────────────────────────────────────────

test("`ssnIncluded` and `expedited` are FROZEN into detail at first send", async () => {
  const companyId = mint({ ssn: SSN });
  await file(companyId, doola());
  const detail = detailOf(companyId);
  expect(detail.ssnIncluded).toBe(true);
  expect(detail.expedited).toBe(false);
  expect(detail.companySentAttempt).toBe(0);
  // The VALUE is never in `detail` — the design's rule is about the number, and this is a
  // boolean about the shape of a request.
  expect(JSON.stringify(detail)).not.toContain(SSN);
});

test("a same-key RESUME rebuilds the SAME body from the frozen flags, not from the row", async () => {
  // The crash this exists for: the create COMMITTED at doola, we lost the answer, and the SSN was
  // erased by an operator (or a bug) before the retry. The retry must not send a body that
  // differs from the one the live key is bound to — doola answers a different body with a 409.
  const companyId = mint({ ssn: SSN });
  requests.claimAllSteps(companyId);
  requests.transition(companyId, "create_provider", "pending", "submitted", {
    // The shape a first send leaves behind: sent under THIS attempt, with an SSN.
    detail: JSON.stringify({ customerId: "cus_1", companySentAttempt: 0, ssnIncluded: true }),
  });
  // …and the SSN is gone.
  parties.eraseSsn(companyId);

  const api = doola();
  await file(companyId, api);

  // NOTHING was sent, and the attempt was NOT burned — so the key is not rotated and no second
  // Wyoming LLC can be filed. A human is told.
  expect(api.bodies).toHaveLength(0);
  const row = rowOf(companyId);
  expect(row.state).toBe("failed");
  expect(row.attempt).toBe(0);
  expect(row.error).toMatch(/can no longer be read/);
});

test("a LOST KEY parks the same way — the body cannot be rebuilt either", async () => {
  const companyId = mint({ ssn: SSN });
  requests.claimAllSteps(companyId);
  requests.transition(companyId, "create_provider", "pending", "submitted", {
    detail: JSON.stringify({ customerId: "cus_1", companySentAttempt: 0, ssnIncluded: true }),
  });

  const api = doola();
  // The box booted with a DIFFERENT key and no _PREVIOUS: the ciphertext is there and unreadable.
  await file(companyId, api, { current: parsePiiKey(KEY_B, "FORMATION_PII_KEY") });
  expect(api.bodies).toHaveLength(0);
  expect(rowOf(companyId).state).toBe("failed");
  expect(rowOf(companyId).attempt).toBe(0);
});

test("a PREVIOUS key opens a row written before a rotation — the resume just works", async () => {
  const companyId = mint({ ssn: SSN });
  requests.claimAllSteps(companyId);
  requests.transition(companyId, "create_provider", "pending", "submitted", {
    detail: JSON.stringify({ customerId: "cus_1", companySentAttempt: 0, ssnIncluded: true }),
  });

  const api = doola();
  await file(companyId, api, {
    current: parsePiiKey(KEY_B, "FORMATION_PII_KEY"),
    previous: parsePiiKey(KEY_A, "FORMATION_PII_KEY_PREVIOUS"),
  });
  expect(api.bodies[0]!.responsibleParty.ssn).toBe(SSN);
});

test("a REJECTED create releases the key, and the next attempt recomputes from the row", async () => {
  // `rejected` is the ONE failure that burns an attempt (C1), which rotates the key — so the
  // body may legitimately differ, and the frozen flags must NOT be carried across.
  const companyId = mint({ ssn: SSN });
  const rejecting = doola({
    createCompany: async () => {
      // A REAL typed error: `classifyDoolaFailure` branches on the class, and an untyped throw is
      // `lost` — which deliberately does NOT burn the attempt.
      throw new DoolaApiError("E_REQUEST_BODY_INVALID", 422, "bad body");
    },
  });
  await file(companyId, rejecting);
  const failed = rowOf(companyId);
  expect(failed.state).toBe("failed");
  expect(failed.attempt).toBe(1); // burned → a FRESH key next time

  // The SSN was never persisted-and-erased (no ref), so the retry re-reads it from the row.
  const api = doola();
  await file(companyId, api);
  expect(api.bodies[0]!.responsibleParty.ssn).toBe(SSN);
  expect(detailOf(companyId).companySentAttempt).toBe(1);
});
