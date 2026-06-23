// backend/test/adapters/x402/gateway.test.ts
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { PocketGateway } from "../../../src/adapters/x402/gateway";

const KEY = `0x${"2".repeat(64)}` as const;

test("PocketGateway exposes the pocket address from its key", () => {
  const gw = new PocketGateway({ pocketPrivateKey: KEY, rpcUrl: "https://rpc.example/v1" });
  expect(gw.address).toBe(privateKeyToAccount(KEY).address);
});
