/**
 * The DB half of the payment-address separation invariants (design 2026-08-26 §6.6, B1 gate A2).
 *
 * `config/env.ts` refuses a revenue address or a settle submitter equal to the platform key or to
 * any key in the fixed env set. Only the DATABASE knows the other half of "every platform key":
 * the per-agent operator addresses, the ones rotated away from, and the pockets derived from the
 * master seed.
 *
 * Paying the formation fee into one of those would look exactly like a successful payment while
 * leaving the money on a wallet this box can sign for — the opposite of the receive-only Ledger
 * the revenue address is. And SUBMITTING from one of them puts a guardian's settle back into a
 * nonce space shared with agent operations, which is precisely what a dedicated submitter exists
 * to escape.
 */
import Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { assertPaymentAddressSeparation } from "../../src/persistence/tier0";

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
    assertPaymentAddressSeparation(db, { required: false, revenueAddress: OPERATOR }),
  ).not.toThrow();
});

test("a genuine Ledger address passes with a fleet in the database", () => {
  seed();
  expect(() =>
    assertPaymentAddressSeparation(db, { required: true, revenueAddress: LEDGER }),
  ).not.toThrow();
});

test("refuses an address that is a LIVE agent operator", () => {
  seed();
  expect(() =>
    assertPaymentAddressSeparation(db, { required: true, revenueAddress: OPERATOR }),
  ).toThrow(/operator or pocket address/);
});

test("refuses an address this deployment has ROTATED AWAY from — the key existed here", () => {
  seed({ previousOperator: OLD_OPERATOR });
  expect(() =>
    assertPaymentAddressSeparation(db, { required: true, revenueAddress: OLD_OPERATOR }),
  ).toThrow(/operator or pocket address/);
});

test("refuses a POCKET address — derived from a seed that is still on the box", () => {
  seed({ pocketAddress: POCKET });
  expect(() =>
    assertPaymentAddressSeparation(db, { required: true, revenueAddress: POCKET }),
  ).toThrow(/operator or pocket address/);
});

test("the comparison is case-insensitive: stored checksummed, configured lowercase", () => {
  // SQLite's default `=` on TEXT is case-SENSITIVE. A miss here would PASS the check and lose the
  // money, which is why the comparison and the index are both NOCASE.
  seed();
  expect(() =>
    assertPaymentAddressSeparation(db, {
      required: true,
      revenueAddress: OPERATOR.toLowerCase(),
    }),
  ).toThrow(/operator or pocket address/);
});

test("the check may SCAN, and that is the trade it should make (finding B4)", () => {
  // It used to be backed by three partial indexes on `entities`, asserted here through the query
  // plan. They are gone: this question is asked ONCE, at boot, on a deployment that charges,
  // where an index is paid for on every write to that table forever on every deployment. What
  // matters is that the ANSWER is right — so that is what is asserted, at every arm — and the
  // plan is allowed to be whatever SQLite decides.
  seed({ previousOperator: OLD_OPERATOR, pocketAddress: POCKET });
  for (const address of [OPERATOR, OLD_OPERATOR, POCKET])
    expect(() =>
      assertPaymentAddressSeparation(db, { required: true, revenueAddress: address }),
    ).toThrow(/operator or pocket address/);
  expect(() =>
    assertPaymentAddressSeparation(db, { required: true, revenueAddress: LEDGER }),
  ).not.toThrow();
  // …and the indexes really are gone, so nothing pays for them on the write path.
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities'")
    .all() as { name: string }[];
  expect(indexes.map((i) => i.name)).not.toContain("idx_entities_operator_addr");
});

test("ANY casing matches — including one that is neither checksummed nor lowercase", () => {
  // The version this replaces named the two casings it expected (`IN (checksummed, lower)`) and
  // silently missed a third, which is the failure mode that matters here: a miss PASSES the
  // check and the fee lands on a wallet this box can sign for.
  seed({ operator: "0x000000000000000000000000000000000000000c" });
  expect(() =>
    assertPaymentAddressSeparation(db, { required: true, revenueAddress: OPERATOR }),
  ).toThrow(/operator or pocket address/);
});

// ── the SUBMITTER arm (B1 gate A2) ──────────────────────────────────────────────────────────

const SUBMITTER_KEY = `0x${"9".repeat(64)}` as const;

test("a submitter key whose address the fleet already uses is refused", () => {
  seed({ operator: privateKeyToAccount(SUBMITTER_KEY).address });
  expect(() =>
    assertPaymentAddressSeparation(db, {
      required: true,
      revenueAddress: LEDGER,
      submitterKey: SUBMITTER_KEY,
    }),
  ).toThrow(/own nonce space/);
});

test("a dedicated submitter passes with a fleet in the database", () => {
  seed();
  expect(() =>
    assertPaymentAddressSeparation(db, {
      required: true,
      revenueAddress: LEDGER,
      submitterKey: SUBMITTER_KEY,
    }),
  ).not.toThrow();
});
