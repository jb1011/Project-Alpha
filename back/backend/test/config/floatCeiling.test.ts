import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const PK = `0x${"1".repeat(64)}` as const;
const baseEnv = { ARC_TESTNET_RPC_URL: "http://localhost:8545", PLATFORM_PRIVATE_KEY: PK };

test("MAX_POCKET_FLOAT_USDC defaults to 1.00", () => {
  expect(loadConfig(baseEnv).maxPocketFloatUsdc).toBe("1.00");
});

test("default config satisfies ceiling >= float + 2*seedTarget (0.9 <= 1.0)", () => {
  expect(() => loadConfig(baseEnv)).not.toThrow();
});

test("throws when ceiling < float + 2*seedTarget", () => {
  // float 0.9 + 2*0.2 = 1.3 > ceiling 1.0 -> throw
  expect(() =>
    loadConfig({
      ...baseEnv,
      FUNDING_FLOAT_USDC: "0.9",
      GAS_SEED_TARGET_USDC: "0.2",
      MAX_POCKET_FLOAT_USDC: "1.0",
    }),
  ).toThrow(/MAX_POCKET_FLOAT_USDC/);
});

test("passes at the exact boundary (ceiling == float + 2*seedTarget)", () => {
  // 0.9 + 0.4 = 1.3 == ceiling 1.3
  expect(() =>
    loadConfig({
      ...baseEnv,
      FUNDING_FLOAT_USDC: "0.9",
      GAS_SEED_TARGET_USDC: "0.2",
      MAX_POCKET_FLOAT_USDC: "1.3",
    }),
  ).not.toThrow();
});
