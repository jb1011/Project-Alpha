/**
 * THE FREEZE PREDICATE, ASSERTED IN BOTH SPELLINGS (design 2026-08-26 §4.5/§4.7).
 *
 * `INTAKE_FROZEN_SQL` is what the `UPDATE companies` carries in its WHERE clause; `isIntakeFrozen`
 * is what the FILER asks of a row it already holds. They are two spellings of one sentence, and
 * the only thing that keeps them that way is this file: it runs both over the same matrix of rows
 * and asserts they answer identically, including the two cases that used to differ —
 *
 *  - a `detail` blob that is not valid JSON. The SQL `json_extract`ed it and SQLite THREW, which
 *    turned an ordinary PATCH into a 500. It is now `json_valid`-guarded and answers FROZEN, which
 *    is the safe direction: an editable answer would send a new body under a key that may be live;
 *  - a row with no `detail` at all, where the coalesce and the TypeScript `??` have to agree on
 *    what "no attempt was sent" means.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type FreezableStep, INTAKE_FROZEN_SQL, isIntakeFrozen } from "../../src/formation/freeze";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { FormationState } from "../../src/persistence/formationRepository";

let db: DatabaseType.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

/** The SQL half, run standalone — the same text the correlated UPDATE embeds. */
function frozenInSql(companyId: string): boolean {
  const row = db
    .prepare(`SELECT ${INTAKE_FROZEN_SQL} AS frozen`)
    .get({ company_id: companyId }) as { frozen: number };
  return row.frozen === 1;
}

/** One `create_provider` row, written straight to the table so a corrupt blob is reachable. */
function writeStep(companyId: string, step: FreezableStep): void {
  db.prepare(
    `INSERT INTO formation_requests
       (company_id, step, state, attempt, provider_ref, detail)
     VALUES (?, 'create_provider', ?, ?, ?, ?)`,
  ).run(companyId, step.state, step.attempt, step.providerRef, step.detail);
}

const CASES: { label: string; step: FreezableStep; frozen: boolean }[] = [
  {
    label: "a provider_ref — a company exists at doola",
    step: { state: "failed", providerRef: "cmp_1", attempt: 3, detail: null },
    frozen: true,
  },
  {
    label: "submitted — in flight",
    step: { state: "submitted", providerRef: null, attempt: 0, detail: null },
    frozen: true,
  },
  {
    label: "confirmed — done",
    step: { state: "confirmed", providerRef: null, attempt: 1, detail: null },
    frozen: true,
  },
  {
    label: "abandoned — over",
    step: { state: "abandoned", providerRef: null, attempt: 8, detail: null },
    frozen: true,
  },
  {
    label: "sent under the CURRENT attempt — the key is live",
    step: {
      state: "failed",
      providerRef: null,
      attempt: 0,
      detail: JSON.stringify({ companySentAttempt: 0 }),
    },
    frozen: true,
  },
  {
    label: "sent under a PREVIOUS attempt — a rejected burned it, so the key is released",
    step: {
      state: "failed",
      providerRef: null,
      attempt: 1,
      detail: JSON.stringify({ companySentAttempt: 0 }),
    },
    frozen: false,
  },
  {
    label: "pending, nothing sent",
    step: { state: "pending", providerRef: null, attempt: 0, detail: null },
    frozen: false,
  },
  {
    label: "a detail blob with no companySentAttempt at all",
    step: {
      state: "failed",
      providerRef: null,
      attempt: 0,
      detail: JSON.stringify({ customerId: "cus_1" }),
    },
    frozen: false,
  },
  {
    label: "a CORRUPT detail blob — unreadable is frozen, and answers rather than throwing",
    step: { state: "failed", providerRef: null, attempt: 0, detail: "{not json" },
    frozen: true,
  },
];

test("the SQL predicate and the TypeScript predicate agree on every row", () => {
  for (const [i, c] of CASES.entries()) {
    const companyId = `company-${i}`;
    writeStep(companyId, c.step);
    expect(frozenInSql(companyId), `${c.label} (sql)`).toBe(c.frozen);
    expect(isIntakeFrozen(c.step), `${c.label} (ts)`).toBe(c.frozen);
  }
});

test("a company with NO create_provider row is not frozen — nothing has been sent", () => {
  expect(frozenInSql("company-with-no-step")).toBe(false);
  expect(isIntakeFrozen(undefined)).toBe(false);
});

test("a corrupt detail blob does not THROW in SQL — which is what made a PATCH a 500", () => {
  writeStep("corrupt", { state: "failed", providerRef: null, attempt: 0, detail: "}}" });
  expect(() => frozenInSql("corrupt")).not.toThrow();
  expect(frozenInSql("corrupt")).toBe(true);
});
