import { afterEach, expect, test, vi } from "vitest";
import {
  UPSTREAM_TIMEOUT_BODY,
  UPSTREAM_TIMEOUT_HEADERS,
  UPSTREAM_TIMEOUT_STATUS,
  UPSTREAM_TTFB_TIMEOUT_MS,
  fetchFirstByte,
} from "@/lib/upstreamTimeout";

/**
 * The proxy's half of "nothing waits forever" — and the one constraint that makes it delicate:
 * the same route proxies the MCP endpoint's SSE stream, so a timeout over the WHOLE response
 * would cut a healthy long-lived stream. Only the time to FIRST BYTE is bounded.
 *
 * Fake timers work here, deliberately: the helper uses `AbortController` + `setTimeout` rather
 * than `AbortSignal.timeout`, which Node does not expose to a test's clock.
 */

afterEach(() => {
  vi.useRealTimers();
});

/** A fetch that resolves headers when told to, then hands back a body nobody has read yet. */
function deferred() {
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("an upstream that never answers times out", async () => {
  vi.useFakeTimers();
  const seen: AbortSignal[] = [];
  const pending = fetchFirstByte((signal) => {
    seen.push(signal);
    return new Promise<Response>((_res, rej) => {
      signal.addEventListener("abort", () => rej(signal.reason));
    });
  }, 1_000);
  await vi.advanceTimersByTimeAsync(1_001);
  await expect(pending).resolves.toEqual({ timedOut: true });
  expect(seen[0]!.aborted).toBe(true);
});

test("⚠ A STREAMED BODY IS NEVER CUT: the timer stops when the headers arrive", async () => {
  // The regression this test exists for. If the timer outlived the `fetch`, the MCP endpoint's
  // SSE stream would be aborted mid-conversation at exactly 25 seconds, every time.
  vi.useFakeTimers();
  const d = deferred();
  let signal!: AbortSignal;
  const pending = fetchFirstByte((s) => {
    signal = s;
    return d.promise;
  }, 1_000);

  await vi.advanceTimersByTimeAsync(500);
  d.resolve(new Response("data: hello\n\n", { status: 200 }));
  const result = await pending;
  expect(result).toMatchObject({ timedOut: false });

  // Long past the budget, while the body is still streaming.
  await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
  expect(signal.aborted).toBe(false);
  expect("res" in result && (await result.res.text())).toBe("data: hello\n\n");
});

test("a fast upstream is handed straight back", async () => {
  const result = await fetchFirstByte(async () => new Response("{}", { status: 201 }));
  expect(result).toMatchObject({ timedOut: false });
  expect("res" in result && result.res.status).toBe(201);
});

test("a real upstream error is rethrown, not disguised as a timeout", async () => {
  // ECONNREFUSED is a different fact from "slow", and the browser needs to be able to tell them
  // apart. The route's own error handling owns this case.
  await expect(
    fetchFirstByte(async () => {
      throw new TypeError("fetch failed");
    }),
  ).rejects.toThrow(/fetch failed/);
});

test("an upstream error AFTER an abort is reported as the timeout it was", async () => {
  vi.useFakeTimers();
  const pending = fetchFirstByte((signal) => {
    return new Promise<Response>((_res, rej) => {
      // What undici really does: it rejects with its own error once the signal fires.
      signal.addEventListener("abort", () => rej(new TypeError("terminated")));
    });
  }, 1_000);
  await vi.advanceTimersByTimeAsync(1_001);
  await expect(pending).resolves.toEqual({ timedOut: true });
});

test("the 504 answer is the API's own error envelope, and uncacheable", () => {
  // The same `{ error: { code, message } }` shape `back/backend/src/api/errors.ts` produces, so
  // the client's one error path reads a proxy timeout exactly as it reads a backend refusal.
  expect(UPSTREAM_TIMEOUT_STATUS).toBe(504);
  expect(UPSTREAM_TIMEOUT_BODY).toEqual({
    error: { code: "upstream_timeout", message: "The API did not answer in time." },
  });
  expect(UPSTREAM_TIMEOUT_HEADERS["cache-control"]).toBe("no-store");
  expect(UPSTREAM_TIMEOUT_HEADERS["content-type"]).toContain("application/json");
});

test("the budget sits under a typical platform gateway limit", () => {
  expect(UPSTREAM_TTFB_TIMEOUT_MS).toBe(25_000);
});
