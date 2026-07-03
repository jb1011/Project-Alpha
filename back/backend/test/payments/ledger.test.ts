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
  const id = l.recordAuthorized("entityA", payee, 100n);
  expect(l.runningPending("entityA")).toBe(100n);
  l.markSettled(id, "batch-1");
  expect(l.runningPending("entityA")).toBe(0n);
});

test("failed entries do not count toward runningPending", () => {
  const l = freshLedger();
  const id = l.recordAuthorized("entityA", payee, 50n);
  l.markFailed(id);
  expect(l.runningPending("entityA")).toBe(0n);
});

test("runningPending sums multiple authorized entries", () => {
  const l = freshLedger();
  l.recordAuthorized("entityA", payee, 100n);
  l.recordAuthorized("entityA", payee, 250n);
  expect(l.runningPending("entityA")).toBe(350n);
});

test("settling one of several entries only removes that one from pending", () => {
  const l = freshLedger();
  const first = l.recordAuthorized("entityA", payee, 100n);
  l.recordAuthorized("entityA", payee, 50n);
  l.markSettled(first, "batch-1");
  expect(l.runningPending("entityA")).toBe(50n);
});

test("runningPending is scoped per entity: entityB's authorized rows don't count toward entityA", () => {
  const l = freshLedger();
  l.recordAuthorized("entityA", payee, 100n);
  l.recordAuthorized("entityB", payee, 999n);
  expect(l.runningPending("entityA")).toBe(100n);
  expect(l.runningPending("entityB")).toBe(999n);
});

test("markSettled removes the row from its owning entity's runningPending only", () => {
  const l = freshLedger();
  const aId = l.recordAuthorized("entityA", payee, 100n);
  l.recordAuthorized("entityB", payee, 200n);
  l.markSettled(aId, "batch-1");
  expect(l.runningPending("entityA")).toBe(0n);
  expect(l.runningPending("entityB")).toBe(200n);
});
