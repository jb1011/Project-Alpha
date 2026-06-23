import {
  http,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mockUsdcAbi } from "../src/abis/generated";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { anvilChain } from "../src/chains";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const manager = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const guardian = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
).address;
const operator = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
).address;
const payout = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
).address;

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
let pub: PublicClient;
let wallet: WalletClient;
let treasury: `0x${string}`;

beforeAll(async () => {
  anvil = await startAnvil(8549);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
  const res = await adapter.createEntity({
    manager: manager.address,
    guardian,
    operator,
    amendmentDelay: 3_600n,
    metadataURI: "file:///m",
    ein: "STUB",
    formationDate: 0,
    operatingAgreementHash: `0x${"ab".repeat(32)}`,
    treasury: {
      usdc: stack.usdc,
      payoutAddress: payout,
      cap: 1_000_000n,
      period: 2_592_000n,
      allowlistEnabled: false,
    },
  });
  treasury = res.treasury;
  // mint USDC to the manager so it can fund
  await wallet.writeContract({
    address: stack.usdc,
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [manager.address, 5_000_000n],
    account: manager,
    chain: anvilChain,
  });
}, 40_000);
afterAll(() => anvil?.stop());

test("fundTreasury transfers USDC to the treasury vault", async () => {
  await adapter.fundTreasury({ usdc: stack.usdc, treasury, amount: 2_000_000n });
  const bal = await pub.readContract({
    address: stack.usdc,
    abi: mockUsdcAbi,
    functionName: "balanceOf",
    args: [treasury],
  });
  expect(bal).toBe(2_000_000n);
}, 40_000);
