import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

test("boot invariant: outflow ceiling must cover a single legal fund call", () => {
  expect(() =>
    loadConfig({ ...BASE, PLATFORM_OUTFLOW_CEILING_USDC: "10", MAX_TREASURY_FUND_USDC: "25" }),
  ).toThrow(/PLATFORM_OUTFLOW_CEILING_USDC/);
});

test("defaults pass: 200 ceiling / 24h window", () => {
  const cfg = loadConfig(BASE);
  expect(cfg.platformOutflowCeiling).toBe(200_000_000n);
  expect(cfg.platformOutflowWindowMs).toBe(86_400_000);
});
