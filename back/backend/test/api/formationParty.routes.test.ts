/**
 * PII intake + the formation door on REST (design §3/§5).
 *
 * The properties that matter legally: PII enters through ONE call and never through `spec`; the
 * response and the ops trail carry the handle and nothing else; a sandbox deployment REFUSES
 * real personal data rather than quietly substituting a fixture; and a party belongs to exactly
 * one tenant and exactly one entity.
 *
 * The door matrix (required/optional/absent × present/missing/foreign/bound) is exercised at the
 * gate itself in test/formation/doorGate.test.ts; this file proves the ROUTE runs that gate, in
 * the documented order, before anything is claimed.
 */
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { ApiError } from "../../src/api/errors";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { createCompany } from "../../src/formation/company";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const other = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;

const SPEC = {
  name: "Formation Route Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {},
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000dDdd",
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
  legal: {},
  metadata: {},
};
const PASSKEY = { attestation: { credentialId: "cred-1" } };

const REAL_PARTY = {
  legalFirstName: "Ada",
  legalLastName: "Lovelace",
  email: "ada@example.com",
  phone: "+12125550100",
  address: {
    line1: "1 Analytical Way",
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
  },
};

/** The PRODUCTION intake (A2 §5) — what `POST /companies` takes now that it is real. */
const COMPANY_INTAKE = {
  names: ["Acme Robotics LLC", "Acme Automata", "Acme Mechanicals"],
  businessPurpose: "Operating autonomous software agents.",
  industryLabel: "Software development",
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let parties: SqliteFormationPartyRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  parties = new SqliteFormationPartyRepository(db);
});
afterEach(() => db.close());

function makeApp(
  formation?: { required?: boolean; syntheticPii?: boolean; maxPerTenant?: number },
  custody: { circle?: boolean } = {},
) {
  const companies = new SqliteCompanyRepository(db);
  const requests = new SqliteFormationRepository(db);
  const pin = { provider: "doola" as const, environment: "sandbox" as const };
  // ONE dependency set for all three doors, exactly as the composition root builds it — only the
  // transaction differs per call site.
  const companyDeps = {
    companies,
    parties,
    requests,
    pin,
    sandboxSyntheticPii: formation?.syntheticPii ?? false,
    maxPerTenant: formation?.maxPerTenant ?? 3,
    dailyCeiling: 10,
  };
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
    // The claim ATTACHES a company and copies the pin off ITS row (2026-08-26 §3). A3 removed
    // the shim, so a company is created at its own door and never inside the claim.
    formation: formation ? { companies, requests, maxAgentsPerCompany: 10 } : undefined,
  });
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: custody.circle ?? true,
    turnkeyCustodyAvailable: true,
    formation: formation
      ? {
          environment: "sandbox" as const,
          required: formation.required ?? true,
          sandboxSyntheticPii: formation.syntheticPii ?? false,
          maxPerTenant: formation.maxPerTenant ?? 3,
          dailyCeiling: 10,
          maxAgentsPerCompany: 10,
          parties,
          requests,
          companies,
          pin,
          companyDeps,
        }
      : undefined,
    companies,
    repo,
    runner,
    passkeyRpId: DOMAIN,
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    jobRunner: {} as never,
    jobClientAddress: "0x0000000000000000000000000000000000000000",
    jobEvaluatorAddress: "0x0000000000000000000000000000000000000000",
    arc: {} as never,
    agentRuns: {} as never,
  } as never);
}

async function login(app: ReturnType<typeof buildApiApp>, who = account) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: who.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = await who.signMessage({ message });
  const body = await (
    await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    })
  ).json();
  return body.token as string;
}

