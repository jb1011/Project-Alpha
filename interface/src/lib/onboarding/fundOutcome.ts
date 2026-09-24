/**
 * WHAT A FUND POLL MEANS — the decision FundStep used to make inline, and got wrong twice.
 *
 * The step polls the entity after asking the backend to move USDC into the treasury, and the old
 * rule was two lines: `funded` is success, `failed` is failure, anything else keep going. Both
 * September incidents lived in "anything else":
 *
 *  - **2026-09-14.** The platform wallet was nearly empty, the transfer reverted, and the runner
 *    swallowed it — a fund saga runs on an entity that is already `bound`, which the crash
 *    handler treated as terminal. No `failed`, no error, so the wizard span forever. The backend
 *    now records the error BESIDE the unchanged status, and this function is what reads it.
 *  - **2026-09-16.** The POST never left the browser (an expired session waiting on a hidden
 *    MetaMask prompt). Nothing was ever going to change, and nothing bounded the wait.
 *
 * Hence three outcomes where there were two, and the third is the honest one: a `timeout` says we
 * stopped watching, NOT that the transfer failed. We do not know, so we must not say — the money
 * may well be in the treasury.
 *
 * Pure, and tested as a table, because this is the kind of decision that is invisible when it
 * lives inside a `useEffect`.
 */

import { ApiError } from "@/lib/api/types";

/** How long the step watches before it admits it does not know. */
export const FUND_POLL_TIMEOUT_MS = 90_000;

/** What a poller with no answer says. Never the word "failed": see above. */
export const FUND_TIMEOUT_COPY =
  "This is taking longer than expected. The transfer may still land; check the agent's dashboard before retrying.";

/** The fallback when the backend reports `failed` and gives no reason. */
export const FUND_GENERIC_FAILURE_COPY = "Funding failed.";

/** `{ error }` carries copy that is ALREADY public — the backend sanitises it (`publicError.ts`). */
export type FundOutcome = "confirmed" | { error: string } | "timeout" | "keep-polling";

/**
 * ⚠ AN ANSWER THAT PREDATES THIS ATTEMPT IS NOT AN ANSWER (review I-R1, Critical).
 *
 * The poll's React Query key is the ENTITY, not the attempt (`apiKeys.entity`), it is shared with
 * the deploy step and the dashboard, `enabled` only gates FETCHING, and `invalidateQueries` does
 * not clear data. So the instant a retry flips polling back on, the effect is handed the failed
 * attempt's cached body — measured at 27ms stale against @tanstack/query-core 5.101.1 — reads its
 * `error`, and reports the retry as failed before a single poll of it has happened. Every
 * subsequent retry does the same, while each underlying transfer may well be succeeding: the
 * precise failure this branch exists to end.
 *
 * `dataUpdatedAt` is the right witness because it is the time the data was RECEIVED, and it is 0
 * when there is none — which reads as "no answer yet" without a special case.
 *
 * Sound because `OnboardingRunner.fund` clears the stale error synchronously BEFORE it answers
 * 202, so every GET issued after the mutation resolves reads a cleared row. The residual race is
 * an in-flight GET from another observer of the same key landing just after `attemptStartedAt`
 * with pre-clear data; not reachable in the wizard today (the deploy step is unmounted and a
 * disabled query is not refetched by an invalidate), and it would cost one poll interval.
 */
export function answerForAttempt<T>(
  polled: T | undefined,
  dataUpdatedAt: number,
  attemptStartedAt: number,
): T | undefined {
  return polled !== undefined && dataUpdatedAt >= attemptStartedAt ? polled : undefined;
}

/**
 * Is this the backend saying "the PREVIOUS attempt is still running"?
 *
 * `OnboardingRunner.fund` answers 409 `entity is busy` while a saga is in flight — and "the saga
 * is still running at 90 seconds" is precisely why the timeout fired in the first place. So the
 * retry the timeout offers will, in the common case, come straight back with that refusal, and
 * rendering it as a red error replaces an honest "the transfer may still land" with a failure that
 * has not happened.
 *
 * Matched on the code AND the message because `conflict` also covers a real refusal (`cannot fund
 * in status "pending"`), which is a different thing and must still be shown.
 */
export function isBusyConflict(e: unknown): boolean {
  return (
    e instanceof ApiError && e.code === "conflict" && /\bis busy\b/i.test(e.message)
  );
}

/** The polled entity, narrowed to the two fields this decision reads. */
export type PolledFunding = { status: string; error?: string | null };

export function fundPollOutcome(
  polled: PolledFunding | undefined,
  elapsedMs: number,
): FundOutcome {
  const error = polled?.error?.trim();

  // ⚠ THE ERROR COMES FIRST, ahead of `funded`. A re-fund of an already-funded treasury never
  // changes the status, so `funded` + an error is a top-up that failed; checking the status first
  // would render that as a confirmation of money that never moved. It is only safe because
  // `OnboardingRunner.fund` clears a stale error before it spawns the saga: an error seen while
  // polling therefore belongs to the attempt being polled, whatever the status says.
  if (error) return { error };
  if (polled?.status === "funded") return "confirmed";
  // `failed` with no reason at all. Rare (the runner always writes one) and still not silent.
  if (polled?.status === "failed") return { error: FUND_GENERIC_FAILURE_COPY };

  // Only after nothing has been DECIDED. A confirmation that arrives at 91 seconds is a
  // confirmation, not a timeout — telling somebody to go and check a transfer that has already
  // landed is the same class of lie as the spinner.
  if (elapsedMs > FUND_POLL_TIMEOUT_MS) return "timeout";
  return "keep-polling";
}
