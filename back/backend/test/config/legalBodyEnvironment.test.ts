/**
 * The legal-body feature's configuration: the environment it runs in, whether the customer doors
 * are mounted, what a customer's own company costs, and how many a tenant may hold open.
 */
import { expect, test } from "vitest";
import {
  DEFAULT_BYO_MAX_OPEN_PER_TENANT,
  customerDoorsEnabled,
  legalBodyEnvironment,
  loadConfig,
  redact,
} from "../../src/config/env";

const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

/** Controller mode with the full-product factory named: what the legal-body factory requires. */
const CONTROLLER_MODE = {
  CONTROLLER_ADDRESS: "0x1111111111111111111111111111111111111111",
  FACTORY_ADDRESS: "0x2222222222222222222222222222222222222222",
};
const LB_FACTORY = "0x3333333333333333333333333333333333333333" as const;

/** The smallest env that may charge: a provider it can file with, in its production environment,
 *  the identity floor wired, somewhere to be paid and a dedicated settle submitter. */
const PAYING = {
  ...BASE,
  WORLD_APP_ID: "app_staging_1",
  WORLD_RP_ID: "app.example",
  WORLD_RP_SIGNING_KEY: "0xsigning",
  WORLD_REQUIRE_GUARDIAN: "true",
  WORLD_MAX_COMPANIES_PER_HUMAN: "3",
  DOOLA_ENVIRONMENT: "production",
  DOOLA_API_KEY: "dk_live_key",
  DOOLA_WEBHOOK_SECRET: "whsec_live",
  FORMATION_PII_KEY: Buffer.alloc(32, 7).toString("base64"),
  FORMATION_PAYMENT_REQUIRED: "true",
  FORMATION_REVENUE_ADDRESS: "0x000000000000000000000000000000000000BEeF",
  FORMATION_SETTLE_SUBMITTER_KEY: `0x${"c".repeat(64)}`,
};

// ── The environment ──

test("legalBodyEnvironment: mainnet is production; testnet, and a network left unset, are sandbox", () => {
  expect(legalBodyEnvironment({ arcNetwork: "mainnet" })).toBe("production");
  expect(legalBodyEnvironment({ arcNetwork: "testnet" })).toBe("sandbox");
  expect(legalBodyEnvironment({})).toBe("sandbox");
  // ARC_NETWORK unset: the config's own default.
  expect(legalBodyEnvironment(loadConfig(BASE))).toBe("sandbox");
});

// ── The doors ──

test("customerDoorsEnabled: with the factory set, sandbox mounts them and production only when it charges", () => {
  const free = loadConfig(BASE).formation!;
  expect(free.payment.required).toBe(false);
  const charging = { ...free, payment: { ...free.payment, required: true } };
  const cases = [
    ["testnet", free, true],
    ["testnet", charging, true],
    ["mainnet", free, false],
    ["mainnet", charging, true],
  ] as const;
  for (const [arcNetwork, formation, mounted] of cases) {
    const label = `${arcNetwork}, charging: ${formation.payment.required}`;
    expect(
      customerDoorsEnabled({ arcNetwork, legalBodyFactory: LB_FACTORY, formation }),
      label,
    ).toBe(mounted);
    // Without the factory the feature is off, whatever the network and the payment say.
    expect(customerDoorsEnabled({ arcNetwork, formation }), label).toBe(false);
  }
});

test("customerDoorsEnabled with no formation block: sandbox mounts them, production does not", () => {
  expect(customerDoorsEnabled({ arcNetwork: "testnet", legalBodyFactory: LB_FACTORY })).toBe(true);
  expect(customerDoorsEnabled({ legalBodyFactory: LB_FACTORY })).toBe(true);
  expect(customerDoorsEnabled({ arcNetwork: "mainnet", legalBodyFactory: LB_FACTORY })).toBe(false);
  expect(customerDoorsEnabled({ arcNetwork: "testnet" })).toBe(false);
});

test("customerDoorsEnabled reads a loaded config: on testnet the factory alone mounts them", () => {
  expect(customerDoorsEnabled(loadConfig({ ...BASE, ...CONTROLLER_MODE }))).toBe(false);
  expect(
    customerDoorsEnabled(
      loadConfig({ ...BASE, ...CONTROLLER_MODE, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY }),
    ),
  ).toBe(true);
});

// ── The fee ──

test("BYO_ATTESTATION_FEE_USDC has no default; set, it is whole USDC converted to atomic", () => {
  expect(loadConfig(BASE).formation?.payment.byoFeeAtomic).toBeUndefined();
  expect(
    loadConfig({ ...BASE, BYO_ATTESTATION_FEE_USDC: "7" }).formation?.payment.byoFeeAtomic,
  ).toBe(7_000_000n);
});

test("the fee must be a positive whole number: zero, a negative and a fraction are refused", () => {
  for (const bad of ["0", "-7", "7.5", "seven"])
    expect(() => loadConfig({ ...BASE, BYO_ATTESTATION_FEE_USDC: bad }), bad).toThrow(
      /BYO_ATTESTATION_FEE_USDC/,
    );
});

test("redact() prints the fee as a string beside feeAtomic, and nothing for it when unset", () => {
  const paymentOf = (printed: Record<string, unknown>) =>
    (printed.formation as { payment: Record<string, unknown> }).payment;
  // JSON.stringify throws on a bigint anywhere in the object, so serialising is the test.
  const unset = redact(loadConfig(BASE));
  expect(JSON.stringify(unset)).not.toContain("byoFeeAtomic");
  expect(paymentOf(unset).byoFeeAtomic).toBeUndefined();
  const set = redact(loadConfig({ ...BASE, BYO_ATTESTATION_FEE_USDC: "7" }));
  expect(JSON.stringify(set)).toContain('"byoFeeAtomic":"7000000"');
  expect(paymentOf(set).byoFeeAtomic).toBe("7000000");
  expect(typeof paymentOf(set).feeAtomic).toBe("string");
});

test("a deployment that charges, with the legal-body feature on, refuses to boot without the fee", () => {
  const charging = { ...PAYING, ...CONTROLLER_MODE, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY };
  expect(() => loadConfig(charging)).toThrow(/BYO_ATTESTATION_FEE_USDC is missing/);
  const priced = loadConfig({ ...charging, BYO_ATTESTATION_FEE_USDC: "7" });
  expect(priced.formation?.payment.byoFeeAtomic).toBe(7_000_000n);
  // Either half alone needs no fee: charging without the feature, or the feature on a box that
  // does not charge.
  expect(loadConfig({ ...PAYING, ...CONTROLLER_MODE }).formation?.payment.required).toBe(true);
  expect(
    loadConfig({ ...BASE, ...CONTROLLER_MODE, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY })
      .legalBodyFactory,
  ).toBe("0x3333333333333333333333333333333333333333");
});

// ── The per-tenant cap ──

test("BYO_MAX_OPEN_PER_TENANT defaults to 3 and takes a positive whole number", () => {
  expect(DEFAULT_BYO_MAX_OPEN_PER_TENANT).toBe(3);
  expect(loadConfig(BASE).formation?.byoMaxOpenPerTenant).toBe(DEFAULT_BYO_MAX_OPEN_PER_TENANT);
  expect(loadConfig({ ...BASE, BYO_MAX_OPEN_PER_TENANT: "5" }).formation?.byoMaxOpenPerTenant).toBe(
    5,
  );
  for (const bad of ["0", "1.5"])
    expect(() => loadConfig({ ...BASE, BYO_MAX_OPEN_PER_TENANT: bad }), bad).toThrow(
      /BYO_MAX_OPEN_PER_TENANT/,
    );
});
