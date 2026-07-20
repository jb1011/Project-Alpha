// backend/test/payments/e2e.int.test.ts
import Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { authorizePayment } from "../../src/payments/authority";
import { buyWithX402 } from "../../src/payments/buyer";
import { PaymentLedger } from "../../src/payments/ledger";
import { buildPaywall } from "../../src/payments/seller";
import { migrate } from "../../src/persistence/db";

const KEY = `0x${"2".repeat(64)}` as const;
const payout = privateKeyToAccount(`0x${"1".repeat(64)}`).address;

function makeStack(available: bigint) {
  const seller = buildPaywall({
    price: 50n,
    payTo: payout,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    serve: () => ({ answer: "synthesized insight" }),
  });
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(KEY),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  const db = new Database(":memory:");
  migrate(db);
  const deps = {
    ledger: new PaymentLedger(db),
    entityKey: "entityA",
    readTreasury: async () => ({
      available,
      paused: false,
      allowlistEnabled: false,
      isAllowed: true,
      legalActive: true,
    }),
    signX402: async (req: {
      payee: `0x${string}`;
      amount: bigint;
      asset: `0x${string}`;
      network: string;
      maxTimeoutSeconds: number;
    }) =>
      signX402({
        payTo: req.payee,
        amount: req.amount,
        asset: req.asset,
        network: req.network,
        maxTimeoutSeconds: req.maxTimeoutSeconds,
      }),
  };
  const fetchImpl = ((url: string, init?: RequestInit) =>
    seller.request(url, init)) as unknown as typeof fetch;
  const authorize = async (r: Parameters<typeof authorizePayment>[1]) =>
    authorizePayment(deps as never, r);
  return { fetchImpl, authorize };
}

test("a within-policy query buys -> serves the insight", async () => {
  const { fetchImpl, authorize } = makeStack(1_000n);
  const res = await buyWithX402({ fetchImpl, authorize }, "/api/insight");
  expect(res.status).toBe(200);
  expect((await res.json()).answer).toBe("synthesized insight");
});

test("an over-cap query is denied at the Authority (killer moment, no settlement)", async () => {
  const { fetchImpl, authorize } = makeStack(10n); // available < price
  await expect(buyWithX402({ fetchImpl, authorize }, "/api/insight")).rejects.toThrow(
    /policy-denied: over-cap/,
  );
});
