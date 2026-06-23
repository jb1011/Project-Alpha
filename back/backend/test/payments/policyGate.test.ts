import { expect, test } from "vitest";
import { evaluatePolicy } from "../../src/payments/policyGate";

const base = {
  payee: "0x0000000000000000000000000000000000000abc" as const,
  amount: 100n,
  available: 1_000n,
  paused: false,
  allowlistEnabled: true,
  isAllowed: true,
  runningPending: 0n,
};

test("allows a within-cap, allowlisted, unpaused payment", () => {
  expect(evaluatePolicy(base)).toEqual({ ok: true });
});

test("denies when paused", () => {
  expect(evaluatePolicy({ ...base, paused: true })).toEqual({ ok: false, reason: "paused" });
});

test("denies a non-allowlisted payee when allowlist is on", () => {
  expect(evaluatePolicy({ ...base, isAllowed: false })).toEqual({
    ok: false,
    reason: "not-allowlisted",
  });
});

test("ignores allowlist when disabled", () => {
  expect(evaluatePolicy({ ...base, allowlistEnabled: false, isAllowed: false })).toEqual({
    ok: true,
  });
});

test("denies when runningPending + amount exceeds available", () => {
  expect(evaluatePolicy({ ...base, runningPending: 950n, amount: 100n })).toEqual({
    ok: false,
    reason: "over-cap",
  });
});

test("allows when runningPending + amount exactly equals available (boundary)", () => {
  expect(evaluatePolicy({ ...base, runningPending: 900n, amount: 100n })).toEqual({ ok: true });
});

test("denies zero amount", () => {
  expect(evaluatePolicy({ ...base, amount: 0n })).toEqual({ ok: false, reason: "zero-amount" });
});

test("denies negative amount", () => {
  expect(evaluatePolicy({ ...base, amount: -1n })).toEqual({ ok: false, reason: "zero-amount" });
});
