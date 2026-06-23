// backend/test/payments/sellerVerify.test.ts
import { Hono } from "hono";
import { expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { decodeX402Header, makeSignX402 } from "../../src/adapters/x402/signX402";
import { buildPaywall } from "../../src/payments/seller";

const KEY = `0x${"2".repeat(64)}` as const;
const payout = "0x00000000000000000000000000000000000000ab" as const;

async function makeHeader(amount: bigint) {
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(KEY),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  return (
    await signX402({
      payTo: payout,
      amount,
      asset: arcBatchingConfig.asset,
      network: arcBatchingConfig.network,
      maxTimeoutSeconds: 60,
    })
  ).header;
}

test("paywall: 402 without X-PAYMENT, 200 with a valid one, 402 on a forged/under-priced one", async () => {
  const app = new Hono();
  app.route(
    "/",
    buildPaywall({
      price: 50n,
      payTo: payout,
      asset: arcBatchingConfig.asset,
      network: arcBatchingConfig.network,
      serve: () => ({ answer: "synthesized insight" }),
    }),
  );

  const noPay = await app.request("/api/insight", { method: "GET" });
  expect(noPay.status).toBe(402);

  const ok = await app.request("/api/insight", {
    method: "GET",
    headers: { "X-PAYMENT": await makeHeader(50n) },
  });
  expect(ok.status).toBe(200);
  expect((await ok.json()).answer).toBe("synthesized insight");

  const underpriced = await app.request("/api/insight", {
    method: "GET",
    headers: { "X-PAYMENT": await makeHeader(1n) },
  });
  expect(underpriced.status).toBe(402);
});

test("paywall rejects a replayed (already-seen) X-PAYMENT with 402", async () => {
  const app = new Hono();
  app.route(
    "/",
    buildPaywall({
      price: 50n,
      payTo: payout,
      asset: arcBatchingConfig.asset,
      network: arcBatchingConfig.network,
      serve: () => ({ answer: "x" }),
    }),
  );
  const header = await makeHeader(50n);
  const first = await app.request("/api/insight", {
    method: "GET",
    headers: { "X-PAYMENT": header },
  });
  expect(first.status).toBe(200); // first use serves
  const second = await app.request("/api/insight", {
    method: "GET",
    headers: { "X-PAYMENT": header },
  });
  expect(second.status).toBe(402); // identical header replayed -> rejected
});

test("paywall rejects a tampered (forged) signature with 402", async () => {
  const app = new Hono();
  app.route(
    "/",
    buildPaywall({
      price: 50n,
      payTo: payout,
      asset: arcBatchingConfig.asset,
      network: arcBatchingConfig.network,
      serve: () => ({ answer: "x" }),
    }),
  );
  const good = await makeHeader(50n);
  const env = decodeX402Header(good);
  env.payload.signature = `0x${"11".repeat(65)}`; // valid length, wrong signature
  const forged = Buffer.from(JSON.stringify(env), "utf8").toString("base64");
  const res = await app.request("/api/insight", {
    method: "GET",
    headers: { "X-PAYMENT": forged },
  });
  expect(res.status).toBe(402);
});
