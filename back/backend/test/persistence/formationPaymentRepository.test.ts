/**
 * The payment row's whole life (design 2026-08-26 §2/§6).
 *
 * Every transition here is a CAS, because three actors can reach one row: the settle route, the
 * sweeper's resume leg, and an operator at a CLI. The tests below are the argument that a loser
 * of any of those races does nothing rather than something wrong.
 */
import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate } from "../../src/persistence/db";
import {
  type FormationPaymentRepository,
  SqliteFormationPaymentRepository,
} from "../../src/persistence/formationPaymentRepository";
import type { Address, Hex } from "../../src/types";

const NONCE = `0x${"a1".repeat(32)}` as Hex;
const NONCE2 = `0x${"b2".repeat(32)}` as Hex;
const PAYER = "0x00000000000000000000000000000000000000Ab" as Address;
const PAY_TO = "0x000000000000000000000000000000000000bEEF" as Address;
/** A 65-byte EIP-3009 signature, in the shape the token takes. */
const SIG = `0x${"11".repeat(65)}` as Hex;
const TX = `0x${"cc".repeat(32)}` as Hex;

let db: Database.Database;
let payments: FormationPaymentRepository;
let companies: SqliteCompanyRepository;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  payments = new SqliteFormationPaymentRepository(db);
  companies = new SqliteCompanyRepository(db);
});

