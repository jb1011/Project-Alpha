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

test("authorized entries count toward runningPending until settled", () => {
  const l = freshLedger();
  const id = l.recordAuthorized(payee, 100n);
  expect(l.runningPending()).toBe(100n);
  l.markSettled(id, "batch-1");
  expect(l.runningPending()).toBe(0n);
});

test("failed entries do not count toward runningPending", () => {
  const l = freshLedger();
  const id = l.recordAuthorized(payee, 50n);
  l.markFailed(id);
  expect(l.runningPending()).toBe(0n);
});

test("runningPending sums multiple authorized entries", () => {
  const l = freshLedger();
  l.recordAuthorized(payee, 100n);
  l.recordAuthorized(payee, 250n);
  expect(l.runningPending()).toBe(350n);
});

test("settling one of several entries only removes that one from pending", () => {
  const l = freshLedger();
  const first = l.recordAuthorized(payee, 100n);
  l.recordAuthorized(payee, 50n);
  l.markSettled(first, "batch-1");
  expect(l.runningPending()).toBe(50n);
});
