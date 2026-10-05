/**
 * The legal-body flow's settings: the amendment delay every new body is created with, and the caps
 * on a tenant's open orders, its orders per day, its creates per day and the deployment's creates
 * per day. Each is checked at every load, the feature on or off: blank is unset, and any other
 * value outside its range refuses boot, naming the setting.
 */
import { expect, test } from "vitest";
import { LEGAL_BODY_FLOW_DEFAULTS, loadConfig } from "../../src/config/env";

const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

/** The feature on: controller mode, the full-product factory, and the legal-body factory. */
const FEATURE_ON = {
  ...BASE,
  CONTROLLER_ADDRESS: "0x1111111111111111111111111111111111111111",
  FACTORY_ADDRESS: "0x2222222222222222222222222222222222222222",
  LEGAL_BODY_FACTORY_ADDRESS: "0x3333333333333333333333333333333333333333",
};

const CAPS = {
  LEGAL_BODY_MAX_OPEN_PER_TENANT: "maxOpenPerTenant",
  LEGAL_BODY_MAX_ORDERS_PER_TENANT_PER_DAY: "maxOrdersPerTenantPerDay",
  LEGAL_BODY_MAX_CREATES_PER_TENANT_PER_DAY: "maxCreatesPerTenantPerDay",
  LEGAL_BODY_MAX_CREATES_PER_DAY: "maxCreatesPerDay",
} as const;

test("unset, each setting takes its default, the feature on or off", () => {
  expect(LEGAL_BODY_FLOW_DEFAULTS).toEqual({
    amendmentDelaySeconds: 172_800,
    maxOpenPerTenant: 3,
    maxOrdersPerTenantPerDay: 10,
    maxCreatesPerTenantPerDay: 5,
    maxCreatesPerDay: 100,
  });
  for (const env of [BASE, FEATURE_ON])
    expect(loadConfig(env).legalBodyFlow).toEqual(LEGAL_BODY_FLOW_DEFAULTS);
});

test("each setting takes a value in its range", () => {
  const cfg = loadConfig({
    ...FEATURE_ON,
    LEGAL_BODY_AMENDMENT_DELAY_SECONDS: "604800",
    LEGAL_BODY_MAX_OPEN_PER_TENANT: "4",
    LEGAL_BODY_MAX_ORDERS_PER_TENANT_PER_DAY: "12",
    LEGAL_BODY_MAX_CREATES_PER_TENANT_PER_DAY: "6",
    LEGAL_BODY_MAX_CREATES_PER_DAY: "250",
  });
  expect(cfg.legalBodyFlow).toEqual({
    amendmentDelaySeconds: 604_800,
    maxOpenPerTenant: 4,
    maxOrdersPerTenantPerDay: 12,
    maxCreatesPerTenantPerDay: 6,
    maxCreatesPerDay: 250,
  });
});

test("the amendment delay is a whole number of seconds from 48 hours to 30 days, both ends included", () => {
  for (const ok of ["172800", "2592000"])
    expect(
      loadConfig({ ...BASE, LEGAL_BODY_AMENDMENT_DELAY_SECONDS: ok }).legalBodyFlow
        ?.amendmentDelaySeconds,
    ).toBe(Number(ok));
  for (const bad of ["172799", "2592001", "0", "-172800", "172800.5", "two days"])
    for (const env of [BASE, FEATURE_ON])
      expect(() => loadConfig({ ...env, LEGAL_BODY_AMENDMENT_DELAY_SECONDS: bad }), bad).toThrow(
        /LEGAL_BODY_AMENDMENT_DELAY_SECONDS/,
      );
});

test("each cap is a positive whole number", () => {
  for (const [name, field] of Object.entries(CAPS)) {
    expect(loadConfig({ ...BASE, [name]: "1" }).legalBodyFlow?.[field], name).toBe(1);
    for (const bad of ["0", "-3", "1.5", "many"])
      for (const env of [BASE, FEATURE_ON])
        expect(() => loadConfig({ ...env, [name]: bad }), `${name}=${bad}`).toThrow(
          new RegExp(name),
        );
  }
});

test("a blank setting is unset: its default", () => {
  for (const blank of ["", "  "]) {
    const cfg = loadConfig({
      ...FEATURE_ON,
      LEGAL_BODY_AMENDMENT_DELAY_SECONDS: blank,
      ...Object.fromEntries(Object.keys(CAPS).map((name) => [name, blank])),
    });
    expect(cfg.legalBodyFlow, JSON.stringify(blank)).toEqual(LEGAL_BODY_FLOW_DEFAULTS);
  }
});
