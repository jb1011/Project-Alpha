import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { PaymentLedger } from "../../src/payments/ledger";
import { buildAuthorityService } from "../../src/payments/service";
import { migrate } from "../../src/persistence/db";

const payee = "0x00000000000000000000000000000000000000ab" as const;
const usdc = "0x3600000000000000000000000000000000000000" as const;
function bodyFor(amount: string) {
  return JSON.stringify({
    payee,
    amount,
    resource: "/x",
    asset: usdc,
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
}

test("buildAuthorityService wires readTreasury + signX402 + ledger behind POST /authorize", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const ledger = new PaymentLedger(db);
  const { app } = buildAuthorityService({
    ledger,
    readTreasury: async () => ({
      available: 1_000n,
      paused: false,
      allowlistEnabled: false,
      isAllowed: true,
    }),
    signX402: async () => ({ header: "X-PAYMENT-real", ledgerRef: "nonce-1" }),
  });

  const ok = await app.request("/authorize", {
    method: "POST",
    body: bodyFor("100"),
    headers: { "content-type": "application/json" },
  });
  expect(ok.status).toBe(200);
  expect((await ok.json()).header).toBe("X-PAYMENT-real");
  expect(ledger.runningPending()).toBe(100n);

  const denied = await app.request("/authorize", {
    method: "POST",
    body: bodyFor("100000"),
    headers: { "content-type": "application/json" },
  });
  expect(denied.status).toBe(402);
});