const post = (app: ReturnType<typeof buildApiApp>, path: string, token: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const patch = (app: ReturnType<typeof buildApiApp>, path: string, token: string, body: unknown) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

/** The correction a caller sends when doola refuses the person. */
const CORRECTED_PARTY = {
  ...REAL_PARTY,
  legalFirstName: "Grace",
  legalLastName: "Hopper",
  email: "grace@example.com",
  phone: "+13075550142",
};

// ── POST /formation-party ───────────────────────────────────────────────────────────────────

test("real PII in, an opaque handle out — and NOTHING else in the response", async () => {
  const app = makeApp({});
  const token = await login(app);
  const res = await post(app, "/formation-party", token, REAL_PARTY);
  expect(res.status).toBe(201);
  const body = await res.json();
  // Exactly one key: echoing the stored identity back would put PII in a response body, a log,
  // and any client that persists API responses.
  expect(Object.keys(body)).toEqual(["partyId"]);
  expect(parties.findOwned(account.address, body.partyId)!.legalFirstName).toBe("Ada");
});

test("C6: a real party with NO PHONE is refused at intake (400), not at the filing", async () => {
  // doola refuses a company create whose responsible party has no phone. Left to the create step,
  // that refusal arrives AFTER the entity is minted, bound and funded — the caller's legal
  // identity is unusable and they find out from a `failed` formation row. Refused here it costs
  // one 400.
  const app = makeApp({});
  const token = await login(app);
  const { phone: _dropped, ...noPhone } = REAL_PARTY;
  const res = await post(app, "/formation-party", token, noPhone);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("validation_error");
  expect(JSON.stringify(body.error.details)).toContain("phone");
  // Nothing was stored: a refused intake must not leave a half-usable identity behind.
  expect(db.prepare("SELECT COUNT(*) AS n FROM formation_parties").get()).toEqual({ n: 0 });
});

test("C6: the SYNTHETIC fixture still passes — it supplies a phone of its own", async () => {
  const app = makeApp({ syntheticPii: true });
  const token = await login(app);
  const res = await post(app, "/formation-party", token, { synthetic: true });
  expect(res.status).toBe(201);
  const { partyId } = await res.json();
  expect(parties.findOwned(account.address, partyId)!.phone).toBe("+13075550142");
});

test("it requires auth, and the party belongs to the AUTHENTICATED tenant only", async () => {
  const app = makeApp({});
  expect(
    (
      await app.request("/formation-party", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(REAL_PARTY),
      })
    ).status,
  ).toBe(401);

  const mine = await login(app);
  const theirs = await login(app, other);
  const { partyId } = await (await post(app, "/formation-party", mine, REAL_PARTY)).json();
  expect(parties.findOwned(other.address, partyId)).toBeUndefined();
  // …and the other tenant cannot SPEND it: the create door refuses it as if it did not exist.
  // (It used to be onboard that proved this. A3 removed the party handle from that door, so the
  // rule is asserted where the party is now actually consumed.)
  const res = await post(app, "/companies", theirs, { partyId, ...COMPANY_INTAKE });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/unknown, not yours, or already bound/);
});

test("the body is validated as PII, not as a spec: unknown keys and bad fields are named", async () => {
  const app = makeApp({});
  const token = await login(app);
  for (const bad of [
    { ...REAL_PARTY, ssn: "123-45-6789" }, // .strict(): a field we deliberately do not collect
    { ...REAL_PARTY, email: "not-an-email" },
    { ...REAL_PARTY, address: { ...REAL_PARTY.address, country: "US" } }, // alpha-2, not alpha-3
    { legalFirstName: "Ada" },
  ])
    expect((await post(app, "/formation-party", token, bad)).status).toBe(400);
  // ISO-3 is normalized, so "usa" and "USA" cannot become two different countries.
  const { partyId } = await (
    await post(app, "/formation-party", token, {
      ...REAL_PARTY,
      address: { ...REAL_PARTY.address, country: "usa" },
    })
  ).json();
  expect(parties.findOwned(account.address, partyId)!.country).toBe("USA");
});

test("a deployment that forms nothing has no PII surface at all (503)", async () => {
  const app = makeApp(undefined);
  const token = await login(app);
  const res = await post(app, "/formation-party", token, REAL_PARTY);
  expect(res.status).toBe(503);
  expect((await res.json()).error.message).toMatch(/formation is not available/);
});

// ── synthetic PII, both directions (§3, audit H7) ───────────────────────────────────────────

test("SANDBOX synthetic mode: real PII is REFUSED, and { synthetic: true } stores the fixture", async () => {
  const app = makeApp({ syntheticPii: true });
  const token = await login(app);

  const refused = await post(app, "/formation-party", token, REAL_PARTY);
  expect(refused.status).toBe(400);
  expect((await refused.json()).error.message).toMatch(/FORMATION_SANDBOX_SYNTHETIC_PII/);
  // Refused, not substituted: nothing was stored, so nothing real can leak later.
  expect(db.prepare("SELECT COUNT(*) c FROM formation_parties").get()).toEqual({ c: 0 });

  const { partyId } = await (
    await post(app, "/formation-party", token, { synthetic: true })
  ).json();
  const rec = parties.findOwned(account.address, partyId)!;
  expect(rec.synthetic).toBe(true);
  expect(rec.legalFirstName).toBe("Novi Sandbox");
  expect(rec.email).toBe(`sandbox+${partyId}@novicorpus.com`);
  expect(rec.country).toBe("USA");
});

