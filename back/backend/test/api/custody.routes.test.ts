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

/** Tier-0 P1d (review L5): the /onboard custody gates — invalid values and circle-on-a-
 *  turnkey-only-deployment must 400 BEFORE any claim. */

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;

const SPEC = {
  name: "Custody Route Agent",
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

/** What a deployment with no doola block advertises (design §2): formation off, environment null.
 *  Every credential-less deployment — dev, CI, self-hosts — serves exactly this. */
const FORMATION_OFF = {
  formationAvailable: false,
  formationEnvironment: null,
  formationRequired: false,
};

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

function makeApp(opts: {
  circleAvailable: boolean;
  turnkeyAvailable?: boolean;
  def?: "turnkey" | "circle";
  formation?: { environment: "sandbox" | "production"; required?: boolean };
}) {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: opts.def ?? "turnkey",
    circleCustodyAvailable: opts.circleAvailable,
    turnkeyCustodyAvailable: opts.turnkeyAvailable ?? true,
    formation: opts.formation
      ? {
          environment: opts.formation.environment,
          required: opts.formation.required ?? false,
          sandboxSyntheticPii: opts.formation.environment === "sandbox",
          maxPerTenant: 3,
          dailyCeiling: 10,
          parties: new SqliteFormationPartyRepository(db),
          quota: new SqliteFormationRepository(db),
        }
      : undefined,
    repo,
    runner,
    passkeyRpId: "wizard.local",
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

async function login(app: ReturnType<typeof buildApiApp>) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = await account.signMessage({ message });
  const body = await (
    await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    })
  ).json();
  return body.token as string;
}

async function postOnboard(
  app: ReturnType<typeof buildApiApp>,
  token: string,
  extra: Record<string, unknown>,
) {
  return app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ spec: SPEC, guardianPasskey: PASSKEY, ...extra }),
  });
}

test("invalid custody value → 400, nothing claimed", async () => {
  const app = makeApp({ circleAvailable: true });
  const token = await login(app);
  const res = await postOnboard(app, token, { custody: "solana" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/custody must be/);
  expect(repo.listByTenant(account.address)).toHaveLength(0);
});

test("custody=circle on a deployment without circle provisioning → named 400, nothing claimed", async () => {
  const app = makeApp({ circleAvailable: false });
  const token = await login(app);
  const res = await postOnboard(app, token, { custody: "circle" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/circle custody is not available/);
  expect(repo.listByTenant(account.address)).toHaveLength(0);
});

test("custody=circle when available → 202 and the claim records the provider", async () => {
  const app = makeApp({ circleAvailable: true });
  const token = await login(app);
  const res = await postOnboard(app, token, { custody: "circle" });
  expect(res.status).toBe(202);
  const rows = repo.listByTenant(account.address);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.walletProvider).toBe("circle");
});

test("custody omitted → the platform default is claimed", async () => {
  const app = makeApp({ circleAvailable: true, def: "turnkey" });
  const token = await login(app);
  const res = await postOnboard(app, token, {});
  expect(res.status).toBe(202);
  expect(repo.listByTenant(account.address)[0]!.walletProvider).toBe("turnkey");
});

// ── Turnkey availability gate (mirror of the circle gate; mainnet ships circle-only by simply
// not configuring Turnkey, so the deployment must be able to REFUSE turnkey, not crash mid-saga).

test("custody=turnkey on a deployment without turnkey provisioning → named 400, nothing claimed", async () => {
  const app = makeApp({ circleAvailable: true, turnkeyAvailable: false, def: "circle" });
  const token = await login(app);
  const res = await postOnboard(app, token, { custody: "turnkey" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/turnkey custody is not available/);
  expect(repo.listByTenant(account.address)).toHaveLength(0);
});

test("circle-only deployment (the mainnet shape): omitted custody claims circle", async () => {
  const app = makeApp({ circleAvailable: true, turnkeyAvailable: false, def: "circle" });
  const token = await login(app);
  const res = await postOnboard(app, token, {});
  expect(res.status).toBe(202);
  expect(repo.listByTenant(account.address)[0]!.walletProvider).toBe("circle");
});

test("GET /config is public and reports this deployment's custody capabilities", async () => {
  const available = makeApp({ circleAvailable: true, def: "circle" });
  const res = await available.request("/config"); // no auth header — must be public
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    walletProviderDefault: "circle",
    circleCustodyAvailable: true,
    turnkeyCustodyAvailable: true,
    ...FORMATION_OFF,
  });

  // A turnkey-only deployment (the pre-Tier-0 shape: Turnkey creds, no Circle creds) must
  // advertise that, so the wizard never offers circle there.
  const without = makeApp({ circleAvailable: false, def: "turnkey" });
  expect(await (await without.request("/config")).json()).toEqual({
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
    ...FORMATION_OFF,
  });

  // A genuinely bare deployment (no creds at all — the dev/CI shape that still boots) advertises
  // BOTH as unavailable; the wizard dead-ends at the custody step instead of submitting a value
  // this /config response already says would be refused.
  const bare = makeApp({ circleAvailable: false, turnkeyAvailable: false, def: "turnkey" });
  expect(await (await bare.request("/config")).json()).toEqual({
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: false,
    ...FORMATION_OFF,
  });

  // The mainnet shape: circle-only, so the wizard hides the turnkey card instead of offering
  // an option this deployment would 400.
  const circleOnly = makeApp({ circleAvailable: true, turnkeyAvailable: false, def: "circle" });
  expect(await (await circleOnly.request("/config")).json()).toEqual({
    walletProviderDefault: "circle",
    circleCustodyAvailable: true,
    turnkeyCustodyAvailable: false,
    ...FORMATION_OFF,
  });
});

