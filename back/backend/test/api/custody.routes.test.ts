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

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

function makeApp(opts: { circleAvailable: boolean; def?: "turnkey" | "circle" }) {
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
