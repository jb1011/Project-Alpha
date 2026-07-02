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

test("evaluatePolicy: rejects a single payment over the per-tx cap", () => {
  const base = {
    available: 1_000_000n,
    paused: false,
    allowlistEnabled: false,
    isAllowed: true,
    runningPending: 0n,
  };
  expect(evaluatePolicy({ ...base, amount: 30_000n, perTxCap: 20_000n })).toEqual({
    ok: false,
    reason: "over-tx-cap",
  });
  expect(evaluatePolicy({ ...base, amount: 10_000n, perTxCap: 20_000n })).toEqual({ ok: true });
  expect(evaluatePolicy({ ...base, amount: 20_000n, perTxCap: 20_000n })).toEqual({ ok: true }); // at-boundary allowed
  expect(evaluatePolicy({ ...base, amount: 30_000n })).toEqual({ ok: true }); // no cap set → allowed
});

test("hybrid: micro-payment (<= threshold) needs no allowlist", () => {
  const base = {
    available: 10_000_000n,
    paused: false,
    allowlistEnabled: false,
    isAllowed: false,
    runningPending: 0n,
  };
  expect(evaluatePolicy({ ...base, amount: 50_000n, threshold: 100_000n })).toEqual({ ok: true });
});

test("hybrid: above threshold requires an allowlisted payee", () => {
  const base = {
    available: 10_000_000n,
    paused: false,
    allowlistEnabled: false,
    isAllowed: false,
    runningPending: 0n,
  };
  expect(
    evaluatePolicy({ ...base, amount: 200_000n, threshold: 100_000n, isAllowed: false }),
  ).toEqual({ ok: false, reason: "over-threshold-needs-allowlist" });
  expect(
    evaluatePolicy({ ...base, amount: 200_000n, threshold: 100_000n, isAllowed: true }),
  ).toEqual({ ok: true });
});

test("no threshold set → hybrid rule inactive (back-compat)", () => {
  const base = {
    available: 10_000_000n,
    paused: false,
    allowlistEnabled: false,
    isAllowed: false,
    runningPending: 0n,
  };
  expect(evaluatePolicy({ ...base, amount: 999_999n })).toEqual({ ok: true });
});

test("explicit on-chain allowlist still wins for any non-allowed payee", () => {
  const base = {
    available: 10_000_000n,
    paused: false,
    allowlistEnabled: false,
    isAllowed: false,
    runningPending: 0n,
  };
  expect(evaluatePolicy({ ...base, amount: 1n, allowlistEnabled: true, isAllowed: false })).toEqual(
    { ok: false, reason: "not-allowlisted" },
  );
});
