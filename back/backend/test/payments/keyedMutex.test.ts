import { expect, test, vi } from "vitest";
import { withKeyedLock } from "../../src/payments/keyedMutex";

const tick = () => new Promise((r) => setTimeout(r, 1));

test("same-key tasks run strictly serially (no interleave)", async () => {
  const events: string[] = [];
  const task = (id: string) =>
    withKeyedLock("agentA", async () => {
      events.push(`${id}-start`);
      await tick();
      events.push(`${id}-end`);
    });
  await Promise.all([task("1"), task("2")]);
  expect(events).toEqual(["1-start", "1-end", "2-start", "2-end"]);
});

test("different keys run concurrently", async () => {
  const events: string[] = [];
  const task = (key: string, id: string) =>
    withKeyedLock(key, async () => {
      events.push(`${id}-start`);
      await tick();
      events.push(`${id}-end`);
    });
  await Promise.all([task("A", "a"), task("B", "b")]);
  // both start before either ends
  expect(events.slice(0, 2).sort()).toEqual(["a-start", "b-start"]);
});

test("a prior task's rejection does not block the next same-key task", async () => {
  await expect(
    withKeyedLock("agentA", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow(/boom/);
  const r = await withKeyedLock("agentA", async () => "ok");
  expect(r).toBe("ok");
});

test("returns the wrapped function's resolved value", async () => {
  const r = await withKeyedLock("k", async () => 42);
  expect(r).toBe(42);
});