test("PRODUCTION: the synthetic shortcut is refused — a real filing needs a real identity", async () => {
  const app = makeApp({ syntheticPii: false });
  const token = await login(app);
  const res = await post(app, "/formation-party", token, { synthetic: true });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/synthetic formation parties are refused/);
  expect(db.prepare("SELECT COUNT(*) c FROM formation_parties").get()).toEqual({ c: 0 });
});

// ── the door on POST /onboard ───────────────────────────────────────────────────────────────

test("REQUIRED: onboard without a partyId is refused, and NOTHING is claimed", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const res = await post(app, "/onboard", token, { spec: SPEC, guardianPasskey: PASSKEY });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/formation is required on this deployment/);
  expect(repo.listByTenant(account.address)).toHaveLength(0);
});

test("A3: a partyId at the onboard door is REFUSED, and NOTHING is claimed", async () => {
  // A1's shim minted a 1:1 company for exactly this request. With it gone, ignoring the field
  // would take an onboard from a caller who had just posted a real legal identity and believed a
  // filing was being opened — so the refusal names the door that opens one.
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const res = await post(app, "/onboard", token, { spec: SPEC, guardianPasskey: PASSKEY, partyId });
  expect(res.status).toBe(400);
  const message = (await res.json()).error.message as string;
  expect(message).toMatch(/partyId is not accepted here/);
  expect(message).toMatch(/POST \/companies/);
  expect(repo.listByTenant(account.address)).toHaveLength(0);
  // The party is untouched, and still spendable at the door that takes it.
  expect(parties.findOwned(account.address, partyId)!.companyId).toBeNull();
});

test("REQUIRED: create-then-onboard is the whole flow, and the party is bound by the CREATE", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE })
  ).json();
  expect(parties.findByCompanyId(companyId)!.partyId).toBe(partyId);

  const res = await post(app, "/onboard", token, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    companyId,
  });
  expect(res.status).toBe(202);
  const { id } = await res.json();
  expect(repo.findByIdempotencyKey(id)!.companyId).toBe(companyId);

  // Single use, at the door that spends it: the same handle cannot file a second company.
  const second = await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE });
  expect(second.status).toBe(400);
  expect((await second.json()).error.message).toMatch(/already bound/);
});

test("NOT required: onboard without a partyId succeeds (formation is opt-in there)", async () => {
  const app = makeApp({ required: false });
  const token = await login(app);
  const res = await post(app, "/onboard", token, { spec: SPEC, guardianPasskey: PASSKEY });
  expect(res.status).toBe(202);
});

test("C5: NOT required + a company — the entity is PINNED from its row (opt-in filing)", async () => {
  // ⚠ Supersedes PR 2 decision #2, restated at company scope after A3. A supplied handle is
  // always honoured; `required` only decides whether the door refuses an onboard that carries
  // none. An MCP or REST caller can therefore opt in to formation on a box where the wizard
  // does not.
  const app = makeApp({ required: false });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE })
  ).json();
  const res = await post(app, "/onboard", token, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    companyId,
  });
  expect(res.status).toBe(202);
  const { id } = await res.json();
  const rec = repo.findByIdempotencyKey(id)!;
  expect([rec.formationProvider, rec.formationEnvironment]).toEqual(["doola", "sandbox"]);
  expect(parties.findByCompanyId(rec.companyId!)!.partyId).toBe(partyId);
});

test("C5: NOT required + the WIZARD's shape (no partyId) — 202, and nothing is pinned or filed", async () => {
  // The testnet box's shape until the PR-4 wizard collects an identity. It must keep working
  // exactly as it did before formation existed.
  const app = makeApp({ required: false });
  const token = await login(app);
  const res = await post(app, "/onboard", token, { spec: SPEC, guardianPasskey: PASSKEY });
  expect(res.status).toBe(202);
  const { id } = await res.json();
  const rec = repo.findByIdempotencyKey(id)!;
  expect([rec.formationProvider, rec.formationEnvironment]).toEqual([null, null]);
});

