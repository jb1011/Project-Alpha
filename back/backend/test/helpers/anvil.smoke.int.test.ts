import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { anvilChain } from "../../src/chains";
import { type AnvilHandle, startAnvil } from "./anvil";
import { deployStack } from "./stack";

// anvil default account #0
const DEPLOYER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

let anvil: AnvilHandle;
beforeAll(async () => {
  anvil = await startAnvil(8545);
}, 30_000);
afterAll(() => anvil?.stop());

test("anvil starts and the full stack deploys", async () => {
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: DEPLOYER, chain: anvilChain, transport });
  const stack = await deployStack(wallet, pub, DEPLOYER.address);
  expect(stack.factory).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // Factory.beacon() is set in the constructor.
  const beacon = await pub.readContract({
    abi: (await import("../../src/abis/generated")).legalManagerFactoryAbi,
    address: stack.factory,
    functionName: "beacon",
  });
  expect(beacon).toMatch(/^0x[0-9a-fA-F]{40}$/);
}, 30_000);
