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
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
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
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
    parties,
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
          parties,
          quota: new SqliteFormationRepository(db),
        }
      : undefined,
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
  // …and the other tenant cannot onboard with it: the door refuses it as if it did not exist.
  const res = await post(app, "/onboard", theirs, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    partyId,
  });
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

test("REQUIRED: a valid party onboards and is BOUND to the entity the claim mints", async () => {
  const app = makeApp({ required: true });
  const token = await login(app);
  const { partyId } = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const res = await post(app, "/onboard", token, {
    spec: SPEC,
    guardianPasskey: PASSKEY,
    partyId,
  });
  expect(res.status).toBe(202);
  const { id } = await res.json();
  expect(parties.findByEntityKey(id)!.partyId).toBe(partyId);

  // Single use: the same handle cannot file a second company.
  const second = await post(app, "/onboard", token, {
    spec: { ...SPEC, name: "Second Agent" },
    guardianPasskey: PASSKEY,
    partyId,
  });
  expect(second.status).toBe(400);
  expect(repo.listByTenant(account.address)).toHaveLength(1);
});

test("NOT required: onboard without a partyId succeeds (formation is opt-in there)", async () => {
  const app = makeApp({ required: false });
  const token = await login(app);
  const res = await post(app, "/onboard", token, { spec: SPEC, guardianPasskey: PASSKEY });
  expect(res.status).toBe(202);
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

test("the tenant QUOTA refuses the onboard before the entity is minted", async () => {
  const app = makeApp({ required: true, maxPerTenant: 1 });
  const token = await login(app);
  const first = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const { id } = await (
    await post(app, "/onboard", token, {
      spec: SPEC,
      guardianPasskey: PASSKEY,
      partyId: first.partyId,
    })
  ).json();
  // The first entity's create_provider row is what burns the quota.
  db.prepare("INSERT INTO formation_requests (entity_key, step, state) VALUES (?,?,?)").run(
    id,
    "create_provider",
    "pending",
  );

  const second = await (await post(app, "/formation-party", token, REAL_PARTY)).json();
  const res = await post(app, "/onboard", token, {
    spec: { ...SPEC, name: "Second Agent" },
    guardianPasskey: PASSKEY,
    partyId: second.partyId,
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/formation quota exhausted/);
  expect(repo.listByTenant(account.address)).toHaveLength(1);
  // The refused party is still unbound — a refused onboard consumes nothing.
  expect(parties.findOwned(account.address, second.partyId)!.entityKey).toBeNull();
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
  const { id } = await (
    await post(app, "/onboard", token, { spec: SPEC, guardianPasskey: PASSKEY, partyId })
  ).json();
  const rec = repo.findByIdempotencyKey(id)!;
  const printed = JSON.stringify(rec);
  for (const forbidden of ["Ada", "Lovelace", "ada@example.com", "Analytical", "82001", partyId])
    expect(printed).not.toContain(forbidden);
});
