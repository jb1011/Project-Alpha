/**
 * The boot invariants that go with removing the two platform-key fallbacks.
 *
 * Deleting `?? PLATFORM_PRIVATE_KEY` closes the SILENT path into this arrangement. These close
 * the LOUD one: an operator who reads "there is no fallback any more" and pastes the platform key
 * into the var gets exactly the setup the fallbacks were removed for, only now on purpose.
 *
 * Production refuses. Everywhere else warns and boots, because a dev box deliberately running one
 * key is a legitimate thing to do — it just must never be quiet about it.
 */
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../../src/config/env";
import { CIRCLE_FULL_ENV } from "../helpers/prodEnv";

const PLATFORM_KEY = `0x${"1".repeat(64)}` as const;
const OTHER_KEY = `0x${"2".repeat(64)}` as const;
const PAY_TO = "0x00000000000000000000000000000000000000ab";

/** Satisfies every pre-existing production guard (JWT / WEB_ORIGIN / METADATA_BASE_URL / custody),
 *  so a throw from here is the invariant under test and not an unrelated one. */
const PROD = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/arc",
  PLATFORM_PRIVATE_KEY: PLATFORM_KEY,
  AUTH_JWT_SECRET: "a-real-production-secret-1234",
  WEB_ORIGIN: "https://app.example.com",
  METADATA_BASE_URL: "https://api.example.com/backend",
  NODE_ENV: "production",
  WALLET_PROVIDER_DEFAULT: "circle",
  ...CIRCLE_FULL_ENV,
};

/** The same credential set without the production switch. */
const { NODE_ENV: _nodeEnv, ...DEV } = PROD;

afterEach(() => vi.restoreAllMocks());

// ── the demo seller's payout address ────────────────────────────────────────────────────────────

test("prod + ENABLE_X402_DEMO with no X402_DEMO_PAYTO refuses to boot, naming the var", () => {
  expect(() => loadConfig({ ...PROD, ENABLE_X402_DEMO: "true" })).toThrow(/X402_DEMO_PAYTO/);
});

test("prod + ENABLE_X402_DEMO with a payTo boots", () => {
  const cfg = loadConfig({ ...PROD, ENABLE_X402_DEMO: "true", X402_DEMO_PAYTO: PAY_TO });
  expect(cfg.enableX402Demo).toBe(true);
  expect(cfg.x402DemoPayTo?.toLowerCase()).toBe(PAY_TO);
});

test("prod with the demo flag OFF and no payTo boots — nothing is being published", () => {
  expect(loadConfig(PROD).enableX402Demo).toBe(false);
  expect(loadConfig(PROD).x402DemoPayTo).toBeUndefined();
});

test("outside production the flag with no payTo boots; the seller is simply not mounted", () => {
  const cfg = loadConfig({ ...DEV, ENABLE_X402_DEMO: "true" });
  expect(cfg.enableX402Demo).toBe(true);
  expect(cfg.x402DemoPayTo).toBeUndefined();
});

// ── no optional signer may BE the platform key ──────────────────────────────────────────────────

test.each([["JOB_CLIENT_PRIVATE_KEY"], ["CUSTOMER_PRIVATE_KEY"]])(
  "prod + %s equal to PLATFORM_PRIVATE_KEY refuses to boot, naming the var",
  (varName) => {
    expect(() => loadConfig({ ...PROD, [varName]: PLATFORM_KEY })).toThrow(
      new RegExp(`${varName}.*must not equal PLATFORM_PRIVATE_KEY`),
    );
  },
);

test.each([["JOB_CLIENT_PRIVATE_KEY"], ["CUSTOMER_PRIVATE_KEY"]])(
  "prod + %s as its OWN distinct key boots",
  (varName) => {
    expect(() => loadConfig({ ...PROD, [varName]: OTHER_KEY })).not.toThrow();
  },
);

test("the refusal is case-insensitive about the hex — a re-cased paste is the same key", () => {
  expect(() =>
    loadConfig({ ...PROD, JOB_CLIENT_PRIVATE_KEY: PLATFORM_KEY.toUpperCase().replace("0X", "0x") }),
  ).toThrow(/must not equal PLATFORM_PRIVATE_KEY/);
});

test.each([["JOB_CLIENT_PRIVATE_KEY"], ["CUSTOMER_PRIVATE_KEY"]])(
  "outside production %s equal to PLATFORM_PRIVATE_KEY boots with ONE loud warning",
  (varName) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => loadConfig({ ...DEV, [varName]: PLATFORM_KEY })).not.toThrow();
    const lines = warn.mock.calls.map((c) => String(c[0]));
    const named = lines.filter((l) => l.includes(varName) && l.includes("PLATFORM_PRIVATE_KEY"));
    expect(named).toHaveLength(1);
  },
);

test("a dev box with neither var set warns about neither", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  loadConfig(DEV);
  const named = warn.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes("must not equal") || l.includes("equals PLATFORM_PRIVATE_KEY"));
  expect(named).toHaveLength(0);
});
