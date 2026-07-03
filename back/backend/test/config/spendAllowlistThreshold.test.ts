import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

test("SPEND_ALLOWLIST_THRESHOLD_USDC converts human USDC to atomic units", () => {
  const cfg = loadConfig({ ...base, SPEND_ALLOWLIST_THRESHOLD_USDC: "2.5" });
  expect(cfg.spendAllowlistThreshold).toBe(2_500_000n);
});

test("SPEND_ALLOWLIST_THRESHOLD_USDC defaults to 1 USDC when unset", () => {
  const cfg = loadConfig(base);
  expect(cfg.spendAllowlistThreshold).toBe(1_000_000n);
});
