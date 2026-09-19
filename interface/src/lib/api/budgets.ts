/**
 * HOW LONG EACH ROUTE IS ALLOWED TO TAKE — one table, read by both the proxy and the client.
 *
 * The first version of this branch gave every call the same 25-second time-to-first-byte budget at
 * the proxy and the same 30 seconds at the client. That made the proxy the BINDING limit on two
 * route families that legitimately take longer, and both answer only when their handler is
 * finished (hono's `c.json`, so time-to-first-byte is total handler time):
 *
 *  - **formation payment settle / cancel** — verify an ERC-1271 signature, read the chain time,
 *    read `authorizationUsed`, estimate the fee, read two nonces, broadcast, then wait up to 12
 *    seconds for the receipt (`ROUTE_RECEIPT_TIMEOUT_MS`). 13-15 seconds when healthy, and every
 *    read retries three times with backoff — 25 seconds is reachable on a throttled RPC, and the
 *    cost of the 504 is a guardian being told their 399 USDC payment failed while it settles.
 *  - **policy schedule / execute** — `sendManagerCallConfirmed` waits on viem's receipt default,
 *    which is **180 seconds**. Any budget under that can 504 a transaction that is mining.
 *
 * Kept as a table rather than as arguments at each call site for the reason `proxyHeaders.ts` is a
 * table: a budget that lives in two places is a budget that disagrees with itself, and the client
 * giving up before the proxy answers would replace the proxy's error envelope with a vaguer one.
 *
 * ⚠ `Number.POSITIVE_INFINITY` means INSTALL NO TIMER. It is not a large number and must never be
 * passed to a timer API: `setTimeout(fn, Infinity)` fires immediately in Node (TimeoutOverflow
 * Warning, clamped to 1ms) and `AbortSignal.timeout(Infinity)` throws. Both callers check
 * `Number.isFinite` first.
 */

/** Everything not named below. Long enough for any handler that does not broadcast. */
export const DEFAULT_TTFB_BUDGET_MS = 25_000;

/** Broadcast-and-wait-a-bit routes: payment settle/cancel, AgentBook register. */
export const BROADCAST_BUDGET_MS = 60_000;

/** Broadcast-and-wait-on-viem's-default routes: the policy pair (180s receipt + margin). */
export const RECEIPT_BUDGET_MS = 240_000;

/**
 * How much longer the CLIENT waits than the proxy.
 *
 * The client must never be the first to give up. When the proxy times out it answers a 504 in the
 * API's own error envelope, which `throwIfNotOk` turns into an ordinary `ApiError` — "the API did
 * not answer in time", a fact about the backend. If the client gave up first the user would get
 * "we stopped listening" instead, which is a different and less useful statement.
 */
export const CLIENT_MARGIN_MS = 5_000;

/** One row per route family. Method-sensitive: a GET on a settle path is not a settle. */
const BUDGETS: { method: string; pattern: RegExp; ms: number }[] = [
  { method: "POST", pattern: /^companies\/[^/]+\/payment\/(settle|cancel)$/, ms: BROADCAST_BUDGET_MS },
  { method: "POST", pattern: /^entities\/[^/]+\/agentbook\/register$/, ms: BROADCAST_BUDGET_MS },
  { method: "POST", pattern: /^entities\/[^/]+\/policy(\/execute)?$/, ms: RECEIPT_BUDGET_MS },
  // A document download hands back bytes and is the one call with no deadline: the budget exists
  // to end silent waits on a JSON API, not to cut a file off part-way.
  {
    method: "GET",
    pattern: /^companies\/[^/]+\/documents\/[^/]+$/,
    ms: Number.POSITIVE_INFINITY,
  },
];

/** `companies/x/payment/settle` — no leading slash, no query, the spelling the table matches. */
function route(path: string): string {
  return path.replace(/^\//, "").split("?")[0]!.split("#")[0]!;
}

/** The PROXY's time-to-first-byte budget for one request. `Infinity` = install no timer. */
export function budgetMs(method: string, path: string): number {
  const m = method.toUpperCase();
  const joined = route(path);
  return BUDGETS.find((b) => b.method === m && b.pattern.test(joined))?.ms ?? DEFAULT_TTFB_BUDGET_MS;
}

/** The CLIENT's budget for the same request: always the proxy's plus a margin. */
export function clientBudgetMs(method: string, path: string): number {
  const ms = budgetMs(method, path);
  return Number.isFinite(ms) ? ms + CLIENT_MARGIN_MS : ms;
}
