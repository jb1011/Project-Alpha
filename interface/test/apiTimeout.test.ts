import { afterEach, expect, test, vi } from "vitest";
import * as budgets from "@/lib/api/budgets";
import { healthCheck, schedulePolicyUpdate } from "@/lib/api/client";
import {
  REQUEST_TIMEOUT_MS,
  TIMEOUT_MESSAGE,
  fetchWithTimeout,
  readJsonBounded,
} from "@/lib/api/timeout";
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

/* ── Minors from the interface review ───────────────────────────────────────────────────────── */

test("R4: an abort during the BODY read surfaces as the timeout, not as null data", () => {
  // The silent failure in the file whose purpose is to end silent failures: headers at 29.5s, body
  // cut at 30s, and `res.json().catch(() => null)` handed the caller `null` typed as `T`.
  const aborted = {
    json: async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  } as unknown as Response;
  const err = readJsonBounded(aborted).catch((e: unknown) => e);
  return err.then((e) => {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("timeout");
  });
});

test("R4: a body that is simply not JSON still reads as null", () => {
  // The behaviour the `.catch(() => null)` existed for — a 204, or an empty body — is unchanged.
  const empty = {
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  } as unknown as Response;
  return expect(readJsonBounded(empty)).resolves.toBeNull();
});

test("R5: a caller's own signal is COMPOSED with the budget, not overridden", async () => {
  const seen: (AbortSignal | null | undefined)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(init.signal?.reason));
      });
    }),
  );
  const caller = new AbortController();
  const pending = fetchWithTimeout("/backend/healthz", { signal: caller.signal }, 60_000).catch(
    (e: unknown) => e,
  );
  // The CALLER aborts, long before the budget. That must not be reported as a slow server.
  caller.abort(new DOMException("caller changed their mind", "AbortError"));
  const err = await pending;
  expect(err).not.toBeInstanceOf(ApiError);
  // …and the signal handed to fetch is neither the caller's alone nor the budget's alone.
  expect(seen[0]).toBeInstanceOf(AbortSignal);
  expect(seen[0]).not.toBe(caller.signal);
});

test("R5: the budget still fires when a caller's signal is present", async () => {
  vi.stubGlobal("fetch", stalledFetch());
  const caller = new AbortController();
  const err = await fetchWithTimeout("/backend/healthz", { signal: caller.signal }, 5).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("timeout");
});

test("R3/I-R2: a per-call budget reaches fetch, and the slow routes use the table", async () => {
  // The knob existed and nothing turned it. These four calls hit handlers that broadcast and then
  // wait for a receipt; on a direct-to-API deployment (NEXT_PUBLIC_API_URL set, no proxy) the 30s
  // default reported a policy schedule that was mining as a timeout.
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ txHash: "0x1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(budgets, "clientBudgetMs");

  await schedulePolicyUpdate("t", "0xabc", {
    capUsdc: "1",
    periodSeconds: 60,
    allowlistOn: false,
    payoutAddress: "0x0000000000000000000000000000000000000001",
  });
  // The client asks the shared table, with the method and path of the call it is making.
  expect(budgets.clientBudgetMs).toHaveBeenCalledWith("POST", "/entities/0xabc/policy");
  // …and the answer is the policy budget plus the client's margin, not the 30s default.
  expect(budgets.clientBudgetMs("POST", "/entities/0xabc/policy")).toBe(245_000);
});

test("the copy says what happened and what to do, and claims nothing about the write", () => {
  // A timed-out POST may well have been applied. "Try again" is advice; "nothing was sent" would
  // be a statement, and we are not entitled to it.
  expect(TIMEOUT_MESSAGE).toBe("The server took too long to answer. Try again.");
  expect(TIMEOUT_MESSAGE.toLowerCase()).not.toContain("nothing was");
});
