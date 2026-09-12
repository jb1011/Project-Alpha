import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const PK = `0x${"1".repeat(64)}` as const;
const baseEnv = { ARC_TESTNET_RPC_URL: "http://localhost:8545", PLATFORM_PRIVATE_KEY: PK };

test("x402 demo is off by default with a 0.01 price", () => {
  const cfg = loadConfig(baseEnv);
  expect(cfg.enableX402Demo).toBe(false);
  expect(cfg.x402DemoPriceUsdc).toBe("0.01");
});

test("ENABLE_X402_DEMO accepts '1' and 'true'", () => {
  expect(loadConfig({ ...baseEnv, ENABLE_X402_DEMO: "1" }).enableX402Demo).toBe(true);
  expect(loadConfig({ ...baseEnv, ENABLE_X402_DEMO: "true" }).enableX402Demo).toBe(true);
  expect(loadConfig({ ...baseEnv, ENABLE_X402_DEMO: "no" }).enableX402Demo).toBe(false);
});

test("payTo defaults to the platform account address, overridable", () => {
  const cfg = loadConfig(baseEnv);
  expect(cfg.x402DemoPayTo).toBe(privateKeyToAccount(PK).address);
  const override = "0x00000000000000000000000000000000000000ab";
  expect(loadConfig({ ...baseEnv, X402_DEMO_PAYTO: override }).x402DemoPayTo.toLowerCase()).toBe(
    override,
  );
});

test("price must be > 0 and <= 1.0 USDC", () => {
  expect(() => loadConfig({ ...baseEnv, X402_DEMO_PRICE_USDC: "0" })).toThrow(/1.0 USDC/);
  expect(() => loadConfig({ ...baseEnv, X402_DEMO_PRICE_USDC: "2" })).toThrow(/1.0 USDC/);
  expect(loadConfig({ ...baseEnv, X402_DEMO_PRICE_USDC: "0.05" }).x402DemoPriceUsdc).toBe("0.05");
});

test("X402_TRUST_POLICY accepts the three policies, and nothing else", () => {
  expect(loadConfig(baseEnv).x402TrustPolicy).toBe("open");
  expect(loadConfig({ ...baseEnv, X402_TRUST_POLICY: "accountable-only" }).x402TrustPolicy).toBe(
    "accountable-only",
  );
  // The legal-body tier (design 2026-09-10 D4): accountable-only PLUS a registered Novi legal
  // body in good standing behind the payer address.
  expect(loadConfig({ ...baseEnv, X402_TRUST_POLICY: "legal-bodies-only" }).x402TrustPolicy).toBe(
    "legal-bodies-only",
  );
  expect(() => loadConfig({ ...baseEnv, X402_TRUST_POLICY: "legal-bodies" })).toThrow();
});

test("PUBLIC_API_URL is optional and must be a url", () => {
  // The API's OWN origin. Unset, every public link falls back to the metadata base — which on
  // prod is the www/backend proxy, and that proxy strips CORS, Cache-Control and
  // X-NOVI-LEGAL-BODY, i.e. exactly what those links exist to deliver.
  expect(loadConfig(baseEnv).publicApiUrl).toBeUndefined();
  expect(
    loadConfig({ ...baseEnv, PUBLIC_API_URL: "https://api.novicorpus.com" }).publicApiUrl,
  ).toBe("https://api.novicorpus.com");
  expect(() => loadConfig({ ...baseEnv, PUBLIC_API_URL: "api.novicorpus.com" })).toThrow();
});
