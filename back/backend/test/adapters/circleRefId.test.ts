import { describe, expect, test } from "vitest";
import {
  CIRCLE_REF_ID_MAX,
  CircleRefIdTooLongError,
  circleRefId,
} from "../../src/adapters/circle/circleRefId";

describe("circleRefId — the one place a Circle refId is built", () => {
  test("the limit is 100 characters, measured, not guessed", () => {
    expect(CIRCLE_REF_ID_MAX).toBe(100);
  });

  test("joins the parts with ':' and returns them whole", () => {
    expect(circleRefId(["job", "e-1", "run-1", "setBudget"])).toBe("job:e-1:run-1:setBudget");
    expect(circleRefId(["only"])).toBe("only");
  });

  test("99 and 100 characters are accepted, byte for byte", () => {
    const at99 = circleRefId(["a".repeat(97), "b"]);
    expect(at99).toHaveLength(99);
    const at100 = circleRefId(["a".repeat(98), "b"]);
    expect(at100).toHaveLength(100);
    expect(at100).toBe(`${"a".repeat(98)}:b`);
  });

  test("101 characters THROWS, naming the limit and the offending length", () => {
    const err = (() => {
      try {
        circleRefId(["a".repeat(99), "b"]);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(CircleRefIdTooLongError);
    expect(err?.message).toContain("101");
    expect(err?.message).toContain("100");
    expect((err as CircleRefIdTooLongError).length).toBe(101);
  });

  test("never truncates: an over-long refId is refused, not shortened", () => {
    // A truncated refId can collide, and Circle now lets us filter transactions BY refId — so it
    // is a lookup key, and a colliding lookup key is worse than a refused request.
    expect(() => circleRefId(["x".repeat(200)])).toThrow(CircleRefIdTooLongError);
  });

  test("an empty part is refused: a blank segment collides with its neighbours", () => {
    expect(() => circleRefId(["job", "", "setBudget"])).toThrow(/empty/i);
    expect(() => circleRefId([])).toThrow(/empty/i);
  });
});
