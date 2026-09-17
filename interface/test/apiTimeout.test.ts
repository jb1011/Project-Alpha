import { afterEach, expect, test, vi } from "vitest";
import { healthCheck } from "@/lib/api/client";
import { REQUEST_TIMEOUT_MS, TIMEOUT_MESSAGE, fetchWithTimeout } from "@/lib/api/timeout";
import { ApiError } from "@/lib/api/types";

/**
 * 2026-09-16, the second half: nothing in this client bounded a request, so a stalled backend (or
 * a stalled proxy in front of it) was an infinite spinner with no error anywhere.
 *
 * ⚠ TIMERS ARE REAL HERE, with a 5 ms budget, because vitest's fake timers do NOT drive Node's
 * `AbortSignal.timeout` (verified: `advanceTimersByTimeAsync` leaves the signal un-aborted, while
 * a hand-rolled `setTimeout` + `AbortController` does fire). Faking them would have tested the
 * fake rather than the code.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch that never answers but honours cancellation, like a real stalled socket. */
function stalledFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
}

test("a stalled request becomes an ApiError with code `timeout`", async () => {
  vi.stubGlobal("fetch", stalledFetch());
  const err = await fetchWithTimeout("/backend/healthz", {}, 5).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  const api = err as ApiError;
  expect(api.code).toBe("timeout");
  expect(api.message).toBe(TIMEOUT_MESSAGE);
  // No response ever arrived, so there is no HTTP status to report. Deliberately NOT 504: that
  // would be a claim about a gateway that never spoke.
  expect(api.status).toBe(0);
});

test("a request that answers in time is untouched, and the budget is attached", async () => {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const res = await fetchWithTimeout("/backend/healthz", {});
  expect(res.status).toBe(200);
  const init = fetchMock.mock.calls[0]![1]!;
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.signal!.aborted).toBe(false);
});

test("a non-timeout fetch failure is passed through as itself", async () => {
  // A DNS failure or an offline browser must not be reported as a slow server.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  const err = await fetchWithTimeout("/backend/healthz", {}).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TypeError);
  expect(err).not.toBeInstanceOf(ApiError);
});

test("the client's own calls are bounded — the 2026-09-16 infinite spinner", async () => {
  // Through the real public surface, so the wiring inside `request()` is what is under test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }),
  );
  const err = await healthCheck().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("timeout");
  expect((err as ApiError).message).toBe(TIMEOUT_MESSAGE);
});

test("every client call carries a signal", async () => {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await healthCheck();
  expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
});

test("the default budget is 30 seconds — long enough for a real call, short enough to end", () => {
  expect(REQUEST_TIMEOUT_MS).toBe(30_000);
});

test("the copy says what happened and what to do, and claims nothing about the write", () => {
  // A timed-out POST may well have been applied. "Try again" is advice; "nothing was sent" would
  // be a statement, and we are not entitled to it.
  expect(TIMEOUT_MESSAGE).toBe("The server took too long to answer. Try again.");
  expect(TIMEOUT_MESSAGE.toLowerCase()).not.toContain("nothing was");
});
