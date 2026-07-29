import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GuardianPasskey } from "../../src/adapters/turnkey/provisioner";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
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
const PK: GuardianPasskey = {
  authenticatorName: "Test Key",
  challenge: "Y2hhbGxlbmdl",
  attestation: {
    credentialId: "cred-1",
    clientDataJson: "e30=",
    attestationObject: "o2M=",
    transports: ["internal"],
  },
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let passkeys: SqlitePasskeyStore;

function makeApp() {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys,
    passkeys,
    mcpPublicUrl: "https://mcp.example.com/mcp",
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

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  passkeys = new SqlitePasskeyStore(db);
});
afterEach(() => db.close());

test("GET /passkeys lists the caller's passkeys", async () => {
  const app = makeApp();
  const jwt = await login(app);
  const id = passkeys.store(account.address, PK);
  const res = await app.request("/passkeys", { headers: { Authorization: `Bearer ${jwt}` } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.map((p: { id: string }) => p.id)).toContain(id);
});

test("DELETE /passkeys/:id revokes (get() then excludes it); unknown → 404", async () => {
  const app = makeApp();
  const jwt = await login(app);
  const id = passkeys.store(account.address, PK);
  const ok = await app.request(`/passkeys/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  expect(ok.status).toBe(204);
  expect(passkeys.get(account.address, id)).toBeNull(); // revoked → onboard/bootstrap reject it
  const gone = await app.request(`/passkeys/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  expect(gone.status).toBe(404);
});

test("401 without an Authorization header", async () => {
  const res = await makeApp().request("/passkeys");
  expect(res.status).toBe(401);
});
