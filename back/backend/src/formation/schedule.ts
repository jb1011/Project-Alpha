/**
 * Every clock the formation loop runs on, in ONE module (design §7).
 *
 * They used to live in `formationSweeper.ts`, which was fine while the sweeper was the only thing
 * that scheduled anything. It is not any more: a step parked WITHOUT an attempt bump (C1 — a lost
 * response must not rotate the idempotency key, and therefore must not bump) still has to back
 * off, and a polled step that hit a transient read error (C3) has to back off without burning an
 * attempt either. Both of those are written by the step helpers, which the sweeper imports —
 * so the constants cannot live in the sweeper without an import cycle.
 *
 * `formationSweeper.ts` re-exports all of it, because "the sweeper's schedules" is how the tests
 * and the runbook already name these numbers.
 */

/** Retry backoff for a `failed` row whose attempt WAS burned: 1m · 2^attempt, capped. `attempt`
 *  is already ≥1 when such a row reaches `failed`, so the first retry waits two minutes. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_CAP_MS = 6 * 60 * 60 * 1000;

/** After this many burned attempts a row is `abandoned` — the sweeper's terminal verdict. */
export const MAX_FORMATION_ATTEMPTS = 8;

/** Poll cadence for an in-flight entity: daily, doubling on every EMPTY poll, capped at a week.
 *  An `await_ein` row legitimately sits 4–6 weeks; polling it 42 times to learn nothing is 42
 *  round trips and 42 chances to trip a rate limit. */
export const POLL_BASE_MS = 24 * 60 * 60 * 1000;
export const POLL_CAP_MS = 7 * 24 * 60 * 60 * 1000;

/** An unbound formation party is a form somebody filled in and never used. */
export const UNBOUND_PARTY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a step may be in flight before an operator hears about it. */
export const FORMATION_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** Webhook forensics retention. */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a `submitted` `create_provider` row may sit before the sweeper re-runs it (C2).
 *
 * `submitted` means "we are inside a doola call right now". The client's own deadline bounds that
 * call, so a row still `submitted` well past it belongs to a process that died mid-call — and the
 * re-run is what un-strands it. The slack is deliberately generous: re-running a row whose call
 * is merely slow is harmless (the idempotency key and the persisted ids make it an adopt), but it
 * is still a wasted round trip.
 */
export const SUBMITTED_STALL_SLACK_MS = 2 * 60 * 1000;

/** `1m · 2^attempt`, capped — the schedule for a row whose attempt was burned. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempt, 0), RETRY_CAP_MS);
}

/**
 * The next interval in a doubling backoff: twice the previous one, capped — and twice `base` the
 * first time, because the first doubling is itself an event that happened.
 *
 * Used by every schedule that CANNOT count attempts. A lost doola response, a transient read
 * error and an empty poll all leave `attempt` deliberately untouched, so the interval itself is
 * the only memory the row has of how many times this has now happened.
 */
export function nextInterval(previous: number | undefined, base: number, cap: number): number {
  const from =
    previous !== undefined && Number.isFinite(previous) && previous > 0 ? previous : base;
  return Math.min(from * 2, cap);
}

/**
 * Scheduling state carried in a step's `detail` blob.
 *
 * It lives in `detail` rather than in columns because it is scheduling, not fact — with ONE
 * exception, `next_poll_at`, which is mirrored into a real column so the sweeper can ask the
 * database "which rows are due?" instead of loading every open entity to find out (M5).
 *
 * The two pairs are deliberately separate. A row can be waiting on a POLL (it is `pending` and
 * doola simply has not finished) and, later, be parked after a failed read — and a retry schedule
 * that overwrote the poll schedule would make the two indistinguishable in the ops trail.
 */
export interface StepBackoff {
  /** Epoch ms: the sweeper does not POLL this entity before then. */
  nextPollAt?: number;
  /** The interval that produced `nextPollAt`; doubled on the next empty or failed poll. */
  pollIntervalMs?: number;
  /** Epoch ms: the sweeper does not RETRY this parked row before then. Written only when the row
   *  was parked WITHOUT an attempt bump, which is the case `retryDelayMs(attempt)` cannot see. */
  nextRetryAt?: number;
  /** The interval that produced `nextRetryAt`; doubled on the next indeterminate failure. */
  retryIntervalMs?: number;
}
