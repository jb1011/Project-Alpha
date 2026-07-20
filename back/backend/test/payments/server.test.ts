import { expect, test } from "vitest";
import type { AuthorityDeps } from "../../src/payments/authority";
import { buildAuthorityApp } from "../../src/payments/server";

const payee = "0x0000000000000000000000000000000000000abc";
// Structural fake of PaymentLedger — the route only needs these four methods.
const fakeLedger = {
  runningPending: (_entityKey: string) => 0n,
  recordAuthorized: (_entityKey: string) => 1,
  markFailed: () => {},
  markSettled: () => {},
} as unknown as AuthorityDeps["ledger"];

function post(app: ReturnType<typeof buildAuthorityApp>, amount: string) {
  return app.request("/authorize", {
    method: "POST",
    body: JSON.stringify({
      payee,
      amount,
      resource: "/x",
      asset: "0x3600000000000000000000000000000000000000",
      network: "eip155:5042002",
    }),
    headers: { "content-type": "application/json" },
  });
}

test("POST /authorize returns 200 + X-PAYMENT when policy allows", async () => {
  const app = buildAuthorityApp({
    ledger: fakeLedger,
    entityKey: "entityA",
    readTreasury: async () => ({
      available: 1_000n,
      paused: false,
      allowlistEnabled: false,
      isAllowed: true,
      legalActive: true,
    }),
    signX402: async () => ({ header: "X-PAYMENT-ok", ledgerRef: "r" }),
  });
  const res = await post(app, "100");
  expect(res.status).toBe(200);
  expect((await res.json()).header).toBe("X-PAYMENT-ok");
});

test("POST /authorize returns 402 + reason when policy denies (over-cap)", async () => {
  const app = buildAuthorityApp({
    ledger: fakeLedger,
    entityKey: "entityA",
    readTreasury: async () => ({
      available: 1_000n,
      paused: false,
      allowlistEnabled: false,
      isAllowed: true,
      legalActive: true,
    }),
    signX402: async () => ({ header: "X-PAYMENT-ok", ledgerRef: "r" }),
  });
  const res = await post(app, "100000");
  expect(res.status).toBe(402);
  expect(await res.json()).toMatchObject({ error: "policy-denied", reason: "over-cap" });
});
