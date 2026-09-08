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
 * IS THIS FILING WAITING ON THE OWNER'S SSN DECISION? (design §4.6a.)
 *
 * The third park, and the only one that is not a flag in `detail`. A company reaches its first
 * send with no SSN for two indistinguishable reasons — nobody supplied one, or the seven-day
 * retention clock destroyed the one they did — and the difference is the whole decision, because
 * the second files a US person under the slow EIN route they explicitly opted out of. So the
 * filer PARKS, and the two exits are both `PATCH /companies/:companyId`: re-supply a number, or
 * say `proceedWithoutSsn`.
 *
 * It lives here, beside `isIntakeFrozen`, because it is read off the same `create_provider` row
 * by the same rule, and because TWO callers now need it: the FILER (`resolveSsn`, deciding
 * whether to send) and the company detail VIEW (explaining to the owner why nothing is happening
 * and what they can do about it). A view that re-derived it would be a second opinion about a
 * filing's state, and the one that gets it wrong tells an owner to wait for something that is
 * waiting for them.
 *
 * Deliberately NOT a PII read: `erasedReason` is an enum and `hasSsn` is a boolean, which is the
 * whole of what the question needs.
 */
export function awaitsSsnDecision(
  step: FreezableStep | undefined,
  party: { ssnErasedReason: string | null; hasSsn: boolean } | undefined,
): boolean {
  if (!party) return false;
  // A frozen body's SSN question was settled at the first send and is read back from `detail`;
  // this park is only ever about a body that has NOT gone out yet.
  if (isIntakeFrozen(step)) return false;
  if (party.hasSsn) return false;
  return party.ssnErasedReason === "ttl";
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

/**
 * MAY THE RESPONSIBLE PARTY STILL BE EDITED? (design §7, A3's party-edit door.)
 *
 * Two disjuncts, and the second is the one the door exists for:
 *
 *  1. **Nothing has ever been sent about this company** (`!everSubmitted`). The party's fields
 *     feed BOTH bodies `create_provider` sends — `createCustomer` directly, and the company
 *     create's responsible party — so an edit is free exactly while neither has gone out.
 *     `everSubmitted` is used rather than `isIntakeFrozen` deliberately: it is the broader,
 *     safer question, and it counts a recorded `customerId`, which the freeze does not. That
 *     matters here and nowhere else, because the create step re-sends `createCustomer` only when
 *     `detail.customerId` is absent — so once a customer exists at doola, an edit would change
 *     our copy of a person and change NOTHING about the filing, while telling the caller it had.
 *     A door that pretended to fix a rejected identity is worse than one that refuses.
 *  2. **The row is parked awaiting a party edit.** By construction this is a `createCustomer`
 *     doola LOOKED at and refused, so no customer id exists and disjunct 1 already holds — it is
 *     stated anyway because the whole point of the park is that this door reopens it, and a
 *     company that could reach the park without satisfying disjunct 1 would be stranded forever
 *     with no exit at all.
 *
 * An unbound party has no company and no step: `everSubmitted(null, null, null)` is false, so it
 * is editable, which is right — nothing has been filed with it.
 */
export function partyEditAllowed(step: FreezableStep | undefined): boolean {
  if (parkedForPartyEdit(step)) return true;
  return !everSubmitted(step?.state ?? null, step?.providerRef ?? null, step?.detail ?? null);
}

/**
 * `partyEditAllowed`, in SQL — so the `UPDATE formation_parties` can carry the rule in its own
 * WHERE clause, exactly as `INTAKE_FROZEN_SQL` does for the company intake.
 *
 * The TypeScript predicate stays: it is what produces `partyFrozenMessage()`, which is the
 * actionable half of the refusal. This is the second lock, and it is the one that holds when a
 * caller reaches `parties.update` some other way — a new door, a script, a future repository
 * method that forgot to ask. A rule enforced only above the write is a rule the next writer has
 * to remember.
 *
 * Bound by `@company_id`, like `INTAKE_FROZEN_SQL`, so the same text works inside the correlated
 * UPDATE and in a standalone SELECT — which is what lets `test/formation/freeze.test.ts` run the
 * two spellings over one matrix and assert they agree.
 *
 * Two disjuncts, mirroring `partyEditAllowed` clause for clause:
 *
 *  1. the row is PARKED awaiting a party edit — `json_type(...) = 'true'` rather than
 *     `json_extract(...) = 1`, because the TypeScript is `=== true` and `json_extract` cannot
 *     tell `true` from `1`;
 *  2. nothing has EVER been sent about this company (`everSubmitted` negated). `json_type` again,
 *     for a different reason: the TypeScript tests `!== undefined`, so a key present with a JSON
 *     `null` value counts — and `json_extract` would return SQL NULL for it and lose the fact.
 */
export const PARTY_EDIT_ALLOWED_SQL = `(
      EXISTS (
        SELECT 1 FROM formation_requests f
         WHERE f.company_id = @company_id
           AND f.step = 'create_provider'
           AND f.detail IS NOT NULL
           AND json_valid(f.detail) = 1
           AND json_type(f.detail, '$.awaitingPartyEdit') = 'true')
      OR NOT EXISTS (
        SELECT 1 FROM formation_requests f
         WHERE f.company_id = @company_id
           AND f.step = 'create_provider'
           AND (   f.state IN ('submitted','confirmed')
                OR f.provider_ref IS NOT NULL
                OR (f.detail IS NOT NULL AND json_valid(f.detail) = 0)
                OR (f.detail IS NOT NULL AND json_valid(f.detail) = 1
                    AND (   json_type(f.detail, '$.customerId') IS NOT NULL
                         OR json_type(f.detail, '$.companySentAttempt') IS NOT NULL)))))`;

/** `detail.awaitingPartyEdit` — the flag `onCallFailure` writes when doola refuses the PARTY's
 *  body, and the one `rearmAfterPartyEdit` clears. An unreadable blob is not a park. */
export function parkedForPartyEdit(step: FreezableStep | undefined): boolean {
  if (!step?.detail) return false;
  const parsed = parseJson(step.detail);
  return (
    parsed !== undefined && (parsed as { awaitingPartyEdit?: unknown }).awaitingPartyEdit === true
  );
}

/** `undefined` means "not valid JSON", which both readers above treat as the cautious answer. */
function parseJson(raw: string): { customerId?: unknown; companySentAttempt?: number } | undefined {
  try {
    return JSON.parse(raw) as { customerId?: unknown; companySentAttempt?: number };
  } catch {
    return undefined;
  }
}
