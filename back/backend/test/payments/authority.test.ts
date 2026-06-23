import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { type AuthorityDeps, authorizePayment } from "../../src/payments/authority";
import { PaymentLedger } from "../../src/payments/ledger";
import { migrate } from "../../src/persistence/db";

const payee = "0x0000000000000000000000000000000000000abc" as const;

function deps(over: Partial<AuthorityDeps> = {}): AuthorityDeps {
  const db = new Database(":memory:");
  migrate(db);
  return {
    ledger: new PaymentLedger(db),
    readTreasury: async () => ({
      available: 1_000n,
      paused: false,
      allowlistEnabled: true,
      isAllowed: true,
    }),
    signX402: async () => ({ header: "X-PAYMENT-fake", ledgerRef: "ref" }),
    ...over,
  };
}

test("authorizes a valid payment: records ledger + returns X-PAYMENT", async () => {
  const d = deps();
  const res = await authorizePayment(d, {
    payee,
    amount: 100n,
    resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
  expect(res.ok).toBe(true);
  expect((res as { header: string }).header).toBe("X-PAYMENT-fake");
  expect(d.ledger.runningPending()).toBe(100n);
});

test("denies an over-cap payment and writes nothing to the ledger", async () => {
  const d = deps({
    readTreasury: async () => ({
      available: 50n,
      paused: false,
      allowlistEnabled: false,
      isAllowed: false,
    }),
  });
  const res = await authorizePayment(d, {
    payee,
    amount: 100n,
    resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
  expect(res).toMatchObject({ ok: false, reason: "over-cap" });
  expect(d.ledger.runningPending()).toBe(0n);
});

test("denies when guardian-paused", async () => {
  const d = deps({
    readTreasury: async () => ({
      available: 1_000n,
      paused: true,
      allowlistEnabled: false,
      isAllowed: false,
    }),
  });
  const res = await authorizePayment(d, {
    payee,
    amount: 10n,
    resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
  expect(res).toMatchObject({ ok: false, reason: "paused" });
});

test("denies a non-allowlisted payee (allowlist on) and writes nothing to the ledger", async () => {
  const d = deps({
    readTreasury: async () => ({
      available: 1_000n,
      paused: false,
      allowlistEnabled: true,
      isAllowed: false,
    }),
  });
  const res = await authorizePayment(d, {
    payee,
    amount: 10n,
    resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
  expect(res).toMatchObject({ ok: false, reason: "not-allowlisted" });
  expect(d.ledger.runningPending()).toBe(0n);
});

test("if signing fails after authorization, the ledger entry is marked failed and the error rethrows", async () => {
  const d = deps({
    signX402: async () => {
      throw new Error("signer unavailable");
    },
  });
  await expect(
    authorizePayment(d, {
      payee,
      amount: 100n,
      resource: "/x",
      asset: "0x3600000000000000000000000000000000000000",
      network: "eip155:5042002",
      maxTimeoutSeconds: 60,
    }),
  ).rejects.toThrow(/signer unavailable/);
  // recorded then rolled back to failed, so it no longer counts against the cap.
  expect(d.ledger.runningPending()).toBe(0n);
});

test("threads x402 requirements (asset/network/maxTimeoutSeconds) to signX402", async () => {
  let seen: unknown;
  const d = deps({
    signX402: async (req) => {
      seen = req;
      return { header: "h", ledgerRef: "r" };
    },
  });
  await authorizePayment(d, {
    payee,
    amount: 100n,
    resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
  expect(seen).toMatchObject({ network: "eip155:5042002", maxTimeoutSeconds: 60 });
});
