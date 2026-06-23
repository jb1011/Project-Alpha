import { expect, test } from "vitest";
import { priceAnswer } from "../../src/agent/pricing";

test("price = ceil(totalCost * (1 + margin))", () => {
  expect(priceAnswer(100n, 0.5)).toBe(150n);
  expect(priceAnswer(101n, 0.5)).toBe(152n); // ceil(151.5)
  expect(priceAnswer(0n, 0.5)).toBe(0n);
});
