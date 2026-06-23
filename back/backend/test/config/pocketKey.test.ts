import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

test("POCKET_PRIVATE_KEY is parsed into cfg.pocketPrivateKey", () => {
  const cfg = loadConfig({ ...base, POCKET_PRIVATE_KEY: `0x${"2".repeat(64)}` });
  expect(cfg.pocketPrivateKey).toBe(`0x${"2".repeat(64)}`);
});

test("pocketPrivateKey is redacted in the safe-to-log view", () => {
  const cfg = loadConfig({ ...base, POCKET_PRIVATE_KEY: `0x${"2".repeat(64)}` });
  expect(redact(cfg).pocketPrivateKey).toBe("REDACTED");
});

test("pocketPrivateKey is optional", () => {
  expect(loadConfig(base).pocketPrivateKey).toBeUndefined();
});
