/**
 * THE PROXY'S TIME BUDGET — and the reason it is a budget on the FIRST BYTE only.
 *
 * `app/backend/[[...path]]/route.ts` forwards everything the browser asks of the API, and that
 * includes the MCP endpoint's Streamable HTTP responses: a single `fetch` whose body stays open
 * for as long as the conversation lasts. A timeout over the whole exchange would therefore cut a
 * perfectly healthy stream at exactly the budget, every time — so what is bounded is the wait for
 * the backend to START answering, and the timer is cleared the instant the headers arrive.
 *
 * Without any bound, a backend that accepted a connection and then went quiet held the browser's
 * request open until the platform's own gateway gave up (or, on a self-hosted box, indefinitely).
 * That was half of the 2026-09-16 spinner.
 *
 * Extracted from the route because a Next.js `route.ts` may only export HTTP verbs — the same
 * mechanical reason `proxyHeaders.ts` lives beside it — and because a timer whose lifetime is the
 * difference between "bounded" and "cuts every stream" deserves a test of its own.
 *
 * ⚠ `AbortController` + `setTimeout`, NOT `AbortSignal.timeout`: this one has to be CANCELLABLE
 * (that is the whole point), and a plain `setTimeout` is also the only form a test's clock can
 * drive — Node does not expose `AbortSignal.timeout`'s internal timer to fake timers.
 */
import { DEFAULT_TTFB_BUDGET_MS } from "@/lib/api/budgets";

/**
 * The DEFAULT wait for the backend's headers.
 *
 * ⚠ Per-route budgets live in `@/lib/api/budgets` (`budgetMs`), which the route passes in: a
 * single 25-second limit made this proxy the binding deadline on the payment-settle and policy
 * routes, both of which broadcast and then wait for a receipt. This constant is only the
 * fall-through, re-exported from the table so there is one number, not two.
 */
export const UPSTREAM_TTFB_TIMEOUT_MS = DEFAULT_TTFB_BUDGET_MS;

export const UPSTREAM_TIMEOUT_STATUS = 504;

/** The API's own error envelope (`back/backend/src/api/errors.ts`), so the client's single error
 *  path reads a proxy timeout exactly as it reads a backend refusal. */
export const UPSTREAM_TIMEOUT_BODY = {
  error: { code: "upstream_timeout", message: "The API did not answer in time." },
} as const;

/** Never cached: a 504 is a fact about one moment, and an intermediary holding onto it would keep
 *  answering for a backend that has since recovered. */
export const UPSTREAM_TIMEOUT_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/** Headers received (the body may still be streaming), or the budget expired. */
export type FirstByteResult = { timedOut: false; res: Response } | { timedOut: true };

/**
 * Run `doFetch` with a signal that aborts if the headers do not arrive in time.
 *
 * The timer is cleared in a `finally`, which runs as soon as the promise settles — i.e. as soon
 * as the response HEADERS are in hand. From that moment the signal can never fire, and the body
 * streams for as long as it likes.
 *
 * A rejection is reported as a timeout only when OUR signal is the reason: undici rejects an
 * aborted fetch with a `TypeError: terminated` rather than the abort reason, so the signal's own
 * state is the authority. Any other failure (ECONNREFUSED, DNS) is rethrown for the route to
 * handle, because "refused" and "slow" are different facts.
 */
export async function fetchFirstByte(
  doFetch: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number = DEFAULT_TTFB_BUDGET_MS,
): Promise<FirstByteResult> {
  const controller = new AbortController();
  // ⚠ A non-finite budget means NO TIMER, not a huge one: `setTimeout(fn, Infinity)` fires
  // immediately in Node (TimeoutOverflowWarning clamps it to 1ms), so passing it through would
  // turn "unbounded" into "instant 504" — the worst possible reading of the table.
  const timer = Number.isFinite(timeoutMs)
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  try {
    return { timedOut: false, res: await doFetch(controller.signal) };
  } catch (e) {
    if (controller.signal.aborted) return { timedOut: true };
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
