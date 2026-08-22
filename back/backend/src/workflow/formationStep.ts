import {
  POLL_BASE_MS,
  POLL_CAP_MS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  type StepBackoff,
  nextInterval,
} from "../formation/schedule";
import { opsLog } from "../observability/opsLog";
import type { EntityRepository } from "../persistence/entityRepository";
import {
  type FormationRepository,
  type FormationState,
  type FormationStep,
  parseDetail,
} from "../persistence/formationRepository";

/**
 * The two primitives every formation step shares (design §5/§7).
 *
 * They live here rather than in either driver because there are now THREE of them — the
 * onboarding saga's `create_provider`, the webhook processor, and the sweeper — and the
 * bump-then-park sequence is a contract, not a convenience. Three copies of it would be three
 * chances to burn an attempt without parking the row, or to park it without burning the attempt.
 * The first strands a retry on an idempotency key doola has already released; the second lets a
 * failing step retry forever without ever reaching the max-attempt verdict.
 */

/** The ops line for every transition. IDs, steps and states only — never PII, never a payload. */
export function logFormationStep(
  entityKey: string,
  step: FormationStep,
  state: FormationState,
  attempt: number,
  extra: Record<string, unknown> = {},
): void {
  opsLog("formation_step", { entityKey, step, state, attempt, ...extra });
}

/**
 * Park a step in `failed`, carrying the reason, and burn the attempt — both, in this order,
 * inside ONE transaction.
 *
 * `bumpAttempt` is the repository's failure primitive: it increments `attempt` and resets the row
 * to `pending`, so a retry derives a FRESH idempotency key (a failed doola create releases its
 * key, and reusing it with a corrected body comes back `E_IDEMPOTENCY_KEY_REUSED`). But `pending`
 * is not the state an operator should see for a step that failed, so the row is then moved to
 * `failed` carrying the error. The transaction is what makes the intermediate `pending`
 * unobservable — and what makes "attempt burned" and "row parked" a single fact for the sweeper's
 * backoff to read.
 *
 * A `confirmed` or `abandoned` row is never touched: the first is a legal fact that already
 * happened, the second is the sweeper's terminal verdict, and neither is something a later error
 * gets to overrule.
 */
export function failFormationStep(
  d: { repo: EntityRepository; requests: FormationRepository },
  entityKey: string,
  step: FormationStep,
  error: string,
  logExtra: Record<string, unknown> = {},
): void {
  // Re-read rather than trusting a caller's snapshot: between the read that produced it and this
  // call there may have been a whole doola round trip.
  const row = d.requests.find(entityKey, step);
  if (!row || row.state === "confirmed" || row.state === "abandoned") return;
  const from = row.state;
  d.repo.transaction(() => {
    const bumped = d.requests.bumpAttempt(entityKey, step, from);
    if (bumped !== undefined)
      d.requests.transition(entityKey, step, "pending", "failed", { error });
    // Lost the bump race: another driver moved the row. Park it from wherever it now is, which
    // the CAS will simply refuse if that driver already parked it.
    else d.requests.transition(entityKey, step, from, "failed", { error });
  });
  logFormationStep(entityKey, step, "failed", row.attempt + 1, logExtra);
}

/**
 * Park a step in `failed` WITHOUT burning the attempt — the other half of the contract (C1/C3/C7).
 *
 * An attempt is a claim about doola's state, not a counter of how often something went wrong. It
 * feeds the `Idempotency-Key`, and rotating that key is a statement: "the last request definitely
 * did not commit, so a fresh one is safe". Three failures cannot honestly say that:
 *
 *  - a TIMEOUT or a transport error on a create: doola may hold a real Wyoming LLC and a real
 *    fee, and the answer was simply lost. A new key would file a SECOND one (C1);
 *  - a transient READ failure on a polled step: nothing was written, nothing was attempted, and
 *    burning eight of those would `abandon` a formation the state has already filed (C3);
 *  - an environment-pin mismatch: no call was made at all. It is a configuration error, and
 *    counting it toward abandonment would erase a party over a wrong env var (C7).
 *
 * Because `attempt` does not move, `retryDelayMs(attempt)` cannot express "this has now failed
 * six times in a row" — so the backoff itself is the memory: a doubling `nextRetryAt`, persisted
 * on the row, capped, and reset by the first success (which clears the whole detail-carried
 * schedule when it writes its own).
 *
 * `confirmed` and `abandoned` rows are never touched, exactly as in `failFormationStep`.
 */
export function parkFormationStep(
  d: { repo: EntityRepository; requests: FormationRepository; now?: () => number },
  entityKey: string,
  step: FormationStep,
  error: string,
  logExtra: Record<string, unknown> = {},
): void {
  const row = d.requests.find(entityKey, step);
  if (!row || row.state === "confirmed" || row.state === "abandoned") return;
  const detail = parseDetail<StepBackoff>(row.detail);
  const retryIntervalMs = nextInterval(detail.retryIntervalMs, RETRY_BASE_MS, RETRY_CAP_MS);
  const nextRetryAt = (d.now ?? Date.now)() + retryIntervalMs;
  d.requests.transition(entityKey, step, row.state, "failed", {
    error,
    detail: JSON.stringify({ ...detail, retryIntervalMs, nextRetryAt }),
  });
  logFormationStep(entityKey, step, "failed", row.attempt, {
    ...logExtra,
    // The one field an operator needs to tell these two apart in journald.
    attemptBurned: false,
    retryInMs: retryIntervalMs,
  });
}

/**
 * Persist a poll schedule on a step WITHOUT moving it (a CAS from its own state onto itself).
 *
 * `advance` resets the cadence to the base interval — something happened, so ask again soon —
 * while an empty or failed read doubles it, capped. The column and the blob are written together;
 * the column is an index over the blob, never a second source of truth.
 */
export function persistPollBackoff(
  d: { requests: FormationRepository; now?: () => number },
  row: { entityKey: string; step: FormationStep; state: FormationState; detail: string | null },
  opts: { advanced: boolean },
): number {
  const detail = parseDetail<StepBackoff>(row.detail);
  const pollIntervalMs = opts.advanced
    ? POLL_BASE_MS
    : nextInterval(detail.pollIntervalMs, POLL_BASE_MS, POLL_CAP_MS);
  const nextPollAt = (d.now ?? Date.now)() + pollIntervalMs;
  d.requests.transition(row.entityKey, row.step, row.state, row.state, {
    detail: JSON.stringify({ ...detail, pollIntervalMs, nextPollAt }),
    nextPollAt,
  });
  return nextPollAt;
}
