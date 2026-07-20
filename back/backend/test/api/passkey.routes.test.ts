import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteChallengeStore } from "../../src/persistence/challengeStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;

let db: Database.Database;
let repo: SqliteEntityRepository;

function makeApp(passkeyRpId = "wizard.local") {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  const app = buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId,
    passkeys: new SqlitePasskeyStore(db),
    challenges: new SqliteChallengeStore(db),
  } as never);
  return app;
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

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

/** Build a base64url clientDataJSON as the browser's WebAuthn ceremony would produce. */
function b64urlClientData(ch: string) {
  return Buffer.from(
    JSON.stringify({ type: "webauthn.create", challenge: ch, origin: "http://localhost" }),
  ).toString("base64url");
}

async function issueChallenge(app: ReturnType<typeof buildApiApp>, token: string) {
  const res = await app.request("/passkey/challenge", {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()).challenge as string;
}

test("GET /passkey/challenge requires auth", async () => {
  const app = makeApp();
  const res = await app.request("/passkey/challenge");
  expect(res.status).toBe(401);
});

test("GET /passkey/challenge returns a tenant-bound challenge + rpId", async () => {
  const app = makeApp();
  const token = await login(app);
  const res = await app.request("/passkey/challenge", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.challenge).toBe("string");
  expect(body.rpId).toBe("wizard.local");
});

test("POST /passkey → 201 { id } for a valid attestation with a freshly issued challenge", async () => {
  const app = makeApp();
  const token = await login(app);
  const challenge = await issueChallenge(app, token);
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      authenticatorName: "My Key",
      challenge,
      attestation: {
        credentialId: "cred-1",
        clientDataJson: Buffer.from(
          JSON.stringify({ type: "webauthn.create", challenge, origin: "http://wizard.local" }),
        ).toString("base64url"),
        attestationObject: "o2M=",
        transports: ["internal"],
      },
    }),
  });
  expect(res.status).toBe(201);
  expect(typeof (await res.json()).id).toBe("string");
});

test("POST /passkey with a malformed attestation → 400", async () => {
  const app = makeApp();
  const token = await login(app);
  const challenge = await issueChallenge(app, token);
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ challenge }),
  });
  expect(res.status).toBe(400);
});

test("POST /passkey without auth → 401", async () => {
  const app = makeApp();
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge: "x",
      attestation: {
        credentialId: "cred-1",
        clientDataJson: "e30=",
        attestationObject: "o2M=",
        transports: ["internal"],
      },
    }),
  });
  expect(res.status).toBe(401);
});

test("POST /passkey rejects an unbound challenge", async () => {
  const app = makeApp();
  const token = await login(app);
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      challenge: "not-a-real-challenge",
      attestation: {
        credentialId: "c",
        clientDataJson: b64urlClientData("not-a-real-challenge"),
        attestationObject: "o",
        transports: [],
      },
    }),
  });
  expect(res.status).toBe(400);
});

test("POST /passkey accepts a freshly issued, matching challenge", async () => {
  const app = makeApp("localhost");
  const token = await login(app);
  const challenge = await issueChallenge(app, token);
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      challenge,
      attestation: {
        credentialId: "c",
        clientDataJson: b64urlClientData(challenge),
        attestationObject: "o",
        transports: [],
      },
    }),
  });
  expect(res.status).toBe(201);
});

test("POST /passkey rejects a replayed (already-consumed) challenge", async () => {
  const app = makeApp("localhost");
  const token = await login(app);
  const challenge = await issueChallenge(app, token);
  const attestation = {
    credentialId: "c",
    clientDataJson: b64urlClientData(challenge),
    attestationObject: "o",
    transports: [],
  };
  const first = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ challenge, attestation }),
  });
  expect(first.status).toBe(201);
  const second = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ challenge, attestation }),
  });
  expect(second.status).toBe(400);
});

test("POST /passkey rejects a challenge issued for a different tenant", async () => {
  const app = makeApp();
  const token = await login(app);
  const challenge = await issueChallenge(app, token);

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
  ).token as string;

  const res = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      challenge,
      attestation: {
        credentialId: "c",
        clientDataJson: b64urlClientData(challenge),
        attestationObject: "o",
        transports: [],
      },
    }),
  });
  expect(res.status).toBe(400);
});

test("POST /passkey rejects clientDataJSON whose origin host doesn't match rpId", async () => {
  const app = makeApp();
  const token = await login(app);
  const challenge = await issueChallenge(app, token);
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      challenge,
      attestation: {
        credentialId: "c",
        clientDataJson: Buffer.from(
          JSON.stringify({
            type: "webauthn.create",
            challenge,
            origin: "https://evil.example",
          }),
        ).toString("base64url"),
        attestationObject: "o",
        transports: [],
      },
    }),
  });
  expect(res.status).toBe(400);
});
