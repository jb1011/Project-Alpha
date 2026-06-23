import { expect, test } from "vitest";
import { managerAccount, managerWalletClient, publicClientFor } from "../src/adapters/arc/clients";
import { loadConfig } from "../src/config/env";

const cfg = loadConfig({
  ARC_TESTNET_RPC_URL: "https://rpc.testnet.arc.network",
  ARC_CHAIN_ID: "5042002",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
});

test("managerAccount derives an address from the platform key", () => {
  expect(managerAccount(cfg).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

test("client factories build with the configured chain + manager account", () => {
  expect(publicClientFor(cfg).chain?.id).toBe(5042002);
  expect(managerWalletClient(cfg).chain?.id).toBe(5042002);
  expect(managerWalletClient(cfg).account?.address).toBe(managerAccount(cfg).address);
});
