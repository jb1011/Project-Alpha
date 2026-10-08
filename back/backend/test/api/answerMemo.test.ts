/**
 * The memo both public legal-body routes keep: the last definitive answer per key, for a window,
 * holding at most a bound of keys, the oldest write evicted first. It keeps a plain map's order:
 * reading an answer neither renews its window nor moves it, an answer read after its window is
 * deleted by that read, and a key written again while live keeps its slot.
 */
import { expect, test } from "vitest";
import { AnswerMemo } from "../../src/api/routes/legalBodies";

/** A memo of strings on a clock the test moves. */
function memoOn(ttlMs: number, maxEntries: number) {
  const clock = { now: 1_000_000 };
  return { memo: new AnswerMemo<string>(ttlMs, maxEntries, () => clock.now), clock };
}

test("an answer is served until its window ends, and is gone at its end", () => {
  const { memo, clock } = memoOn(15_000, 10);
  memo.set("a", "first");
  expect(memo.get("a")).toBe("first");
  clock.now += 14_999;
  expect(memo.get("a")).toBe("first");
  clock.now += 1;
  expect(memo.get("a")).toBeUndefined();
});

test("a key never written is not an answer", () => {
  const { memo } = memoOn(15_000, 10);
  expect(memo.get("a")).toBeUndefined();
  memo.set("a", "first");
  expect(memo.get("b")).toBeUndefined();
});

test("a hit does not renew the window", () => {
  const { memo, clock } = memoOn(15_000, 10);
  memo.set("a", "first");
  clock.now += 10_000;
  expect(memo.get("a")).toBe("first");
  clock.now += 5_000;
  expect(memo.get("a")).toBeUndefined();
});

test("a read after the window deletes the entry: written again, the key takes the newest slot", () => {
  const { memo, clock } = memoOn(100, 2);
  memo.set("a", "first");
  clock.now += 50;
  memo.set("b", "b");
  clock.now += 50;
  // `a`'s window is over: the read answers nothing and deletes it.
  expect(memo.get("a")).toBeUndefined();
  memo.set("a", "second");
  memo.set("c", "c");
  // Had the read left `a` in place, writing it again would have kept its first slot and it would
  // have gone first. Deleted, it was written last but one: `b` is now the oldest write.
  expect(memo.get("b")).toBeUndefined();
  expect(memo.get("a")).toBe("second");
  expect(memo.get("c")).toBe("c");
});

test("above the bound, the oldest write is evicted first", () => {
  const { memo } = memoOn(15_000, 3);
  for (const key of ["a", "b", "c", "d"]) memo.set(key, key);
  expect(memo.get("a")).toBeUndefined();
  expect(["b", "c", "d"].map((key) => memo.get(key))).toEqual(["b", "c", "d"]);
  memo.set("e", "e");
  expect(memo.get("b")).toBeUndefined();
  expect(["c", "d", "e"].map((key) => memo.get(key))).toEqual(["c", "d", "e"]);
});

test("a hit is not re-inserted: the answer read keeps its place and is still evicted first", () => {
  const { memo } = memoOn(15_000, 2);
  memo.set("a", "a");
  memo.set("b", "b");
  expect(memo.get("a")).toBe("a");
  memo.set("c", "c");
  // `a` was read, not written: it is still the oldest write.
  expect(memo.get("a")).toBeUndefined();
  expect(memo.get("b")).toBe("b");
  expect(memo.get("c")).toBe("c");
});

test("a key written again while live keeps its first slot: it is still the oldest write", () => {
  const { memo } = memoOn(15_000, 2);
  memo.set("a", "first");
  memo.set("b", "b");
  memo.set("a", "second");
  expect(memo.get("a")).toBe("second");
  memo.set("c", "c");
  // `a` was written before `b`, and writing it again did not move it.
  expect(memo.get("a")).toBeUndefined();
  expect(memo.get("b")).toBe("b");
  expect(memo.get("c")).toBe("c");
});

test("a key written again while live gets a window from the new write", () => {
  const { memo, clock } = memoOn(100, 10);
  memo.set("a", "first");
  clock.now += 90;
  memo.set("a", "second");
  // 150 ms after the first write, 60 ms after the second.
  clock.now += 60;
  expect(memo.get("a")).toBe("second");
  clock.now += 40;
  expect(memo.get("a")).toBeUndefined();
});

test("the bound holds however many keys are written: the newest stay, the oldest are gone", () => {
  const { memo } = memoOn(15_000, 1_000);
  for (let i = 0; i < 2_500; i += 1) memo.set(`k${i}`, `v${i}`);
  let held = 0;
  for (let i = 0; i < 2_500; i += 1) if (memo.get(`k${i}`) !== undefined) held += 1;
  expect(held).toBe(1_000);
  expect(memo.get("k1499")).toBeUndefined();
  expect(memo.get("k1500")).toBe("v1500");
  expect(memo.get("k2499")).toBe("v2499");
});