function company(): string {
  return companies.create({
    tenantId: "0xT",
    status: "draft",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: [{ name: "Acme", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "software",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
}

function quote(companyId: string, over: Partial<{ nonce: Hex; validBefore: number }> = {}) {
  return payments.create({
    companyId,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce: over.nonce ?? NONCE,
    validBefore: over.validBefore ?? 2_000_000_000,
    payTo: PAY_TO,
  });
}

test("a quote round-trips with its amount as a bigint and its nonce intact", () => {
  const c = company();
  const id = quote(c);
  const row = payments.find(id);
  expect(row).toMatchObject({
    companyId: c,
    product: "formation",
    status: "quoted",
    amountUsdc: 399_000_000n,
    nonce: NONCE,
    validBefore: 2_000_000_000,
    // The PAYEE, pinned at quote time (B1 gate A1) — nothing downstream reads it from config.
    payTo: PAY_TO,
    payerAddress: null,
    signature: null,
    txHash: null,
    broadcastCount: 0,
    attempt: 0,
    refundTxHash: null,
  });
});

test("at most ONE live quote per (company, product) — the index, not a check in code", () => {
  const c = company();
  quote(c);
  expect(() => quote(c, { nonce: NONCE2 })).toThrow(/UNIQUE/i);
});

test("a maintenance_year quote is insertable BESIDE a live formation one (§2 finding 11)", () => {
  const c = company();
  quote(c);
  const maintenance = payments.create({
    companyId: c,
    product: "maintenance_year",
    amountUsdc: 99_000_000n,
    nonce: NONCE2,
    validBefore: 2_000_000_000,
    payTo: PAY_TO,
  });
  expect(payments.find(maintenance)?.product).toBe("maintenance_year");
  expect(payments.findLive(c, "formation")?.product).toBe("formation");
});

test("a TERMINAL row does not forbid the re-quote that follows it — two steps, new nonce", () => {
  const c = company();
  const first = quote(c);
  // Re-quote is deliberately two-step (§6.4): the old row must be terminal FIRST.
  expect(() => quote(c, { nonce: NONCE2 })).toThrow(/UNIQUE/i);
  expect(payments.markExpired(first, "quoted")).toBe(true);
  const second = quote(c, { nonce: NONCE2 });
  expect(payments.findLive(c, "formation")?.paymentId).toBe(second);
  // …and the old row is still readable, which is what makes the history auditable.
  expect(payments.listByCompany(c)).toHaveLength(2);
});

test("markSettling persists the AUTHORIZATION and the payer, and only from `quoted`", () => {
  const c = company();
  const id = quote(c);
  expect(payments.markSettling(id, { payerAddress: PAYER, signature: SIG })).toBe(true);
  expect(payments.find(id)).toMatchObject({
    status: "settling",
    payerAddress: PAYER,
    signature: SIG,
    // NOT a hash: nothing has been broadcast yet, and the hash is not the durable artifact.
    txHash: null,
    broadcastCount: 0,
  });
  // A SECOND settle for the same quote loses the CAS: one broadcast, one refusal, never two
  // transfers of the guardian's money.
  expect(payments.markSettling(id, { payerAddress: PAYER, signature: SIG })).toBe(false);
});

test("recordBroadcast counts the attempts and keeps the LAST hash, on settling rows only", () => {
  // The hash is a pointer for a human, not an outcome, and the count is the fee-bump ladder. A
  // broadcast against a terminal row is a bug we would rather not record.
  const c = company();
  const id = quote(c);
  expect(payments.recordBroadcast(id, TX)).toBe(false); // still `quoted`
  payments.markSettling(id, { payerAddress: PAYER, signature: SIG });
  expect(payments.recordBroadcast(id, TX)).toBe(true);
  const second = `0x${"dd".repeat(32)}` as Hex;
  expect(payments.recordBroadcast(id, second)).toBe(true);
  expect(payments.find(id)).toMatchObject({ txHash: second, broadcastCount: 2 });
  payments.markSettled(id, second);
  expect(payments.recordBroadcast(id, TX)).toBe(false);
});

test("the guardian's signature survives the round trip byte for byte", () => {
  // It is the only thing that makes a crash mid-settle recoverable: a resume composes a FRESH
  // executor transaction around these exact bytes. A lossy round trip would silently turn resume
  // into re-quote, which is the double charge.
  const c = company();
  const id = quote(c);
  payments.markSettling(id, { payerAddress: PAYER, signature: SIG });
  expect(payments.find(id)?.signature).toBe(SIG);
});

test("settled only from settling; failed only from settling; expired names what it leaves", () => {
  const c = company();
  const id = quote(c);
  // A quote cannot jump straight to settled — nothing was broadcast.
  expect(payments.markSettled(id, TX)).toBe(false);
  expect(payments.markFailed(id)).toBe(false);
  payments.markSettling(id, { payerAddress: PAYER, signature: SIG });
  // …and the sweeper's expiry cannot land on a row the settle route just moved: it names
  // `quoted`, and the row is `settling`.
  expect(payments.markExpired(id, "quoted")).toBe(false);
  expect(payments.markSettled(id, TX)).toBe(true);
  expect(payments.find(id)?.status).toBe("settled");
  // Terminal is terminal: nothing re-opens a settled payment.
  expect(payments.markFailed(id)).toBe(false);
  expect(payments.markExpired(id, "settling")).toBe(false);
});

test("a refund is RECORDED once, only over a settled row, and never twice", () => {
  const c = company();
  const id = quote(c);
  expect(payments.markRefunded(id, "0xledger")).toBe(false); // not settled yet
  payments.markSettling(id, { payerAddress: PAYER, signature: SIG });
  payments.markSettled(id, TX);
  expect(payments.markRefunded(id, "0xledger")).toBe(true);
  expect(payments.find(id)).toMatchObject({ status: "refunded", refundTxHash: "0xledger" });
  // A second recording would overwrite the only pointer we hold to the money that moved.
  expect(payments.markRefunded(id, "0xother")).toBe(false);
  expect(payments.find(id)?.refundTxHash).toBe("0xledger");
});

test("bumpAttempt burns an attempt and leaves the status alone — the broadcast is still live", () => {
  const c = company();
  const id = quote(c);
  payments.markSettling(id, { payerAddress: PAYER, signature: SIG });
  expect(payments.bumpAttempt(id)).toBe(1);
  expect(payments.bumpAttempt(id)).toBe(2);
  expect(payments.find(id)?.status).toBe("settling");
});

test("findCurrent answers the live row, and after it settles, what happened", () => {
  const c = company();
  expect(payments.findCurrent(c, "formation")).toBeUndefined();
  const id = quote(c);
  expect(payments.findCurrent(c, "formation")?.paymentId).toBe(id);
  payments.markSettling(id, { payerAddress: PAYER, signature: SIG });
  payments.markSettled(id, TX);
  // A route that answered only "what do I owe?" would tell a guardian whose payment just settled
  // that they have no payment at all.
  expect(payments.findCurrent(c, "formation")).toMatchObject({ paymentId: id, status: "settled" });
});

test("the sweeper's readers: settling rows, and quotes whose clock has run out", () => {
  const c1 = company();
  const c2 = company();
  const stalling = quote(c1);
  payments.markSettling(stalling, { payerAddress: PAYER, signature: SIG });
  const stale = payments.create({
    companyId: c2,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce: NONCE2,
    validBefore: 1_000,
    payTo: PAY_TO,
  });
  expect(payments.listByStatus("settling").map((r) => r.paymentId)).toEqual([stalling]);
  expect(payments.listExpiredQuotes(2_000).map((r) => r.paymentId)).toEqual([stale]);
  // …and not before the clock: `valid_before` in the future is not expirable.
  expect(payments.listExpiredQuotes(999)).toEqual([]);
});

test("`hasLivePayment` reads these rows and nothing else — quoted and settling only", async () => {
  const { hasLivePayment } = await import("../../src/formation/status");
  const c = company();
  expect(hasLivePayment(companies, c)).toBe(false);
  const id = quote(c);
  expect(hasLivePayment(companies, c)).toBe(true);
  payments.markSettling(id, { payerAddress: PAYER, signature: SIG });
  expect(hasLivePayment(companies, c)).toBe(true);
  payments.markSettled(id, TX);
  // Settled is not live. The derived predicate needs no second write to say so — which is the
  // whole reason "paying" is not a column.
  expect(hasLivePayment(companies, c)).toBe(false);
});