test("ABSENT: a partyId sent to a deployment that forms nothing is refused, never ignored", async () => {
  const app = makeApp(undefined);
  const token = await login(app);
  const res = await post(app, "/onboard", token, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    partyId: "whatever",
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/formation is not available/);
  expect(repo.listByTenant(account.address)).toHaveLength(0);
});

test("the tenant QUOTA refuses the CREATE, which is the door that spends", async () => {
  // It used to be asserted on onboard, because A1's shim made onboard the door that spent. A3
  // moved the money to `POST /companies` and the quota went with it — `createCompany` counts
  // CHARGEABLE companies (`ready`, or carrying a live payment), so the first create is what
  // exhausts a limit of one.
  const app = makeApp({ required: true, maxPerTenant: 1 });
  const token = await login(app);
  const first = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId: first.partyId, ...COMPANY_INTAKE })
  ).json();
  expect(companyId).toBeTruthy();

  const second = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const res = await post(app, "/companies", token, {
    partyId: second.partyId,
    ...COMPANY_INTAKE,
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/formation quota exhausted/);
  // Read through a repository of its own over the SAME database — `makeApp` keeps its stores
  // private, exactly as the composition root does.
  expect(new SqliteCompanyRepository(db).listByTenant(account.address)).toHaveLength(1);
  // The refused party is still unbound — a refused create consumes nothing.
  expect(parties.findOwned(account.address, second.partyId)!.companyId).toBeNull();
});

test("gate ORDER: custody is refused before formation (the REST↔MCP mirror)", async () => {
  // Both wrong: an unavailable custody AND no partyId. Custody is the primary error on BOTH
  // surfaces — the order is what makes the two doors interchangeable, and the MCP twin of this
  // test asserts the same two outcomes.
  const app = makeApp({ required: true }, { circle: false });
  const token = await login(app);
  const invalid = await post(app, "/onboard", token, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    custody: "solana",
  });
  expect((await invalid.json()).error.message).toMatch(/custody must be/);

  const unavailable = await post(app, "/onboard", token, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    custody: "circle",
  });
  expect((await unavailable.json()).error.message).toMatch(/circle custody is not available/);

  // …and with custody fine, the formation gate is what refuses.
  const ok = await post(app, "/onboard", token, { spec: SPEC, guardianPasskey: PASSKEY });
  expect((await ok.json()).error.message).toMatch(/formation is required on this deployment/);
  expect(repo.listByTenant(account.address)).toHaveLength(0);
});

test("no PII reaches the entity record or its spec_json", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE })
  ).json();
  const { id } = await (
    await post(app, "/onboard", token, { spec: SPEC, guardianPasskey: PASSKEY, companyId })
  ).json();
  const rec = repo.findByIdempotencyKey(id)!;
  const printed = JSON.stringify(rec);
  for (const forbidden of ["Ada", "Lovelace", "ada@example.com", "Analytical", "82001", partyId])
    expect(printed).not.toContain(forbidden);
});

// ── COMPANIES (design 2026-08-26 §7) ────────────────────────────────────────────────────────

test("POST /companies mints a company through the ONE domain function, and lists it back", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();

  const res = await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE });
  expect(res.status).toBe(201);
  const { companyId } = await res.json();
  expect(companyId).toBeTruthy();

  const list = await (
    await app.request("/companies", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(list.companies).toHaveLength(1);
  // The projection's key set, asserted IDENTICALLY on the MCP door (see
  // test/mcp/formationParty.int.test.ts): one API-level contract, two surfaces, and a field added
  // to one and not the other fails whichever was forgotten.
  expect(Object.keys(list.companies[0]).sort()).toEqual([
    "agents",
    "businessPurpose",
    "companyId",
    "createdAt",
    "environment",
    "filedAt",
    "filingNumber",
    "formationStatus",
    "industryLabel",
    "legalNameFiled",
    "nameOptions",
    "paying",
    "state",
    "status",
    "synthetic",
  ]);
  expect(list.companies[0]).toMatchObject({
    companyId,
    status: "ready",
    environment: "sandbox",
    // DERIVED, both of them: nothing about progress or payment is stored on the company row.
    formationStatus: "none",
    paying: false,
    agents: 0,
    // All THREE candidates, canonical, ending split off — the shape the filer sends verbatim.
    nameOptions: [
      { name: "Acme Robotics", entityTypeEnding: "LLC", position: 1 },
      { name: "Acme Automata", entityTypeEnding: "LLC", position: 2 },
      { name: "Acme Mechanicals", entityTypeEnding: "LLC", position: 3 },
    ],
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: "Software development",
  });
  // NO PII on the list, ever — not the responsible party's name, not their email.
  const printed = JSON.stringify(list);
  for (const forbidden of ["Ada", "Lovelace", "ada@example.com", "82001"])
    expect(printed).not.toContain(forbidden);
});

