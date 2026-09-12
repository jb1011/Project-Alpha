/**
 * `formation:reconcile` — the manual door onto the log-based resolver (B1 gate A5).
 *
 * The sweeper resolves stalled payments on its own schedule. This is for the row an operator is
 * looking at right now, and its contract is narrow on purpose: it runs the SAME
 * `resolveAuthorizationOutcome` the sweeper does, PRINTS what the chain said, and only then
 * writes. An operator deciding whether somebody has paid must not be handed a tool that flips a
 * row and says "done".
 *
 * What is asserted here is everything that happens BEFORE the chain is touched — the refusals
 * that stop an operator reaching for this command in the wrong situation. The resolver itself has
 * its own tests (test/adapters/arc/usdcToken.test.ts) and its live behaviour is covered by the
 * sweeper's (test/workflow/formationSweeperPayments.test.ts); duplicating a fake chain through
 * a CLI process boundary would test the fake.
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

const REVENUE = "0x000000000000000000000000000000000000bEEF" as Address;
const TX = `0x${"cc".repeat(32)}` as Hex;

let dir: string;
let dbPath: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  dbPath = join(dir, "legalbody.db");
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const run = (args: string[]) =>
  buildCli(() => {
    throw new Error("this command must not build a chain context");
  }).parseAsync(["node", "cli", ...args]);

function seed(status: "quoted" | "settled"): { companyId: string; paymentId: string } {
  const db = openDatabase(dbPath);
  migrate(db);
  const companies = new SqliteCompanyRepository(db);
  const payments = new SqliteFormationPaymentRepository(db);
  const companyId = companies.create({
    tenantId: "0x000000000000000000000000000000000000000A",
    status: status === "settled" ? "ready" : "draft",
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
    payments.markSettled(paymentId, TX);
  }
  db.close();
  return { companyId, paymentId };
}

test("an unknown payment is refused by name", async () => {
  seed("quoted");
  await expect(run(["formation:reconcile", "does-not-exist"])).rejects.toThrow(
    /no payment does-not-exist/,
  );
});

test("a TERMINAL row is refused, and the refusal says what it already is", async () => {
  // Reconciling a settled payment could only ever re-write a hash we already hold, and asking the
  // chain about it costs an operator a wait for an answer that changes nothing. The refusal names
  // the status and the settlement hash so they can see they are looking at a finished payment.
  const { paymentId } = seed("settled");
  await expect(run(["formation:reconcile", paymentId])).rejects.toThrow(
    new RegExp(`already terminal \\(settled\\) at ${TX}`),
  );
});
