import { ApiError } from "./types";

/**
 * NOTHING THIS CLIENT ASKS FOR WAITS FOREVER.
 *
 * 2026-09-16: the fund button span with no backend trace at all. Two things were missing, and
 * this is the second one — `fetch` has no default timeout, in any browser, so a stalled backend
 * (or a stalled proxy in front of it, or a laptop that slept mid-request) was a spinner that
 * would still be turning the next morning. There was no error to show because no error existed.
 *
 * Extracted from `client.ts` rather than written inline there for one reason: `request()` is
 * module-private, so the only way to reach this behaviour from a test is through a public call
 * with the real 30-second budget — which is not a test, it is a pause. Here the budget is an
 * argument, and the mapping is one exported function.
 *
 * `AbortSignal.timeout` bounds the WHOLE exchange, headers and body, which is right for a JSON
 * API: `request()` reads the body immediately and a response that stops arriving half way is as
 * stuck as one that never starts. (The `/backend` PROXY needs the opposite rule, because it
 * carries SSE — see `@/lib/upstreamTimeout`.)
 */

/** Long enough for a real call over a bad connection, short enough to end. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** `timeout` is deliberately NOT one of the backend's codes: it means we never heard back. */
export const TIMEOUT_CODE = "timeout";

/**
 * ⚠ Advice, not a statement. A timed-out POST may well have been applied — the request left, and
 * we simply did not hear the answer — so this must never say "nothing was sent".
 */
export const TIMEOUT_MESSAGE = "The server took too long to answer. Try again.";

/** An abort raised by OUR budget, as the runtime spells it (`TimeoutError` per the spec;
 *  `AbortError` from implementations and polyfills that predate it). */
function isTimeoutAbort(e: unknown): boolean {
  const name = (e as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * `fetch` under a time budget, with an expiry mapped into this client's own error shape.
 *
 * Returns the `Response` untouched — the caller still decides what a non-2xx means
 * (`throwIfNotOk`). Anything that is not our own abort (a DNS failure, an offline browser) is
 * rethrown as itself: "the network is not there" and "the server is slow" are different facts and
 * the second must not be shown for the first.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  // A non-finite budget means NO deadline (a document download). `AbortSignal.timeout(Infinity)`
  // throws, so this is a branch rather than a value.
  const budget = Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    return await fetch(url, { ...init, signal: composeSignals(init.signal, budget) });
  } catch (e) {
    // ⚠ Everything EXCEPT the caller's own cancellation (review R5).
    //
    // Gating on `budget.aborted` alone was too narrow: the runtime raises `TimeoutError` for
    // timeouts of its own (undici's headers/connect timeouts), and "the server took too long" is
    // the right sentence for those too. The one case that must NOT wear it is a caller who
    // cancelled deliberately — so that is the exclusion, rather than an allowlist of our own
    // signal. When both fired, the caller's intent wins: we do not accuse a server of being slow
    // for a request the user withdrew.
    if (init.signal?.aborted !== true && isTimeoutAbort(e))
      // Status 0: no response arrived, so there is no HTTP status to report. Not 504 — that would
      // be a claim about a gateway that never spoke.
      throw new ApiError(0, { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE });
    throw e;
  }
}

/**
 * `res.json()` under the same error contract — the body read is part of the exchange.
 *
 * The signal from `fetchWithTimeout` bounds the body too (deliberately: a body that stops arriving
 * half way is as stuck as one that never starts), but the read itself happens at the CALL SITE,
 * outside the mapped region. `request()` used to do `res.json().catch(() => null)`, so headers at
 * 29.5 seconds and a body cut at 30 handed the caller `null` typed as `T` — a silent failure in
 * the file whose whole purpose is to end silent failures.
 *
 * A body that is not JSON (a 204, an empty error body) still reads as `null`, which is what that
 * `.catch` was for. Only an abort is promoted to the timeout error.
 */
export async function readJsonBounded<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    if (isTimeoutAbort(e)) throw new ApiError(0, { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE });
    return null;
  }
}

/**
 * The caller's signal AND ours, rather than ours replacing theirs.
 *
 * No caller passes one today, which is exactly why this is worth fixing now: `{ ...init, signal }`
 * silently discarded it, so the first caller to try cancelling a request would have found that
 * cancellation did nothing, with no error to explain it.
 *
 * `AbortSignal.any` is Node 20+/2023 browsers; the manual relay keeps this correct anywhere it is
 * missing rather than trusting a target list.
 */
function composeSignals(
  caller: AbortSignal | null | undefined,
  budget: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals = [caller, budget].filter((s): s is AbortSignal => !!s);
  if (signals.length < 2) return signals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
