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

/** How long the step watches before it admits it does not know. */
export const FUND_POLL_TIMEOUT_MS = 90_000;

/** What a poller with no answer says. Never the word "failed": see above. */
export const FUND_TIMEOUT_COPY =
  "This is taking longer than expected. The transfer may still land; check the agent's dashboard before retrying.";

/** The fallback when the backend reports `failed` and gives no reason. */
export const FUND_GENERIC_FAILURE_COPY = "Funding failed.";

/** `{ error }` carries copy that is ALREADY public — the backend sanitises it (`publicError.ts`). */
export type FundOutcome = "confirmed" | { error: string } | "timeout" | "keep-polling";

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
