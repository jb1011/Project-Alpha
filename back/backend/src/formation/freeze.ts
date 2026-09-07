import type { FormationState } from "../persistence/formationRepository";

/**
 * THE FREEZE PREDICATE (design 2026-08-26 §4.5/§4.7) — "may this company's create body still
 * change?" — in the two forms the system needs it, derived from ONE description.
 *
 * The rule is the idempotency contract, not a UX preference. An `Idempotency-Key` is a pure
 * function of the attempt, and doola answers a repeat of a key with the committed response — but
 * only for the SAME body. A different body under a live key is `E_IDEMPOTENCY_KEY_REUSED`, which
 * this system never re-keys past. So once a create has gone out under the key we would use next,
 * the body is frozen.
 *
 * It exists in two forms because two very different callers ask it:
 *
 *  - **`INTAKE_FROZEN_SQL`**, so the `UPDATE companies … SET name_options = …` can carry the rule
 *    in its own WHERE clause. Three surfaces can reach a company, and a route-level check is a
 *    check one more door can forget;
 *  - **`isIntakeFrozen`**, so the FILER can ask the same question of a row it already holds
 *    (`resolveSsn`), without a second query and without a second opinion.
 *
 * They are two spellings of one sentence, and `test/formation/freeze.test.ts` asserts they agree
 * over a matrix of rows — which is the only thing that keeps them that way.
 *
 * ⚠ Scope: this fragment is about the `create_provider` STEP. The company-level arm ("an
 * `abandoned` company is frozen too") stays in the repository's own WHERE clause, because it is a
 * predicate over the row being updated rather than over the sub-saga.
 */

/**
 * The four ways a step says "doola is, or may be, holding a body under the key we would use next".
 *
 * 1. a `provider_ref` — the create RETURNED and a company exists at doola;
 * 2. `submitted`/`confirmed`/`abandoned` — in flight, done, or over;
 * 3. `detail.companySentAttempt === attempt` — a create went out under THIS attempt, which is
 *    exactly "the key is live". Its converse is why edit-and-retry is offered only after a
 *    `rejected`: `rejected` is the ONLY failure that burns the attempt (C1), so it is the only
 *    one that leaves `companySentAttempt` behind on a previous number;
 * 4. a `detail` blob that is not valid JSON. Clause 3 cannot be evaluated at all, and the two
 *    errors are not symmetric: treating it as EDITABLE would let a new body go out under a key
 *    that may be live, which files a second real Wyoming LLC. Treating it as FROZEN costs the
 *    caller a company they must re-create. (It also stops `json_extract` from THROWING on a
 *    corrupt blob, which turned an ordinary PATCH into a 500.)
 *
 * Bound by `@company_id`, so the same text works inside the correlated UPDATE and in a standalone
 * SELECT — which is what lets the agreement test run it.
 */
export const INTAKE_FROZEN_SQL = `EXISTS (
      SELECT 1 FROM formation_requests f
       WHERE f.company_id = @company_id
         AND f.step = 'create_provider'
         AND (   f.provider_ref IS NOT NULL
              OR f.state IN ('submitted','confirmed','abandoned')
              OR (f.detail IS NOT NULL AND json_valid(f.detail) = 0)
              OR (json_valid(f.detail) = 1
                  AND COALESCE(json_extract(f.detail, '$.companySentAttempt'), -1) = f.attempt)))`;

/** What the predicate reads. Exactly the columns the SQL names, so a reader can check them off. */
export interface FreezableStep {
  state: FormationState;
  providerRef: string | null;
  attempt: number;
  detail: string | null;
}

/** `INTAKE_FROZEN_SQL`, in TypeScript. Same four clauses, same order, same answers. */
export function isIntakeFrozen(row: FreezableStep | undefined): boolean {
  if (!row) return false; // no step was ever opened: nothing has been sent, so nothing is frozen
  if (row.providerRef) return true;
  if (row.state === "submitted" || row.state === "confirmed" || row.state === "abandoned")
    return true;
  if (row.detail === null) return false;
  const parsed = parseJson(row.detail);
  if (parsed === undefined) return true; // clause 4: unreadable is frozen
  return (parsed.companySentAttempt ?? -1) === row.attempt;
}

/**
 * "Has this company's filing ever been in flight at doola?" — read from three independent
 * witnesses, ANY of which is enough (§4.6a).
 *
 * A different question from the freeze, and it lives here because it is answered from the same
 * row by the same rules: the state alone is not enough (a row that was `submitted` and then
 * failed is back at `failed`, and its state has forgotten), so `provider_ref` and the two ids in
 * `detail` remember for it. Erring toward "yes" keeps an SSN a week longer than the policy; erring
 * toward "no" erases one out from under a live idempotency key, which is a wedge (§4.4).
 */
export function everSubmitted(
  state: FormationState | null,
  providerRef: string | null,
  detail: string | null,
): boolean {
  if (state === "submitted" || state === "confirmed") return true;
  if (providerRef) return true;
  if (!detail) return false;
  const parsed = parseJson(detail);
  // An unreadable blob is not evidence that nothing happened. The conservative answer is the one
  // that KEEPS the data — the same direction clause 4 of the freeze takes, for the same reason.
  if (parsed === undefined) return true;
  return parsed.customerId !== undefined || parsed.companySentAttempt !== undefined;
}

/** `undefined` means "not valid JSON", which both readers above treat as the cautious answer. */
function parseJson(raw: string): { customerId?: unknown; companySentAttempt?: number } | undefined {
  try {
    return JSON.parse(raw) as { customerId?: unknown; companySentAttempt?: number };
  } catch {
    return undefined;
  }
}
