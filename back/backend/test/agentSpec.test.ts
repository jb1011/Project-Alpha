import { getAddress } from "viem";
import { expect, test } from "vitest";
import { parseAgentSpec } from "../src/policy/agentSpec";

const valid = {
  name: "Acme Research Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {
    manager: "0x000000000000000000000000000000000000aAaa",
    guardian: "0x000000000000000000000000000000000000bBbb",
  },
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000cCcc",
    spendingCapUsdc: "1000.00",
    spendingPeriod: "30d",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
  metadata: { description: "Does research", agentType: "service", capabilities: ["research"] },
};

test("parseAgentSpec accepts a valid spec and normalizes addresses", () => {
  const spec = parseAgentSpec(valid);
  expect(spec.name).toBe("Acme Research Agent");
  // address is normalized to canonical EIP-55 checksum
  expect(spec.roles.manager).toBe(getAddress("0x000000000000000000000000000000000000aAaa"));
});

test("parseAgentSpec rejects a missing required field with a clear path", () => {
  const bad = structuredClone(valid) as Record<string, unknown>;
  (bad.treasury as Record<string, unknown>).payoutAddress = undefined;
  expect(() => parseAgentSpec(bad)).toThrow(/payoutAddress/);
});

test("parseAgentSpec rejects a bad address", () => {
  const bad = structuredClone(valid);
  bad.roles.manager = "0xnotanaddress";
  expect(() => parseAgentSpec(bad)).toThrow(/manager/);
});

// ── Audit hardening: validate value semantics at the spec boundary, not at the on-chain revert ──

test("parseAgentSpec rejects a non-numeric spending cap", () => {
  const bad = structuredClone(valid);
  bad.treasury.spendingCapUsdc = "not-a-number";
  expect(() => parseAgentSpec(bad)).toThrow(/spendingCapUsdc/);
});

test("parseAgentSpec rejects a negative spending cap", () => {
  const bad = structuredClone(valid);
  bad.treasury.spendingCapUsdc = "-5";
  expect(() => parseAgentSpec(bad)).toThrow(/spendingCapUsdc/);
});

test("parseAgentSpec rejects a cap with more than 6 decimals", () => {
  const bad = structuredClone(valid);
  bad.treasury.spendingCapUsdc = "1.1234567";
  expect(() => parseAgentSpec(bad)).toThrow(/spendingCapUsdc/);
});

test("parseAgentSpec rejects an invalid spending period", () => {
  const bad = structuredClone(valid);
  bad.treasury.spendingPeriod = "soon";
  expect(() => parseAgentSpec(bad)).toThrow(/spendingPeriod/);
});

test("parseAgentSpec rejects a zero spending period (contract: ZeroAmount)", () => {
  const bad = structuredClone(valid);
  bad.treasury.spendingPeriod = "0";
  expect(() => parseAgentSpec(bad)).toThrow(/spendingPeriod/);
});

test("parseAgentSpec rejects a spending period above 365d (contract: PeriodTooLong)", () => {
  const bad = structuredClone(valid);
  bad.treasury.spendingPeriod = "366d";
  expect(() => parseAgentSpec(bad)).toThrow(/spendingPeriod/);
});

test("parseAgentSpec rejects amendmentDelay below the 1h floor (contract: DelayTooShort)", () => {
  const bad = structuredClone(valid);
  bad.governance.amendmentDelay = "30m";
  expect(() => parseAgentSpec(bad)).toThrow(/amendmentDelay/);
});

test("parseAgentSpec rejects manager == guardian (contract: RolesMustDiffer)", () => {
  const bad = structuredClone(valid);
  bad.roles.guardian = bad.roles.manager;
  expect(() => parseAgentSpec(bad)).toThrow(/guardian/);
});

test("parseAgentSpec rejects payoutAddress == operator (contract: RolesMustDiffer)", () => {
  const bad = structuredClone(valid) as typeof valid & {
    roles: { operator?: string };
  };
  bad.roles.operator = "0x000000000000000000000000000000000000dDdd";
  bad.treasury.payoutAddress = "0x000000000000000000000000000000000000dDdd";
  expect(() => parseAgentSpec(bad)).toThrow(/payoutAddress/);
});

test("parseAgentSpec rejects a malformed formationDate", () => {
  const bad = structuredClone(valid) as typeof valid & {
    legal?: { formationDate?: string };
  };
  bad.legal = { formationDate: "not-a-date" };
  expect(() => parseAgentSpec(bad)).toThrow(/formationDate/);
});

test("parseAgentSpec accepts boundary values (1h delay, 365d period)", () => {
  const ok = structuredClone(valid);
  ok.governance.amendmentDelay = "1h";
  ok.treasury.spendingPeriod = "365d";
  expect(() => parseAgentSpec(ok)).not.toThrow();
});
