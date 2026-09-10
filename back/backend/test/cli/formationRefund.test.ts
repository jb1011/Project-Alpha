/**
 * `formation:refund` — the command that RECORDS a refund and moves nothing (design §6.6, B1 gate
 * A5).
 *
 * Three properties, and the first two are about what the command does NOT do:
 *
 *  1. it moves no money. `FORMATION_REVENUE_ADDRESS` is a Ledger account with no key on the box,
 *     so a human signs the transfer at the device and this command tells the system it happened;
 *  2. it never enters `platform_outflows`. A 399 USDC row in the S5 meter would exceed the 200
 *     USDC rolling ceiling on its own and block every agent's treasury funding, gas seeds and job
 *     funding for 24 hours — a refund taking the fleet down with it;
 *  3. it NAMES THE PAYMENT and asks for confirmation. "The most recent settled row for this
 *     company" is exactly the wrong default for the case this command is for — a company with two
 *     settled rows IS the double charge, and picking one by date is a guess made silently at a
 *     Ledger about somebody's 399 USDC.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildCli } from "../../src/cli/index";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import type { Address, Hex } from "../../src/types";

const LEDGER_TX = `0x${"fe".repeat(32)}`;
const TX = `0x${"cc".repeat(32)}` as Hex;

let dir: string;
let dbPath: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "refund-"));
  dbPath = join(dir, "legalbody.db");
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const REVENUE = "0x000000000000000000000000000000000000bEEF" as Address;

const run = (args: string[]) =>
  buildCli(() => {
    throw new Error("this command must not build a chain context");
  }).parseAsync(["node", "cli", ...args]);

/** A database on disk holding one company and one payment in the given state. */
function seed(status: "settled" | "quoted"): { companyId: string; paymentId: string } {
  const db = openDatabase(dbPath);
  migrate(db);
  const companies = new SqliteCompanyRepository(db);
  const payments = new SqliteFormationPaymentRepository(db);
  const companyId = companies.create({
    tenantId: "0x000000000000000000000000000000000000000A",
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: [{ name: "Acme", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "software",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
  const paymentId = payments.create({
    companyId,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce: `0x${"a1".repeat(32)}` as Hex,
    validBefore: 2_000_000_000,
    payTo: REVENUE,
  });
  if (status === "settled") {
    payments.markSettling(paymentId, {
      payerAddress: "0x000000000000000000000000000000000000000A",
      signature: `0x${"11".repeat(65)}`,
    });
    payments.recordBroadcast(paymentId, {
      txHash: TX,
      nonce: 1,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    payments.markSettled(paymentId, TX);
  }
  db.close();
  return { companyId, paymentId };
}

function reopen() {
  const db = openDatabase(dbPath);
  return { db, payments: new SqliteFormationPaymentRepository(db) };
}

test("it records the refund on the NAMED payment, with the Ledger hash", async () => {
  const { paymentId } = seed("settled");
  await run(["formation:refund", "--payment-id", paymentId, "--tx", LEDGER_TX, "--yes"]);
  const { db, payments } = reopen();
  expect(payments.find(paymentId)).toMatchObject({
    status: "refunded",
    refundTxHash: LEDGER_TX,
    // The settlement hash SURVIVES: the two together are the whole audit trail of a fee taken
    // and given back.
    txHash: TX,
  });
  db.close();
});

test("THE S5 METER IS UNTOUCHED — a refund is not a platform outflow (§6.6)", async () => {
  const { paymentId } = seed("settled");
  await run(["formation:refund", "--payment-id", paymentId, "--tx", LEDGER_TX, "--yes"]);
  const { db } = reopen();
  const outflows = db.prepare("SELECT COUNT(*) AS n FROM platform_outflows").get() as { n: number };
  expect(outflows.n).toBe(0);
  db.close();
});

test("it refuses a payment that is not settled, and points at reconcile", async () => {
  const { paymentId } = seed("quoted");
  await expect(
    run(["formation:refund", "--payment-id", paymentId, "--tx", LEDGER_TX, "--yes"]),
  ).rejects.toThrow(/not settled.*formation:reconcile/s);
});

test("⚠ WITHOUT --yes it prints the row and records NOTHING", async () => {
  // The confirmation is not ceremony. The operator has just signed a transfer at a hardware
  // wallet and is about to write the only pointer we will ever hold to it; seeing which payment,
  // whose wallet and how much BEFORE the write is the point of the command.
  const { paymentId } = seed("settled");
  await run(["formation:refund", "--payment-id", paymentId, "--tx", LEDGER_TX]);
  const { db, payments } = reopen();
  expect(payments.find(paymentId)?.status).toBe("settled");
  db.close();
});

test("⚠ a MALFORMED hash is refused — it is the only record of the transfer", async () => {
  // A truncated paste reads perfectly plausibly and is unrecoverable: the money has moved and the
  // pointer to it is wrong, once and forever.
  const { paymentId } = seed("settled");
  for (const bad of ["0xdeadbeef", `0x${"fe".repeat(31)}`, "not-a-hash"])
    await expect(
      run(["formation:refund", "--payment-id", paymentId, "--tx", bad, "--yes"]),
    ).rejects.toThrow(/not a 32-byte transaction hash/);
});

test("it refuses a SECOND recording — the first hash is the only pointer we hold", async () => {
  const { companyId, paymentId } = seed("settled");
  await run(["formation:refund", "--payment-id", paymentId, "--tx", LEDGER_TX, "--yes"]);
  // …and the refusal NAMES the hash already on the row. "no settled payment" would read as "your
  // refund was never registered", and an operator would go and make a second one.
  await expect(
    run(["formation:refund", "--payment-id", paymentId, "--tx", `0x${"11".repeat(32)}`, "--yes"]),
  ).rejects.toThrow(new RegExp(`ALREADY recorded as refunded \\(tx ${LEDGER_TX}\\)`));
  const { db, payments } = reopen();
  expect(payments.listByCompany(companyId)[0]?.refundTxHash).toBe(LEDGER_TX);
  db.close();
});

test("an unknown payment is refused rather than silently doing nothing", async () => {
  seed("settled");
  await expect(
    run(["formation:refund", "--payment-id", "does-not-exist", "--tx", LEDGER_TX, "--yes"]),
  ).rejects.toThrow(/no payment does-not-exist/);
});
