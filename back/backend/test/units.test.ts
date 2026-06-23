import { expect, test } from "vitest";
import { formatUnitsUsd, parseDuration, usdToUnits } from "../src/policy/units";

test("parseDuration handles suffixes and raw seconds", () => {
  expect(parseDuration("30d")).toBe(2_592_000n);
  expect(parseDuration("24h")).toBe(86_400n);
  expect(parseDuration("90m")).toBe(5_400n);
  expect(parseDuration("3600s")).toBe(3_600n);
  expect(parseDuration("3600")).toBe(3_600n);
  expect(parseDuration(3600)).toBe(3_600n);
});

test("parseDuration rejects garbage", () => {
  expect(() => parseDuration("soon")).toThrow(/duration/i);
  expect(() => parseDuration("-5m")).toThrow(/duration/i);
});

test("usdToUnits uses 6 decimals; formatUnitsUsd inverts", () => {
  expect(usdToUnits("1000.00")).toBe(1_000_000_000n);
  expect(usdToUnits("0.000001")).toBe(1n);
  expect(formatUnitsUsd(1_000_000_000n)).toBe("1000");
});

test("usdToUnits rejects non-USD strings", () => {
  expect(() => usdToUnits("ten dollars")).toThrow(/usd/i);
});
