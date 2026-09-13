import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { PaymentLedger } from "../../src/payments/ledger";
import { migrate } from "../../src/persistence/db";

function freshLedger() {
  const db = new Database(":memory:");
  migrate(db);
  return new PaymentLedger(db);
}
const payee = "0x0000000000000000000000000000000000000abc" as const;

test("recordSettledOnNetwork inserts two settled Hedera rows with different refs", () => {
  const l = freshLedger();
  const first = l.recordSettledOnNetwork("entityA", payee, 100n, "hedera:testnet", "0.0.1@1.1");
  const second = l.recordSettledOnNetwork("entityA", payee, 200n, "hedera:testnet", "0.0.1@1.2");
  expect(first).toBeGreaterThan(0);
  expect(second).toBeGreaterThan(0);
  expect(second).not.toBe(first);
});

test("recordSettledOnNetwork throws on a duplicate (network, ref)", () => {
  const l = freshLedger();
  l.recordSettledOnNetwork("entityA", payee, 100n, "hedera:testnet", "0.0.1@1.1");
  expect(() =>
    l.recordSettledOnNetwork("entityA", payee, 100n, "hedera:testnet", "0.0.1@1.1"),
  ).toThrow(/UNIQUE/);
});

test("recordAuthorized still works with network NULL and runningPending counts it", () => {
  const l = freshLedger();
  const id = l.recordAuthorized("entityA", payee, 100n);
  expect(id).toBeGreaterThan(0);
  expect(l.runningPending("entityA")).toBe(100n);
});
