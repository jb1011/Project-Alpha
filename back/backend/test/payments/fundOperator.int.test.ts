// backend/test/payments/fundOperator.int.test.ts
import { http, type PublicClient, createPublicClient, createWalletClient, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mockUsdcAbi } from "../../src/abis/generated";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { anvilChain } from "../../src/chains";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { deployStack } from "../helpers/stack";

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

let anvil: AnvilHandle;
let pub: PublicClient;
let adapter: ArcAdapter;
let treasury: `0x${string}`;
let usdc: `0x${string}`;
const manager = privateKeyToAccount(KEYS[0]);
const guardian = privateKeyToAccount(KEYS[1]);
const operator = privateKeyToAccount(KEYS[2]);
const payout = privateKeyToAccount(KEYS[3]).address;
const pocket = privateKeyToAccount(`0x${"e".repeat(63)}1`).address;

beforeAll(async () => {
  anvil = await startAnvil(8551);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  const managerWallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  const operatorWallet = createWalletClient({ account: operator, chain: anvilChain, transport });
  const stack = await deployStack(managerWallet, pub, manager.address);
  usdc = stack.usdc;
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet,
    operatorWallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
  const res = await adapter.createEntity({
    manager: manager.address,
    guardian: guardian.address,
    operator: operator.address,
    amendmentDelay: 3_600n,
    metadataURI: "file:///tmp/m.json",
    ein: "STUB-NOT-FILED",
    formationDate: 0,
    operatingAgreementHash: `0x${"ab".repeat(32)}`,
    treasury: {
      usdc,
      payoutAddress: payout,
      cap: 1_000_000n,
      period: 2_592_000n,
      allowlistEnabled: false,
    },
  });
  treasury = res.treasury;
  // mint USDC to the manager so it can fund the treasury
  await managerWallet.writeContract({
    address: usdc,
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [manager.address, 5_000_000n],
    account: manager,
    chain: anvilChain,
  });
  // fund the treasury so it has USDC to push to the operator
  await adapter.fundTreasury({ usdc, treasury, amount: 500_000n });
}, 60_000);
afterAll(() => anvil?.stop());

test("fundOperator moves USDC treasury->operator; operatorTransferUsdc forwards operator->pocket", async () => {
  await adapter.fundOperator(treasury, 10_000n);
  const opBal = await pub.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [operator.address],
  });
  expect(opBal).toBe(10_000n);

  await adapter.operatorTransferUsdc(usdc, pocket, 10_000n);
  const pocketBal = await pub.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [pocket],
  });
  expect(pocketBal).toBe(10_000n);
  const opAfter = await pub.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [operator.address],
  });
  expect(opAfter).toBe(0n);
}, 60_000);
