import { opsLog } from "../observability/opsLog";
import type { EntityRepository } from "../persistence/entityRepository";
import type {
  FormationRepository,
  FormationState,
  FormationStep,
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