test("POST /companies requires a session and the FULL intake, naming what is missing", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();

  const message = async (body: Record<string, unknown>) => {
    const res = await post(app, "/companies", token, body);
    expect(res.status).toBe(400);
    return (await res.json()).error.message as string;
  };
  expect(await message({ ...COMPANY_INTAKE })).toMatch(/partyId is required/);
  // Each refusal names its own field — the whole point of A2's messages.
  expect(await message({ partyId, ...COMPANY_INTAKE, names: undefined })).toMatch(/^names must be/);
  expect(await message({ partyId, ...COMPANY_INTAKE, businessPurpose: undefined })).toMatch(
    /^businessPurpose is required/,
  );
  expect(await message({ partyId, ...COMPANY_INTAKE, industryLabel: "Nope" })).toMatch(
    /^industryLabel "Nope" is not one of/,
  );
  // A TYPE error is caught by the route; the CONTENT rules all live in `createCompany`.
  expect(await message({ partyId, ...COMPANY_INTAKE, names: "Acme" })).toMatch(/^names must be/);
  expect(await message({ partyId, ...COMPANY_INTAKE, ssn: 123 })).toBe("ssn must be a string");
  // STRICT, and this is the case it exists for: an unknown key is SILENTLY DROPPED by a
  // permissive schema, so a caller who typed `SSN` or `ssn_number` would have got back a
  // companyId filed under the slow EIN route with no indication their number went nowhere — the
  // same failure the MCP door had, on the one surface that actually collects it.
  expect(await message({ partyId, ...COMPANY_INTAKE, SSN: "123-45-6789" })).toBe(
    "unknown field: SSN",
  );
  expect(await message({ partyId, ...COMPANY_INTAKE, ssn_number: "x", nickname: "y" })).toMatch(
    /^unknown fields: /,
  );

  const anon = await app.request("/companies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ partyId: "p", ...COMPANY_INTAKE }),
  });
  expect(anon.status).toBe(401);
});

test("a SANDBOX deployment refuses an ssn outright, and nothing is minted", async () => {
  // §4.1. The test app is a sandbox deployment, which is the shape every deployment but one has.
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const res = await post(app, "/companies", token, {
    partyId,
    ...COMPANY_INTAKE,
    ssn: "123-45-6789",
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/never sent to doola's development environment/);
  const list = await (
    await app.request("/companies", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(list.companies).toHaveLength(0);
});

test("PATCH /companies/:id re-opens a rejected intake, and REQUIRES a session", async () => {
  // §4.7. The freeze itself is a property of the row (tested at the repository and the domain
  // function); what this pins is that the ROUTE exists, is authenticated, and refuses a frozen
  // company with the message a caller can act on.
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE })
  ).json();

  const patch = (body: unknown, auth = token) =>
    app.request(`/companies/${companyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });

  // ⚠ The subpath needs its OWN requireAuth: Hono's `use` on a bare "/companies" matches that
  // path only, so without it this door — the one that carries an SSN — would be wide open.
  const anon = await app.request(`/companies/${companyId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(COMPANY_INTAKE),
  });
  expect(anon.status).toBe(401);

  // Nothing sent yet: the intake is editable.
  const ok = await patch({ ...COMPANY_INTAKE, businessPurpose: "Corrected." });
  expect(ok.status).toBe(200);
  const list = await (
    await app.request("/companies", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(list.companies[0].businessPurpose).toBe("Corrected.");

  // …and once a create has gone out under the live key, it is not. (Same database handle as the
  // app's — the repository is a thin statement holder, not a session.)
  const steps = new SqliteFormationRepository(db);
  steps.claimAllSteps(companyId);
  steps.transition(companyId, "create_provider", "pending", "submitted", {
    detail: JSON.stringify({ companySentAttempt: 0 }),
  });
  const frozen = await patch(COMPANY_INTAKE);
  expect(frozen.status).toBe(400);
  expect((await frozen.json()).error.message).toMatch(/can no longer be changed/);
});

test("a deployment that forms nothing answers 503 on POST and an empty list on GET", async () => {
  const app = makeApp(undefined);
  const token = await login(app);
  const res = await post(app, "/companies", token, { partyId: "p", ...COMPANY_INTAKE });
  expect(res.status).toBe(503);
  const list = await (
    await app.request("/companies", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(list).toEqual({ companies: [] });
});

test("ATTACH: onboard takes a companyId, and a second agent joins the SAME filing", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE })
  ).json();

  for (const name of ["Agent One", "Agent Two"]) {
    const res = await post(app, "/onboard", token, {
      spec: { ...SPEC, name },
      guardianPasskey: PASSKEY,
      companyId,
    });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    // The pin is copied FROM THE COMPANY ROW, never from config.
    expect(repo.findByIdempotencyKey(id)).toMatchObject({
      companyId,
      formationProvider: "doola",
      formationEnvironment: "sandbox",
    });
  }
  // Billing is per COMPANY: the second agent is free, and there is still ONE party bound.
  expect(repo.listByTenant(account.address)).toHaveLength(2);
});

test("A3: a partyId BESIDE a valid companyId is refused too — one handle, one meaning", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE })
  ).json();
  const second = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const res = await post(app, "/onboard", token, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    companyId,
    partyId: second.partyId,
  });
  expect(res.status).toBe(400);
  // It used to be its own "pass either… not both" sentence. There is no `both` to disambiguate
  // any more: the party door and the company door are different doors, and neither is onboard.
  expect((await res.json()).error.message).toMatch(/partyId is not accepted here/);
});

