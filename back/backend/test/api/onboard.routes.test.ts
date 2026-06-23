import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";
import { OnboardingRunner } from "../../src/workflow/runner";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const MANAGER = "0x000000000000000000000000000000000000000A";

let db: Database.Database;
let repo: SqliteEntityRepository;

function makeApp() {
  const runSaga = async (i: { idempotencyKey: string }): Promise<EntityRecord> => {
    const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
    const bound = { ...cur, status: "bound" as const, agentId: "5" };
    repo.upsert(bound);
    return bound;
  };
  const runner = new OnboardingRunner({ repo, runSaga });
  const app = buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId: "wizard.local",
  } as never);
  return { app, runner }; // runner exposed so tests can await background work deterministically
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

const validSpec = {
  name: "WizardAgent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: { manager: MANAGER }, // guardian filled by the server = tenant
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000000B",
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
  },
  governance: { amendmentDelay: "24h" },
};
const passkey = {
  challenge: "c",
  attestation: {
    credentialId: "id",
    clientDataJson: "j",
    attestationObject: "a",
    transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"],
  },
};

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

test("protected routes require auth", async () => {
  const res = await makeApp().app.request("/entities");
  expect(res.status).toBe(401);
});

test("onboard accepts (202 pending), then resolves to bound, guardian = tenant", async () => {
  const { app, runner } = makeApp();
  const token = await login(app);
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ spec: validSpec, guardianPasskey: passkey }),
  });
  expect(res.status).toBe(202);
  const { id, status } = await res.json();
  expect(status).toBe("pending");
  await runner.settled(); // deterministically await the background saga
  const view = await (
    await app.request(`/entities/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  expect(view.guardian).toBe(account.address);
  expect(view.status).toBe("bound");
  expect(view).not.toHaveProperty("specJson");
  expect(view).not.toHaveProperty("turnkeySubOrgId");
});

test("a different tenant cannot read another tenant's entity (404)", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const { id } = await (
    await app.request("/onboard", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ spec: validSpec, guardianPasskey: passkey }),
    })
  ).json();
  // Forge a token for a different tenant.
  const other = privateKeyToAccount(
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  );
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const msg = createSiweMessage({
    address: other.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const sig = await other.signMessage({ message: msg });
  const otherToken = (
    await (
      await app.request("/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: msg, signature: sig }),
      })
    ).json()
  ).token;
  const res = await app.request(`/entities/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  expect(res.status).toBe(404);
});

test("onboard with an invalid spec returns 400 validation_error", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ spec: { name: "" }, guardianPasskey: passkey }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe("validation_error");
});

test("GET /passkey/challenge returns a challenge + rpId (no auth required)", async () => {
  const res = await makeApp().app.request("/passkey/challenge");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.challenge).toBe("string");
  expect(body.rpId).toBe("wizard.local");
});
