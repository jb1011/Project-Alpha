import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

test("fundingFloatUsdc defaults to 0.50 and is overridable", () => {
  expect(loadConfig(base).fundingFloatUsdc).toBe("0.50");
  expect(loadConfig({ ...base, FUNDING_FLOAT_USDC: "1.25" }).fundingFloatUsdc).toBe("1.25");
});

test("customerPrivateKey defaults to the platform key and is overridable + redacted", () => {
  const cfg = loadConfig(base);
  expect(cfg.customerPrivateKey).toBe(base.PLATFORM_PRIVATE_KEY);
  const over = loadConfig({ ...base, CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}` });
  expect(over.customerPrivateKey).toBe(`0x${"2".repeat(64)}`);
  expect(redact(over).customerPrivateKey).toBe("REDACTED");
});
