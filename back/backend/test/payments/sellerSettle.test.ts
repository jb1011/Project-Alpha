// backend/test/payments/sellerSettle.test.ts
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { buildPaywall } from "../../src/payments/seller";

const KEY = `0x${"2".repeat(64)}` as const;
const payout = "0x00000000000000000000000000000000000000ab" as const;
async function header(amount: bigint) {
  const s = makeSignX402({
    signer: pocketSignerFromKey(KEY),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  return (
    await s({
      payTo: payout,
      amount,
      asset: arcBatchingConfig.asset,
      network: arcBatchingConfig.network,
      maxTimeoutSeconds: 600,
    })
  ).header;
}
const cfgBase = {
  price: 50n,
  payTo: payout,
  asset: arcBatchingConfig.asset,
  network: arcBatchingConfig.network,
  serve: () => ({ answer: "x" }),
};

test("when settle is configured, a paid request settles then serves", async () => {
  const settle = vi.fn(async () => ({ ok: true as const, transferId: "t1" }));
  const app = new Hono();
  app.route("/", buildPaywall({ ...cfgBase, settle, resourceUrl: "https://insight.local/x" }));
  const res = await app.request("/api/insight", { headers: { "X-PAYMENT": await header(50n) } });
  expect(res.status).toBe(200);
  expect(settle).toHaveBeenCalledTimes(1);
});

test("a settle failure rejects with 402 and does not serve", async () => {
  const settle = vi.fn(async () => ({ ok: false as const, reason: "insufficient_balance" }));
  const served = vi.fn(() => ({ answer: "x" }));
  const app = new Hono();
  app.route("/", buildPaywall({ ...cfgBase, serve: served, settle }));
  const res = await app.request("/api/insight", { headers: { "X-PAYMENT": await header(50n) } });
  expect(res.status).toBe(402);
  expect(served).not.toHaveBeenCalled();
});
