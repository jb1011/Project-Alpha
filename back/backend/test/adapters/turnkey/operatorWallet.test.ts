import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { buildOperatorWalletClient } from "../../../src/adapters/turnkey/operatorWallet";
import type { Config } from "../../../src/config/env";

const cfg = {
  rpcUrl: "https://rpc.example/v1",
  chainId: 5042002,
  operatorPrivateKey: `0x${"3".repeat(64)}`,
} as Config;

test("falls back to a local operator wallet whose account address matches the key", async () => {
  const wallet = await buildOperatorWalletClient(cfg);
  expect(wallet.account?.address).toBe(privateKeyToAccount(cfg.operatorPrivateKey!).address);
  expect(wallet.chain?.id).toBe(5042002);
});

test("throws when neither Turnkey nor a local operator key is configured", async () => {
  await expect(
    buildOperatorWalletClient({ ...cfg, operatorPrivateKey: undefined } as Config),
  ).rejects.toThrow();
});
