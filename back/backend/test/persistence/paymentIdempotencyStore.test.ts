import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type PaymentReceipt,
  SqlitePaymentIdempotencyStore,
} from "../../src/persistence/paymentIdempotencyStore";

let db: Database.Database;
let store: SqlitePaymentIdempotencyStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqlitePaymentIdempotencyStore(db);
});
afterEach(() => db.close());

test("first begin is new; complete then re-begin replays the receipt", () => {
  expect(store.begin("k1", "tA", "tA:e1")).toEqual({ status: "new" });
  const r: PaymentReceipt = { ok: true, txOrTransferId: "0xabc" };
  store.complete("k1", "tA", "tA:e1", r);
  expect(store.begin("k1", "tA", "tA:e1")).toEqual({ status: "replayed", receipt: r });
});

test("same key under a different tenant/entity is a distinct payment", () => {
  store.begin("k1", "tA", "tA:e1");
  store.complete("k1", "tA", "tA:e1", { ok: true, txOrTransferId: "0x1" });
  // scoped by (key,tenant,entity)
  expect(store.begin("k1", "tB", "tB:e1")).toEqual({ status: "new" });
});

test("begin twice without complete replays as a benign in-flight duplicate", () => {
  expect(store.begin("k2", "tA", "tA:e1")).toEqual({ status: "new" });
  expect(store.begin("k2", "tA", "tA:e1")).toEqual({
    status: "replayed",
    receipt: { ok: false, txOrTransferId: null, reason: "in-flight-duplicate" },
  });
});

test("release clears an in-flight claim so the same key can be retried", () => {
  expect(store.begin("k3", "tA", "tA:e1")).toEqual({ status: "new" });
  store.release("k3", "tA", "tA:e1");
  expect(store.begin("k3", "tA", "tA:e1")).toEqual({ status: "new" });
});

test("release never removes a completed receipt", () => {
  expect(store.begin("k4", "tA", "tA:e1")).toEqual({ status: "new" });
  const r: PaymentReceipt = { ok: true, txOrTransferId: "0xdef" };
  store.complete("k4", "tA", "tA:e1", r);
  store.release("k4", "tA", "tA:e1");
  expect(store.begin("k4", "tA", "tA:e1")).toEqual({ status: "replayed", receipt: r });
});
