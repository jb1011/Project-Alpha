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
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (isTimeoutAbort(e))
      // Status 0: no response arrived, so there is no HTTP status to report. Not 504 — that would
      // be a claim about a gateway that never spoke.
      throw new ApiError(0, { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE });
    throw e;
  }
}
