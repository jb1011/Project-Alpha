import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { noteSenderBroadcast, trackedSenderCount } from "../../src/adapters/arc/senderLock";
import { anvilChain } from "../../src/chains";
import { type AnvilHandle, startAnvil } from "./anvil";
import { deployStack } from "./stack";

// anvil default account #0
const DEPLOYER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

let anvil: AnvilHandle;
/** Floors tracked the moment the chain became ready — see the test below. */
let floorsAfterStart = -1;
beforeAll(async () => {
  // A floor from a PREVIOUS chain, which is what a file that starts one anvil per test carries
  // into the next one (`helpers/anvilJob.ts` does exactly that).
  noteSenderBroadcast(DEPLOYER.address, 41);
  anvil = await startAnvil(8545);
  floorsAfterStart = trackedSenderCount();
}, 30_000);
afterAll(() => anvil?.stop());

test("a fresh chain starts with NO nonce floors — the 2026-09-22 CI timeout", async () => {
  // The helper's contract, asserted where CI can see it. A floor believed against a chain that has
  // never seen the transactions behind it numbers the first send into a hole: the node queues it
  // behind nonces that will never arrive and the receipt wait times out. `startAnvil` therefore
  // drops every floor as it resolves, and this is the line that fails if that ever goes away.
  expect(floorsAfterStart).toBe(0);
});

/**
 * A PORT THAT IS ALREADY ANSWERING IS SOMEBODY ELSE'S CHAIN, AND THE SUITE MUST SAY SO.
 *
 * The spawner used to resolve as soon as ANYTHING on the port answered `eth_chainId`. A second
 * anvil cannot bind a taken port, so a stale process left behind by another session (or a crashed
 * run) silently became every later test's chain — with its old contracts, its old balances and
 * its old nonces, and nothing in the output to say the tests were not running against a fresh
 * one. The failure mode is the worst kind: green tests about state nobody wrote.
 */
test("startAnvil refuses a port that is already in use, and names it", async () => {
  // `anvil` from beforeAll is live on 8545, which is exactly the situation being refused.
  await expect(startAnvil(8545)).rejects.toThrow(/already .*127\.0\.0\.1:8545/);
}, 30_000);

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
