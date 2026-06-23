import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { verifySession } from "../../src/auth/session";
import { migrate, openDatabase } from "../../src/persistence/db";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;

let db: Database.Database;
function app(db: Database.Database) {
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
  } as never);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

test("nonce -> sign -> verify issues a session for the signer", async () => {
  const a = app(db);
  const nonce = (await (await a.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = await account.signMessage({ message });
  const res = await a.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.address).toBe(account.address);
  expect((await verifySession(body.token, "s")).tenantId).toBe(account.address);
});

test("verify with a bad signature returns 401 envelope", async () => {
  const a = app(db);
  const nonce = (await (await a.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const res = await a.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature: `0x${"1".repeat(130)}` }),
  });
  expect(res.status).toBe(401);
  expect((await res.json()).error.code).toBe("unauthorized");
});