test("a FOREIGN company id is refused with the same message as an unknown one", async () => {
  const app = makeApp({ required: true });
  const mine = await login(app);
  const theirs = await login(app, other);
  const { partyId } = await (await post(app, "/formation-party", theirs, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", theirs, {
      partyId,
      ...COMPANY_INTAKE,
      names: ["Theirs One", "Theirs Two", "Theirs Three"],
    })
  ).json();

  const foreign = await post(app, "/onboard", mine, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    companyId,
  });
  const unknown = await post(app, "/onboard", mine, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    companyId: "00000000-0000-4000-8000-000000000000",
  });
  expect([foreign.status, unknown.status]).toEqual([400, 400]);
  // Identical: the door is not an existence oracle over another tenant's company ids.
  expect((await foreign.json()).error.message).toBe((await unknown.json()).error.message);
  // …and the OTHER tenant's company is untouched.
  expect(repo.listByTenant(account.address)).toHaveLength(0);
});

// ── PATCH /companies/:companyId/party (design §7, A3) ───────────────────────────────────────

/** A company with a real bound party, its filing not yet opened — the everyday editable case. */
async function companyWithParty(app: ReturnType<typeof buildApiApp>, token: string) {
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE })
  ).json();
  return { partyId, companyId };
}

test("the party-edit door rewrites the identity and answers with the handle alone", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId, companyId } = await companyWithParty(app, token);

  const res = await patch(app, `/companies/${companyId}/party`, token, CORRECTED_PARTY);
  expect(res.status).toBe(200);
  // Exactly one key, for the reason the create gives: echoing the stored identity back would put
  // PII in a response body and in every client that caches one.
  expect(await res.json()).toEqual({ partyId });
  expect(parties.findOwned(account.address, partyId)).toMatchObject({
    legalFirstName: "Grace",
    email: "grace@example.com",
  });
});

test("it requires a session, and another tenant's company is refused as if it did not exist", async () => {
  const app = makeApp({ required: true });
  const mine = await login(app);
  const theirs = await login(app, other);
  const { partyId, companyId } = await companyWithParty(app, mine);

  const noAuth = await app.request(`/companies/${companyId}/party`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(CORRECTED_PARTY),
  });
  expect(noAuth.status).toBe(401);

  const foreign = await patch(app, `/companies/${companyId}/party`, theirs, CORRECTED_PARTY);
  const unknown = await patch(
    app,
    "/companies/00000000-0000-4000-8000-000000000000/party",
    theirs,
    CORRECTED_PARTY,
  );
  expect([foreign.status, unknown.status]).toEqual([400, 400]);
  // One answer for both, or the door is an existence oracle over another tenant's company ids.
  expect((await foreign.json()).error.message).toBe((await unknown.json()).error.message);
  expect(parties.findOwned(account.address, partyId)!.legalFirstName).toBe("Ada");
});

