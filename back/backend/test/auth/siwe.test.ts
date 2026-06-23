import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { verifySiwe } from "../../src/auth/siwe";
import { migrate, openDatabase } from "../../src/persistence/db";

let db: Database.Database;
let store: SqliteNonceStore;
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqliteNonceStore(db);
});
afterEach(() => db.close());

async function signedMessage(
  nonce: string,
  over: Partial<{ chainId: number; domain: string }> = {},
) {
  const message = createSiweMessage({
    address: account.address,
    chainId: over.chainId ?? CHAIN,
    domain: over.domain ?? DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
    issuedAt: new Date(NOW),
  });
  const signature = await account.signMessage({ message });
  return { message, signature };
}

test("valid SIWE message verifies to the signer address", async () => {
  const nonce = store.issue(NOW, 600_000);
  const { message, signature } = await signedMessage(nonce);
  const addr = await verifySiwe({
    message,
    signature,
    nonceStore: store,
    domain: DOMAIN,
    chainId: CHAIN,
    now: NOW,
  });
  expect(addr).toBe(account.address);
});

test("replayed nonce is rejected (single-use)", async () => {
  const nonce = store.issue(NOW, 600_000);
  const { message, signature } = await signedMessage(nonce);
  await verifySiwe({
    message,
    signature,
    nonceStore: store,
    domain: DOMAIN,
    chainId: CHAIN,
    now: NOW,
  });
  await expect(
    verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW }),
  ).rejects.toThrow(/nonce/i);
});

test("unknown nonce is rejected", async () => {
  const { message, signature } = await signedMessage("deadbeefdeadbeef");
  await expect(
    verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW }),
  ).rejects.toThrow(/nonce/i);
});

test("expired nonce is rejected", async () => {
  const nonce = store.issue(NOW, 1_000);
  const { message, signature } = await signedMessage(nonce);
  await expect(
    verifySiwe({
      message,
      signature,
      nonceStore: store,
      domain: DOMAIN,
      chainId: CHAIN,
      now: NOW + 2_000,
    }),
  ).rejects.toThrow(/nonce/i);
});

test("wrong domain is rejected", async () => {
  const nonce = store.issue(NOW, 600_000);
  const { message, signature } = await signedMessage(nonce, { domain: "evil.example" });
  await expect(
    verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW }),
  ).rejects.toThrow(/domain/i);
});

test("tampered signature is rejected", async () => {
  const nonce = store.issue(NOW, 600_000);
  const { message } = await signedMessage(nonce);
  const bad = `0x${"1".repeat(130)}` as `0x${string}`;
  await expect(
    verifySiwe({
      message,
      signature: bad,
      nonceStore: store,
      domain: DOMAIN,
      chainId: CHAIN,
      now: NOW,
    }),
  ).rejects.toThrow();
});
