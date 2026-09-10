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

/**
 * ── THE FOUR REFUSALS, THROUGH THE PAYWALL (finding B10) ────────────────────────────────────
 *
 * The x402 rail's verifier was extracted so the formation rail could share it (design §6.3), and
 * that extraction added a FIFTH check to a path that had four: `validAfter <= now`. This pins the
 * new refusal through the real door and pins the other three beside it, because the risk of
 * sharing a verifier is not that the new rail is wrong — it is that the OLD one changes shape
 * without anybody deciding to change it.
 *
 * Each is asserted by the `reason` in the 402 body, not merely the status, since every refusal
 * here is a 402 and a status assertion would pass while the answer silently became a different
 * one.
 */
function paywall() {
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
  return app;
}

/** Re-encode a valid envelope with one field of the AUTHORIZATION changed. The signature no
 *  longer matches — which is fine and is the point: the window checks run BEFORE the recovery, so
 *  each of them is reachable and each names itself. */
async function tampered(edit: (a: Record<string, string>) => void): Promise<string> {
  const env = decodeX402Header(await makeHeader(50n));
  edit(env.payload.authorization as unknown as Record<string, string>);
  return Buffer.from(JSON.stringify(env), "utf8").toString("base64");
}

async function refusal(header: string): Promise<string> {
  const res = await paywall().request("/api/insight", {
    method: "GET",
    headers: { "X-PAYMENT": header },
  });
  expect(res.status).toBe(402);
  return ((await res.json()) as { error?: string }).error ?? "";
}

test("NEW: an authorization that is NOT YET VALID is refused as such", async () => {
  // It would revert on-chain, and answering "verified" for one is a promise the executor cannot
  // keep. Before the shared verifier this check did not exist on this rail at all.
  const future = String(Math.floor(Date.now() / 1000) + 3600);
  expect(
    await refusal(
      await tampered((a) => {
        a.validAfter = future;
      }),
    ),
  ).toBe("not-yet-valid");
});

test("UNCHANGED: under-priced, expired and forged still refuse by their own names", async () => {
  expect(await refusal(await makeHeader(1n))).toBe("underpriced");

  const past = String(Math.floor(Date.now() / 1000) - 3600);
  expect(
    await refusal(
      await tampered((a) => {
        a.validBefore = past;
      }),
    ),
  ).toBe("expired");

  const env = decodeX402Header(await makeHeader(50n));
  env.payload.signature = `0x${"11".repeat(65)}`;
  expect(await refusal(Buffer.from(JSON.stringify(env), "utf8").toString("base64"))).toBe(
    "bad-signature",
  );

  // …and the amount rule is still a FLOOR on this rail: over-paying a paywall is allowed, where
  // the formation rail's `exact` mode refuses it.
  const over = await paywall().request("/api/insight", {
    method: "GET",
    headers: { "X-PAYMENT": await makeHeader(500n) },
  });
  expect(over.status).toBe(200);
});
