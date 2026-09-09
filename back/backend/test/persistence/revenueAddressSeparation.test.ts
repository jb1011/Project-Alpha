/**
 * The DB half of the revenue-address separation invariant (design 2026-08-26 §6.6).
 *
 * `config/env.ts` refuses a revenue address equal to the executor or to any key in the fixed env
 * set. Only the DATABASE knows the other half of "every platform key": the per-agent operator
 * addresses, the ones rotated away from, and the pockets derived from the master seed. Paying the
 * formation fee into one of those would look exactly like a successful payment while leaving the
 * money on a wallet this box can sign for — which is the opposite of the receive-only Ledger the
 * revenue address is.
 */
import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { assertRevenueAddressSeparation } from "../../src/persistence/tier0";

const LEDGER = "0x000000000000000000000000000000000000bEEF";
const OPERATOR = "0x000000000000000000000000000000000000000C";
const OLD_OPERATOR = "0x000000000000000000000000000000000000000D";
const POCKET = "0x000000000000000000000000000000000000000E";

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});

function seed(over: Record<string, unknown> = {}) {
  repo.upsert({
    idempotencyKey: "t:a1",
    name: "a1",
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: "0x000000000000000000000000000000000000000B",
    operator: OPERATOR,
    amendmentDelay: "0",
    ein: "",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: null,
    proxy: null,
    treasury: null,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: "0xT",
    ...over,
  } as never);
}

test("a deployment that does not charge is never asked the question", () => {
  seed();
  expect(() =>
    assertRevenueAddressSeparation(db, { required: false, revenueAddress: OPERATOR }),
  ).not.toThrow();
});

test("a genuine Ledger address passes with a fleet in the database", () => {
  seed();
  expect(() =>
    assertRevenueAddressSeparation(db, { required: true, revenueAddress: LEDGER }),
  ).not.toThrow();
});

test("refuses an address that is a LIVE agent operator", () => {
  seed();
  expect(() =>
    assertRevenueAddressSeparation(db, { required: true, revenueAddress: OPERATOR }),
  ).toThrow(/operator or pocket address/);
});

test("refuses an address this deployment has ROTATED AWAY from — the key existed here", () => {
  seed({ previousOperator: OLD_OPERATOR });
  expect(() =>
    assertRevenueAddressSeparation(db, { required: true, revenueAddress: OLD_OPERATOR }),
  ).toThrow(/operator or pocket address/);
});

test("refuses a POCKET address — derived from a seed that is still on the box", () => {
  seed({ pocketAddress: POCKET });
  expect(() =>
    assertRevenueAddressSeparation(db, { required: true, revenueAddress: POCKET }),
  ).toThrow(/operator or pocket address/);
});

test("the comparison is case-insensitive: stored checksummed, configured lowercase", () => {
  // SQLite's default `=` on TEXT is case-SENSITIVE. A miss here would PASS the check and lose the
  // money, which is why the comparison and the index are both NOCASE.
  seed();
  expect(() =>
    assertRevenueAddressSeparation(db, {
      required: true,
      revenueAddress: OPERATOR.toLowerCase(),
    }),
  ).toThrow(/operator or pocket address/);
});

test("the three arms are answered by an INDEXED lookup, not a fleet scan (§6.6)", () => {
  // The design asks for this in as many words: a thousand-agent deployment must not read a
  // thousand rows to answer a yes/no question at every boot. Asserted through the QUERY PLAN,
  // because "fast enough today" is not a property that survives a growing fleet — and because the
  // obvious spelling of the case-insensitive comparison (`LOWER(operator) = ?`) silently turns
  // this back into a scan by putting a function on the indexed side. `COLLATE NOCASE` on both the
  // index and the comparison is the spelling that is correct AND indexed.
  seed({ previousOperator: OLD_OPERATOR, pocketAddress: POCKET });
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT 1 FROM entities
        WHERE operator = ? COLLATE NOCASE
           OR previous_operator = ? COLLATE NOCASE
           OR pocket_address = ? COLLATE NOCASE
        LIMIT 1`,
    )
    .all("a", "a", "a") as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).not.toMatch(/SCAN entities/);
  expect(detail).toMatch(/idx_entities_operator_addr/);
  expect(detail).toMatch(/idx_entities_previous_operator_addr/);
  expect(detail).toMatch(/idx_entities_pocket_addr/);
});

test("ANY casing matches — including one that is neither checksummed nor lowercase", () => {
  // The version this replaces named the two casings it expected (`IN (checksummed, lower)`) and
  // silently missed a third, which is the failure mode that matters here: a miss PASSES the
  // check and the fee lands on a wallet this box can sign for.
  seed({ operator: "0x000000000000000000000000000000000000000c" });
  expect(() =>
    assertRevenueAddressSeparation(db, { required: true, revenueAddress: OPERATOR }),
  ).toThrow(/operator or pocket address/);
});
