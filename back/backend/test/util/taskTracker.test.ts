/**
 * The background-task tracker (design §6 step 5, §7 shutdown).
 *
 * It exists so that work nobody is awaiting is still findable: by SIGTERM, which must drain it,
 * and by tests, which must join on it instead of sleeping.
 */
import { expect, test } from "vitest";
import { TaskTracker } from "../../src/util/taskTracker";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("settled() waits for in-flight work and then reports an empty tracker", async () => {
  const t = new TaskTracker("test_task");
  let done = false;
  t.track(async () => {
    await tick(20);
    done = true;
  });
  expect(t.size).toBe(1);
  expect(await t.settled()).toBe(true);
  expect(done).toBe(true);
  expect(t.size).toBe(0);
});

test("a task that starts ANOTHER task is still drained — the wait is a loop, not a snapshot", async () => {
  // A webhook wake-up that schedules a follow-up fetch is exactly this shape, and awaiting one
  // snapshot of the set would return with the second task still running.
  const t = new TaskTracker("test_task");
  let inner = false;
  t.track(async () => {
    await tick(10);
    t.track(async () => {
      await tick(10);
      inner = true;
    });
  });
  expect(await t.settled()).toBe(true);
  expect(inner).toBe(true);
});

test("a rejecting task is logged, never rethrown, and never left unhandled", async () => {
  const t = new TaskTracker("test_task");
  t.track(async () => {
    throw new Error("doola unreachable");
  });
  // An unhandled rejection here would take the API process down on a provider outage.
  await expect(t.settled()).resolves.toBe(true);
  // A SYNCHRONOUS throw before the first await is the same story, and remembers no task.
  t.track(() => {
    throw new Error("bad wiring");
  });
  expect(t.size).toBe(0);
});

test("settled(timeoutMs) gives up rather than hanging a deploy on a wedged task", async () => {
  const t = new TaskTracker("test_task");
  t.track(() => new Promise(() => undefined)); // never settles
  const started = Date.now();
  expect(await t.settled(30)).toBe(false);
  expect(Date.now() - started).toBeLessThan(2000);
  // The task is still remembered — the tracker reports the truth, it does not forget the work.
  expect(t.size).toBe(1);
});

test("settled() on an empty tracker resolves immediately", async () => {
  expect(await new TaskTracker().settled(0)).toBe(true);
});

// ── M5: coalescing a burst of wake-ups for one company ────────────────────────────────────

test("M5: items arriving during a run are batched into exactly ONE further run", async () => {
  // doola's retry ladder plus a busy formation deliver several events for one company in
  // seconds. A wake-up carries no facts — every one of them is the same request, "look again" —
  // so one read answers all of them. The trailing edge is the point: an item that arrives DURING
  // a run is not dropped, because that run may have read doola before the change it is about.
  const tracker = new TaskTracker("t");
  const batches: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  tracker.trackCoalesced("cmp-1", "a", async (items) => {
    batches.push([...items]);
    await gate; // hold the first run open so the rest pile up behind it
  });
  tracker.trackCoalesced("cmp-1", "b", async (items) => {
    batches.push([...items]);
  });
  tracker.trackCoalesced("cmp-1", "c", async (items) => {
    batches.push([...items]);
  });

  release();
  await tracker.settled(1000);
  // Two runs, not three: the first, then ONE batch carrying everything that arrived during it.
  expect(batches).toEqual([["a"], ["b", "c"]]);
});

test("M5: different keys never coalesce with each other", async () => {
  const tracker = new TaskTracker("t");
  const seen: string[] = [];
  tracker.trackCoalesced("cmp-1", "a", async (items) => {
    seen.push(`1:${items.join(",")}`);
  });
  tracker.trackCoalesced("cmp-2", "b", async (items) => {
    seen.push(`2:${items.join(",")}`);
  });
  await tracker.settled(1000);
  expect(seen.sort()).toEqual(["1:a", "2:b"]);
});

test("M5: a throwing run is logged and never strands the batch queued behind it", async () => {
  const tracker = new TaskTracker("t");
  const batches: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  tracker.trackCoalesced("cmp-1", "a", async (items) => {
    batches.push([...items]);
    await gate;
    throw new Error("doola is down");
  });
  tracker.trackCoalesced("cmp-1", "b", async (items) => {
    batches.push([...items]);
  });
  release();
  expect(await tracker.settled(1000)).toBe(true);
  expect(batches).toEqual([["a"], ["b"]]);
});
