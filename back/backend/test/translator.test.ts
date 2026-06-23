import { expect, test } from "vitest";
import { type AgentSpec, parseAgentSpec } from "../src/policy/agentSpec";
import { TranslationError, assertOperatorDistinct, translate } from "../src/policy/translator";

const USDC = "0x3600000000000000000000000000000000000000" as const;

const rawValid = {
  name: "A",
  roles: {
    manager: "0x0000000000000000000000000000000000000001",
    guardian: "0x0000000000000000000000000000000000000002",
  },
  treasury: {
    payoutAddress: "0x0000000000000000000000000000000000000003",
    spendingCapUsdc: "1000.00",
    spendingPeriod: "30d",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
};
const valid = (): AgentSpec => parseAgentSpec(rawValid);

test("translate maps legal terms to the exact on-chain param tuple", () => {
  const r = translate(valid(), { usdc: USDC });
  expect(r.amendmentDelay).toBe(86_400n);
  expect(r.treasury.cap).toBe(1_000_000_000n); // 1000 USDC, 6 decimals
  expect(r.treasury.period).toBe(2_592_000n); // 30d
  expect(r.treasury.usdc).toBe(USDC);
  expect(r.treasury.payoutAddress).toBe("0x0000000000000000000000000000000000000003");
  expect(r.manager).toBe("0x0000000000000000000000000000000000000001");
  expect(r.legal.ein).toBe("STUB-NOT-FILED");
});

test("translate parses an ISO formationDate to unix seconds", () => {
  const r = translate(parseAgentSpec({ ...rawValid, legal: { formationDate: "2026-06-10" } }), {
    usdc: USDC,
  });
  expect(r.legal.formationDate).toBe(Math.floor(Date.UTC(2026, 5, 10) / 1000));
});

// NEGATIVE cases construct invalid input by overriding fields on an already-parsed spec,
// which BYPASSES parseAgentSpec — so they exercise the translator's OWN defense-in-depth guards
// (the schema would otherwise reject these inputs before translate() ever runs).

test("translate rejects an amendmentDelay below the 1h on-chain minimum (defense-in-depth)", () => {
  const bad: AgentSpec = { ...valid(), governance: { amendmentDelay: 1800 } }; // 30m
  expect(() => translate(bad, { usdc: USDC })).toThrow(TranslationError);
});

test("translate rejects a spending period above the 365d on-chain maximum", () => {
  const v = valid();
  const bad: AgentSpec = { ...v, treasury: { ...v.treasury, spendingPeriod: 400 * 86_400 } };
  expect(() => translate(bad, { usdc: USDC })).toThrow(/period/i);
});

test("translate enforces manager/guardian distinctness (defense-in-depth)", () => {
  const v = valid();
  const bad: AgentSpec = { ...v, roles: { ...v.roles, guardian: v.roles.manager } };
  expect(() => translate(bad, { usdc: USDC })).toThrow(/distinct/i);
});

test("translate enforces payout != operator when operator is pinned", () => {
  const v = valid();
  const bad: AgentSpec = { ...v, roles: { ...v.roles, operator: v.treasury.payoutAddress } };
  expect(() => translate(bad, { usdc: USDC })).toThrow(/payout/i);
});

test("assertOperatorDistinct rejects an operator colliding with payout or a role", () => {
  const r = translate(valid(), { usdc: USDC });
  expect(() => assertOperatorDistinct(r, r.treasury.payoutAddress)).toThrow(/payout/i);
  expect(() => assertOperatorDistinct(r, r.manager)).toThrow(/distinct/i);
});

// ---------------------------------------------------------------------------
// Boundary-value tests added during M2.3 hardening review
// ---------------------------------------------------------------------------

test("exact lower boundary: amendmentDelay '1h' is valid and yields 3600n", () => {
  const r = translate(parseAgentSpec({ ...rawValid, governance: { amendmentDelay: "1h" } }), {
    usdc: USDC,
  });
  expect(r.amendmentDelay).toBe(3600n);
});

test("exact upper boundary: spendingPeriod '365d' is valid and yields 31_536_000n", () => {
  const r = translate(
    parseAgentSpec({
      ...rawValid,
      treasury: { ...rawValid.treasury, spendingPeriod: "365d" },
    }),
    { usdc: USDC },
  );
  expect(r.treasury.period).toBe(31_536_000n);
});

test("translate rejects a spending period of 0 (bypass parse — defense-in-depth)", () => {
  const bad: AgentSpec = { ...valid(), treasury: { ...valid().treasury, spendingPeriod: 0 } };
  expect(() => translate(bad, { usdc: USDC })).toThrow(TranslationError);
});

test("translate rejects a malformed formationDate (bypass parse — defense-in-depth)", () => {
  const bad: AgentSpec = { ...valid(), legal: { formationDate: "not-a-date" } };
  expect(() => translate(bad, { usdc: USDC })).toThrow(/date/i);
});

test("translate rejects operator === manager (bypass parse — defense-in-depth)", () => {
  const v = valid();
  const bad: AgentSpec = { ...v, roles: { ...v.roles, operator: v.roles.manager } };
  expect(() => translate(bad, { usdc: USDC })).toThrow(/distinct/i);
});
