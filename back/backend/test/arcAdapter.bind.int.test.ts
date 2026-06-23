import {
  http,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  hashTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mockIdentityRegistryAbi } from "../src/abis/generated";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";
import { LocalKeySigner } from "../src/adapters/turnkey/signer";
import { anvilChain } from "../src/chains";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
let pub: PublicClient;
const manager = privateKeyToAccount(KEYS[0]);
const guardian = privateKeyToAccount(KEYS[1]).address;
const operatorSigner = new LocalKeySigner(KEYS[2]);
const payout = privateKeyToAccount(KEYS[3]).address;

beforeAll(async () => {
  anvil = await startAnvil(8547);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
  await adapter.createEntity({
    manager: manager.address,
    guardian,
    operator: operatorSigner.address,
    amendmentDelay: 3_600n,
    metadataURI: "file:///tmp/meta.json",
    ein: "STUB-NOT-FILED",
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
}, 40_000);
afterAll(() => anvil?.stop());

test("operator signs, manager sends -> getAgentWallet becomes the operator", async () => {
  // Production pattern: source the EIP-712 domain from the registry (eip712Domain()) rather than
  // hardcoding it. The faithful mock returns the verified live value, distinct from the token name().
  const domain = await adapter.eip712Domain();
  expect(domain).toMatchObject({ name: "ERC8004IdentityRegistry", version: "1" });

  const deadline = await adapter.walletSetDeadline();
  const td = buildWalletSetTypedData({
    agentId: 0n,
    newWallet: operatorSigner.address,
    owner: manager.address,
    deadline,
    chainId: anvilChain.id,
    registry: stack.registry,
    domainName: domain.name,
    domainVersion: domain.version,
  });

  // belt-and-suspenders: our off-chain digest must equal the registry's on-chain digest
  const onChainDigest = await pub.readContract({
    address: stack.registry,
    abi: mockIdentityRegistryAbi,
    functionName: "walletSetDigest",
    args: [0n, operatorSigner.address, manager.address, deadline],
  });
  expect(hashTypedData(td)).toBe(onChainDigest);

  const signature = await operatorSigner.signWalletSet(td);
  await adapter.setAgentWallet({
    agentId: 0n,
    newWallet: operatorSigner.address,
    deadline,
    signature,
  });

  expect((await adapter.getAgentWallet(0n)).toLowerCase()).toBe(
    operatorSigner.address.toLowerCase(),
  );
}, 40_000);

test("a signature from anyone other than newWallet is rejected (operator-must-sign)", async () => {
  // The crux of the non-custodial design: only the bound wallet's own key may authorize the bind.
  // Here the MANAGER signs instead of the operator -> recover != newWallet -> "bad signature".
  const deadline = await adapter.walletSetDeadline();
  const td = buildWalletSetTypedData({
    agentId: 0n,
    newWallet: operatorSigner.address,
    owner: manager.address,
    deadline,
    chainId: anvilChain.id,
    registry: stack.registry,
  });
  const wrongSignature = await manager.signTypedData(td);
  await expect(
    adapter.setAgentWallet({
      agentId: 0n,
      newWallet: operatorSigner.address,
      deadline,
      signature: wrongSignature,
    }),
  ).rejects.toThrow(/invalid wallet sig/); // live: ECDSA fails -> ERC-1271 fallback on an EOA -> this
}, 40_000);

test("an expired deadline is rejected", async () => {
  const td = buildWalletSetTypedData({
    agentId: 0n,
    newWallet: operatorSigner.address,
    owner: manager.address,
    deadline: 1n, // far in the past -> block.timestamp > deadline
    chainId: anvilChain.id,
    registry: stack.registry,
  });
  const signature = await operatorSigner.signWalletSet(td);
  await expect(
    adapter.setAgentWallet({
      agentId: 0n,
      newWallet: operatorSigner.address,
      deadline: 1n,
      signature,
    }),
  ).rejects.toThrow(/expired/);
}, 40_000);

test("a deadline beyond the live window (300s) is rejected as 'deadline too far'", async () => {
  // Guards the regression where walletSetDeadline used now+1800: the live registry's MAX_DEADLINE_DELAY
  // is 300s, so anything past that reverts. The faithful mock mirrors this so CI catches it.
  const block = await pub.getBlock({ blockTag: "latest" });
  const deadline = block.timestamp + 600n; // > 300s window
  const td = buildWalletSetTypedData({
    agentId: 0n,
    newWallet: operatorSigner.address,
    owner: manager.address,
    deadline,
    chainId: anvilChain.id,
    registry: stack.registry,
  });
  const signature = await operatorSigner.signWalletSet(td);
  await expect(
    adapter.setAgentWallet({ agentId: 0n, newWallet: operatorSigner.address, deadline, signature }),
  ).rejects.toThrow(/deadline too far/);
}, 40_000);

test("a non-owner sender is rejected even with a valid operator signature", async () => {
  // Manager-sends is enforced on-chain: a stranger (the guardian account) cannot bind even when
  // holding a perfectly valid operator signature -> "not authorized".
  const transport = http(anvil.rpcUrl);
  const stranger = createWalletClient({
    account: privateKeyToAccount(KEYS[1]),
    chain: anvilChain,
    transport,
  });
  const rogue = new ArcAdapter({
    publicClient: pub,
    managerWallet: stranger,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
  const deadline = await adapter.walletSetDeadline();
  const td = buildWalletSetTypedData({
    agentId: 0n,
    newWallet: operatorSigner.address,
    owner: manager.address,
    deadline,
    chainId: anvilChain.id,
    registry: stack.registry,
  });
  const signature = await operatorSigner.signWalletSet(td);
  await expect(
    rogue.setAgentWallet({ agentId: 0n, newWallet: operatorSigner.address, deadline, signature }),
  ).rejects.toThrow(/Not authorized/);
}, 40_000);