test("GET /config reports formation availability and its ENVIRONMENT (honesty invariant)", async () => {
  // A sandbox formation deployment: available, and the environment is named so the wizard can
  // render "Demo formation (sandbox)" amber instead of a green real-formation badge.
  const sandbox = makeApp({
    circleAvailable: true,
    def: "circle",
    formation: { environment: "sandbox" },
  });
  expect(await (await sandbox.request("/config")).json()).toEqual({
    walletProviderDefault: "circle",
    circleCustodyAvailable: true,
    turnkeyCustodyAvailable: true,
    formationAvailable: true,
    formationEnvironment: "sandbox",
    formationRequired: false,
  });

  // Production formation is a DIFFERENT advertised value, never a missing one: the environment is
  // required-when-available, so no surface can render a real filing and a demo filing the same.
  const prod = makeApp({
    circleAvailable: true,
    def: "circle",
    formation: { environment: "production" },
  });
  expect((await (await prod.request("/config")).json()).formationEnvironment).toBe("production");
});

test("availability and environment are ONE dep — they can never be advertised in disagreement", async () => {
  // The two fields are projections of a single optional object, so "available with a null
  // environment" (a sandbox filing renderable without its demo qualifier) is unrepresentable.
  const off = await (
    await makeApp({ circleAvailable: true, def: "circle" }).request("/config")
  ).json();
  expect([off.formationAvailable, off.formationEnvironment]).toEqual([false, null]);

  const on = await (
    await makeApp({
      circleAvailable: true,
      def: "circle",
      formation: { environment: "sandbox" },
    }).request("/config")
  ).json();
  expect([on.formationAvailable, on.formationEnvironment]).toEqual([true, "sandbox"]);

  // PR 2 advertises FORMATION_REQUIRED — and only now, because the door gate that enforces it
  // ships with it. A requirement nothing enforces is a claim the deployment cannot keep.
  expect(on.formationRequired).toBe(false);
  const mandatory = await (
    await makeApp({
      circleAvailable: true,
      def: "circle",
      formation: { environment: "sandbox", required: true },
    }).request("/config")
  ).json();
  expect([mandatory.formationAvailable, mandatory.formationRequired]).toEqual([true, true]);
});