/**
 * WHY THE DOOR IS ADDRESSED BY COMPANY.
 *
 * Its first version took a `partyId`, so the only thing between a mistyped uuid and an identity
 * swap on the wrong Wyoming LLC was the freeze — and an unopened filing passes it. Addressed by
 * company the party is RESOLVED rather than named, so "edit the other company's person" is not a
 * request this API can express.
 */
test("a tenant with two companies cannot cross-edit: the party is resolved, never named", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const a = await companyWithParty(app, token);
  const b = await companyWithParty(app, token);

  expect((await patch(app, `/companies/${a.companyId}/party`, token, CORRECTED_PARTY)).status).toBe(
    200,
  );
  expect(parties.findOwned(account.address, a.partyId)!.legalFirstName).toBe("Grace");
  expect(parties.findOwned(account.address, b.partyId)!.legalFirstName).toBe("Ada");
  // …and there is no door left that takes a party handle at all.
  expect((await patch(app, `/formation-party/${b.partyId}`, token, CORRECTED_PARTY)).status).toBe(
    404,
  );
});

test("it parses the SAME .strict() schema the create does — an `ssn` key is refused, not dropped", async () => {
  // There is no `ssn` field on this door and there never will be: the AAD a ciphertext is sealed
  // under is minted by `POST /companies`, and re-captured only by `PATCH /companies/:companyId`.
  // `.strict()` is what turns "not a field" into a refusal rather than a silent drop.
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId, companyId } = await companyWithParty(app, token);

  const res = await patch(app, `/companies/${companyId}/party`, token, {
    ...CORRECTED_PARTY,
    ssn: "123-45-6789",
  });
  expect(res.status).toBe(400);
  // …and no digits of it come back in the refusal.
  expect(await res.text()).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  expect(parties.findOwned(account.address, partyId)!.legalFirstName).toBe("Ada");

  // The same body WITHOUT it is accepted, so the refusal is about that key alone.
  expect((await patch(app, `/companies/${companyId}/party`, token, CORRECTED_PARTY)).status).toBe(
    200,
  );
});

/**
 * The party-edit door is a PII INTAKE, and it was the one that did not run the intake gate.
 *
 * `POST /formation-party` refuses real personal data on a sandbox deployment; this door rewrote
 * the same ten columns with no check at all, so a real name, email, phone and home address could
 * be written over the labeled fixture and filed to doola's DEVELOPMENT environment as the
 * responsible person.
 */
test("SANDBOX: the edit door refuses a real identity, in the create door's own words", async () => {
  const app = makeApp({ required: true, syntheticPii: true });
  const token = await login(app);
  const { partyId } = await (
    await post(app, "/formation-party", token, { synthetic: true })
  ).json();
  const { companyId } = await (
    await post(app, "/companies", token, { partyId, ...COMPANY_INTAKE, synthetic: true })
  ).json();

  const res = await patch(app, `/companies/${companyId}/party`, token, CORRECTED_PARTY);
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/FORMATION_SANDBOX_SYNTHETIC_PII/);
  // Nothing was written: the fixture is intact.
  expect(parties.findOwned(account.address, partyId)!.legalFirstName).not.toBe("Grace");
});

test("PRODUCTION: the edit door refuses a SYNTHETIC party row, in the create door's own words", async () => {
  // The mirror image, checked against the ROW rather than the request: the row was minted through
  // the same gate, so a mismatch is a bug — the bug that puts a real person's identity onto a
  // filing labeled synthetic on every surface that shows it.
  const app = makeApp({ required: true, syntheticPii: false });
  const token = await login(app);
  const { partyId, companyId } = await companyWithParty(app, token);
  db.prepare("UPDATE formation_parties SET synthetic = 1 WHERE party_id = ?").run(partyId);

  const res = await patch(app, `/companies/${companyId}/party`, token, CORRECTED_PARTY);
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/synthetic formation parties are refused/);
  expect(parties.findOwned(account.address, partyId)!.legalFirstName).toBe("Ada");
});

test("a deployment that forms nothing has no party-edit door either (503)", async () => {
  const app = makeApp(undefined);
  const token = await login(app);
  const res = await patch(app, "/companies/whatever/party", token, CORRECTED_PARTY);
  expect(res.status).toBe(503);
});
