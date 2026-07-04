import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const PK = `0x${"1".repeat(64)}` as const;
const baseEnv = { ARC_TESTNET_RPC_URL: "http://localhost:8545", PLATFORM_PRIVATE_KEY: PK };

test("gas-seed floor/target default to 0.05/0.2", () => {
  const cfg = loadConfig(baseEnv);
  expect(cfg.gasSeedFloorUsdc).toBe("0.05");
  expect(cfg.gasSeedTargetUsdc).toBe("0.2");
});

test("rejects floor >= target", () => {
  expect(() =>
    loadConfig({ ...baseEnv, GAS_SEED_FLOOR_USDC: "0.3", GAS_SEED_TARGET_USDC: "0.2" }),
  ).toThrow(/GAS_SEED_FLOOR_USDC/);
});

test("rejects a non-ether floor value", () => {
  expect(() => loadConfig({ ...baseEnv, GAS_SEED_FLOOR_USDC: "abc" })).toThrow();
});
