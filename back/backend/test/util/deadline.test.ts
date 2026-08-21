/**
 * The ONE shared call deadline (review A1).
 *
 * The property that matters is not "the promise rejects" — a bare `setTimeout` race does that
 * while leaving the request (and its socket) alive. It is that the work is CANCELLED: the signal
 * handed to `work` is aborted when the deadline fires, so a hung fetch whose BODY never resolves
 * is actually torn down instead of merely being abandoned.
 */
import { expect, test, vi } from "vitest";
import { DeadlineExceededError, withDeadline } from "../../src/util/deadline";

test("A1: work that never settles rejects at the deadline AND its signal is aborted", async () => {
  let seen: AbortSignal | undefined;
  const p = withDeadline(15, (signal) => {
    seen = signal;
    return new Promise<never>(() => {}); // never resolves, never rejects
  });
  await expect(p).rejects.toBeInstanceOf(DeadlineExceededError);
  expect(seen?.aborted).toBe(true);
});

test("A1: a fetch whose BODY never resolves rejects at the deadline and the signal is aborted", async () => {
  // The realistic shape: headers arrive, the body stream then stalls forever. A deadline that
  // only wrapped the fetch call would have resolved already and hung on the read below.
  let seen: AbortSignal | undefined;
  const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    seen = init?.signal;
    return {
      status: 200,
      text: () => new Promise<string>(() => {}), // the body never completes
    };
  });

  await expect(
    withDeadline(
      15,
      async (signal) => {
        const res = await fetchImpl("https://host.example", { signal });
        return res.text(); // INSIDE the deadline — this is the half a naive wrapper misses
      },
      () => new Error("call deadline"),
    ),
  ).rejects.toThrow(/call deadline/);
  expect(seen?.aborted).toBe(true);
});

test("work that settles first wins, and the deadline error factory is honored", async () => {
  expect(await withDeadline(1_000, async () => "done")).toBe("done");
  await expect(withDeadline(1_000, async () => Promise.reject(new Error("inner")))).rejects.toThrow(
    /inner/,
  );
  class Typed extends Error {}
  await expect(
    withDeadline(
      5,
      () => new Promise<never>(() => {}),
      () => new Typed("typed"),
    ),
  ).rejects.toBeInstanceOf(Typed);
});

test("a SYNCHRONOUS throw inside work rejects immediately (and disarms the timer)", async () => {
  await expect(
    withDeadline(5_000, () => {
      throw new Error("sync boom");
    }),
  ).rejects.toThrow(/sync boom/);
});
