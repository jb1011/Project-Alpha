import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

test("POCKET_MASTER_SEED loads into cfg.pocketMasterSeed and is optional", () => {
  const seed = `0x${"ab".repeat(32)}`;
  expect(loadConfig({ ...base, POCKET_MASTER_SEED: seed }).pocketMasterSeed).toBe(seed);
  expect(loadConfig(base).pocketMasterSeed).toBeUndefined();
});

test("pocketMasterSeed is redacted in the safe-to-log view", () => {
  const seed = `0x${"ab".repeat(32)}`;
  const cfg = loadConfig({ ...base, POCKET_MASTER_SEED: seed });
  expect(redact(cfg).pocketMasterSeed).toBe("REDACTED");
});
