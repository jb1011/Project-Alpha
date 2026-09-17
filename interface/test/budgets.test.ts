import { expect, test } from "vitest";
import {
  CLIENT_MARGIN_MS,
  DEFAULT_TTFB_BUDGET_MS,
  budgetMs,
  clientBudgetMs,
} from "@/lib/api/budgets";

/**
 * I-R2: the time budget is a property of the ROUTE, and the proxy and the client read the same
 * table.
 *
 * Two families answer only after their whole handler finishes (hono's `c.json`, so time-to-first-
 * byte IS total handler time) and both can legitimately outlast a 25-second default: a formation
 * payment settle broadcasts and then waits 12s for a receipt, and a policy schedule/execute waits
 * on viem's 180-second receipt default. A shared 25s made the proxy the binding limit and turned a
 * settling payment into "The API did not answer in time."
 */

test("the default is 25 seconds", () => {
  expect(DEFAULT_TTFB_BUDGET_MS).toBe(25_000);
  expect(budgetMs("GET", "entities/0xabc")).toBe(25_000);
  expect(budgetMs("POST", "onboard")).toBe(25_000);
  expect(budgetMs("POST", "entities/0xabc/fund")).toBe(25_000);
  expect(budgetMs("GET", "healthz")).toBe(25_000);
});

test("formation payment settle and cancel get 60 seconds", () => {
  // verify (an ERC-1271 eth_call) + getBlock + nonce reads + fee estimate + broadcast + a 12s
  // receipt wait (ROUTE_RECEIPT_TIMEOUT_MS). ~13-15s healthy, and every read retries 3× on a
  // throttled RPC.
  expect(budgetMs("POST", "companies/cmp_1/payment/settle")).toBe(60_000);
  expect(budgetMs("POST", "companies/cmp_1/payment/cancel")).toBe(60_000);
});

test("the AgentBook register route gets 60 seconds", () => {
  // Four World Chain round trips plus a sign and a broadcast, no receipt wait.
  expect(budgetMs("POST", "entities/0xabc/agentbook/register")).toBe(60_000);
});

test("policy schedule and execute get 240 seconds — viem's receipt default plus margin", () => {
  // `sendManagerCallConfirmed` = simulate + send + waitForTransactionReceipt with NO explicit
  // timeout, i.e. viem's 180s default. A budget under that would 504 a transaction that is mining.
  expect(budgetMs("POST", "entities/0xabc/policy")).toBe(240_000);
  expect(budgetMs("POST", "entities/0xabc/policy/execute")).toBe(240_000);
});

test("a document download is UNBOUNDED, and unbounded means no timer rather than a huge one", () => {
  expect(budgetMs("GET", "companies/cmp_1/documents/doc_1")).toBe(Number.POSITIVE_INFINITY);
  // ⚠ The callers must treat this as "install no timer": `setTimeout(fn, Infinity)` fires
  // IMMEDIATELY in Node (TimeoutOverflowWarning, clamped to 1ms) and `AbortSignal.timeout(Infinity)`
  // throws, so a budget that is not finite has to be handled, not passed through.
  expect(Number.isFinite(budgetMs("GET", "companies/cmp_1/documents/doc_1"))).toBe(false);
});

test("the table is METHOD-sensitive", () => {
  // A GET on the settle path is not the settle; a POST to a document path is not the download.
  expect(budgetMs("GET", "companies/cmp_1/payment/settle")).toBe(25_000);
  expect(budgetMs("POST", "companies/cmp_1/documents/doc_1")).toBe(25_000);
  expect(budgetMs("get", "companies/cmp_1/documents/doc_1")).toBe(Number.POSITIVE_INFINITY);
});

test("near misses do not inherit a long budget", () => {
  for (const path of [
    "companies/cmp_1/payment",
    "companies/cmp_1/payment/requote",
    "companies/cmp_1/payment/settle/extra",
    "entities/0xabc/policy/executed",
    "entities/0xabc/agentbook/session",
    "entities/0xabc/agentbook",
  ])
    expect(budgetMs("POST", path), path).toBe(25_000);
});

test("a leading slash makes no difference — the proxy and the client spell paths differently", () => {
  // The proxy holds `joined` ("companies/x/payment/settle"); the client holds a path with a
  // leading slash. One table, two spellings, so it has to normalise.
  expect(budgetMs("POST", "/companies/cmp_1/payment/settle")).toBe(60_000);
  // …and a query string is not part of the route.
  expect(budgetMs("POST", "/companies/cmp_1/payment/settle?x=1")).toBe(60_000);
  expect(budgetMs("GET", "/entities/0xabc")).toBe(25_000);
});

test("the CLIENT always waits longer than the proxy, so the proxy's answer is what is shown", () => {
  // A client that gave up first would replace the proxy's 504 envelope — which the client's own
  // error path renders as a normal ApiError — with its own "took too long", losing the
  // distinction between "the API did not answer" and "we stopped listening".
  expect(CLIENT_MARGIN_MS).toBe(5_000);
  expect(clientBudgetMs("GET", "entities/0xabc")).toBe(30_000);
  expect(clientBudgetMs("POST", "companies/cmp_1/payment/settle")).toBe(65_000);
  expect(clientBudgetMs("POST", "entities/0xabc/policy")).toBe(245_000);
  // Unbounded stays unbounded: Infinity + 5s is Infinity.
  expect(clientBudgetMs("GET", "companies/cmp_1/documents/doc_1")).toBe(Number.POSITIVE_INFINITY);
});
