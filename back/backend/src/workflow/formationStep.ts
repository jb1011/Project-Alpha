import { redactPii } from "../formation/pii";
import {
  POLL_BASE_MS,
  POLL_CAP_MS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  type StepBackoff,
  nextInterval,
} from "../formation/schedule";
import { opsLog } from "../observability/opsLog";
import type { CompanyRepository } from "../persistence/companyRepository";
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

/**
 * The ENTITY audit trail of a COMPANY-level event, fanned out (2026-08-26 §3).
 *
 * One company may have zero agents attached (it can be filed before anyone onboards) or ten. The
 * event is the same for every one of them, and a company with none records nothing — which is
 * honest: there is no entity whose history it would belong to.
 *
 * ONE copy, here, because there were three: the filer's, the processor's and (before the re-key)
 * the saga's. Three copies of "which entities does this event belong to?" is three chances for a
 * company's agents to end up with different histories of the same filing.
 */
export function recordCompanyEvent(
  repo: EntityRepository,
  companyId: string,
  step: string,
  detail: string,
): void {
  for (const e of repo.listByCompany(companyId))
    repo.recordEvent(e.idempotencyKey, step, e.status, null, detail);
}

/** The ops line for every transition. IDs, steps and states only — never PII, never a payload. */
export function logFormationStep(
  companyId: string,
  step: FormationStep,
  state: FormationState,
  attempt: number,
  extra: Record<string, unknown> = {},
): void {
  opsLog("formation_step", { companyId, step, state, attempt, ...extra });
}

/**
 * ABANDON a formation step, moving the COMPANY's status with it, in ONE transaction.
 *
 * `abandoned` is the terminal verdict, and §4.6 says it has exactly three writers — the sweeper
 * at the attempt bound, the operator escape (`npm run cli -- formation:abandon`), and a future
 * payment expiry — each of which must move the step and the company TOGETHER. The CLI used to
 * run two raw UPDATEs outside any transaction, so a crash between them left a company still
 * `ready` (attachable, quota-chargeable, and inside `listUnopened`'s reach) over an abandoned
 * create — and it never stamped `facts_updated_at` at all, which the anchor gate reads.
 *
 * Returns whether THIS caller made the move: the step transition is a CAS, and a caller that
 * loses it must not log a CRITICAL about a verdict somebody else reached.
 *
 * The company's status moves only for `create_provider`, because that is the step whose failure
 * means the FILING is over; a later step can be abandoned while the company legitimately exists.
 */
export function abandonFormation(
  requests: FormationRepository,
  companies: Pick<CompanyRepository, "setStatus">,
  companyId: string,
  reason: string,
  opts: {
    transaction: <T>(fn: () => T) => T;
    /** Which step. Defaults to the one whose abandonment ends the filing. */
    step?: FormationStep;
    /** The state to CAS from. Defaults to the sweeper's own `failed`. */
    from?: FormationState;
  },
): boolean {
  const step = opts.step ?? "create_provider";
  let moved = false;
  opts.transaction(() => {
    moved = requests.transition(companyId, step, opts.from ?? "failed", "abandoned", {
      error: reason,
    });
    // A verdict IS a fact: the row's state changed, so `transition` stamps `facts_updated_at`
    // by default and the anchor gate sees it.
    if (moved && step === "create_provider") companies.setStatus(companyId, "ready", "abandoned");
  });
  return moved;
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
  companyId: string,
  step: FormationStep,
  error: string,
  logExtra: Record<string, unknown> = {},
  opts: {
    /**
     * Fields to merge into the row's `detail` INSIDE the fail transaction.
     *
     * It exists for `awaitingIntakeEdit` (§4.7): the flag is what stops the sweeper re-sending a
     * body doola has already refused, and writing it after the fail would leave a crash window in
     * which exactly that happens.
     */
    detailPatch?: Record<string, unknown>;
  } = {},
): void {
  // Re-read rather than trusting a caller's snapshot: between the read that produced it and this
  // call there may have been a whole doola round trip.
  const row = d.requests.find(companyId, step);
  if (!row || row.state === "confirmed" || row.state === "abandoned") return;
  const from = row.state;
  // A step's `error` reaches `formation_requests.error`, the entity event trail and an ops line,
  // and it is very often a THIRD PARTY's sentence — which is the one that can carry an SSN a
  // provider echoed back at us (§4). Redacted where it is written down, not where it was
  // produced, so no producer can forget.
  const safe = redactPii(error);
  const fields =
    opts.detailPatch === undefined
      ? { error: safe }
      : {
          error: safe,
          detail: JSON.stringify({ ...parseDetail(row.detail), ...opts.detailPatch }),
        };
  d.repo.transaction(() => {
    const bumped = d.requests.bumpAttempt(companyId, step, from);
    if (bumped !== undefined) d.requests.transition(companyId, step, "pending", "failed", fields);
    // Lost the bump race: another driver moved the row. Park it from wherever it now is, which
    // the CAS will simply refuse if that driver already parked it.
    else d.requests.transition(companyId, step, from, "failed", fields);
  });
  logFormationStep(companyId, step, "failed", row.attempt + 1, logExtra);
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
  companyId: string,
  step: FormationStep,
  error: string,
  logExtra: Record<string, unknown> = {},
): void {
  const row = d.requests.find(companyId, step);
  if (!row || row.state === "confirmed" || row.state === "abandoned") return;
  const detail = parseDetail<StepBackoff>(row.detail);
  const retryIntervalMs = nextInterval(detail.retryIntervalMs, RETRY_BASE_MS, RETRY_CAP_MS);
  const nextRetryAt = (d.now ?? Date.now)() + retryIntervalMs;
  d.requests.transition(companyId, step, row.state, "failed", {
    // Redacted here for the reason `failFormationStep` gives: this column is read by humans and
    // its contents are frequently somebody else's sentence.
    error: redactPii(error),
    detail: JSON.stringify({ ...detail, retryIntervalMs, nextRetryAt }),
    // A PARK IS NOT A FACT (2026-08-26 §3). Nothing was learned — a lost answer, a transient read
    // failure, a config mismatch — and the only thing written is the retry schedule. Moving
    // `facts_updated_at` here would make a row that fails every tick re-derive and re-hash its
    // entity's manifest every tick, which is the exact cost the column exists to avoid.
    touchFacts: false,
  });
  logFormationStep(companyId, step, "failed", row.attempt, {
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
 *
 * `touchFacts: false` is load-bearing (2026-08-26 §3). A POLL IS NOT A FACT: this write happens on
 * every pass over a waiting row, and letting it move `facts_updated_at` is what made an
 * `await_ein` row re-derive and re-hash its entity's manifest on every tick for the whole
 * four-to-six-week IRS wait.
 */
export function persistPollBackoff(
  d: { requests: FormationRepository; now?: () => number },
  row: { companyId: string; step: FormationStep; state: FormationState; detail: string | null },
  opts: { advanced: boolean },
): number {
  const detail = parseDetail<StepBackoff>(row.detail);
  const pollIntervalMs = opts.advanced
    ? POLL_BASE_MS
    : nextInterval(detail.pollIntervalMs, POLL_BASE_MS, POLL_CAP_MS);
  const nextPollAt = (d.now ?? Date.now)() + pollIntervalMs;
  d.requests.transition(row.companyId, row.step, row.state, row.state, {
    detail: JSON.stringify({ ...detail, pollIntervalMs, nextPollAt }),
    nextPollAt,
    touchFacts: false,
  });
  return nextPollAt;
}
