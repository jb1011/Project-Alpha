import { http, type Address, type PublicClient, type WalletClient, getAddress } from "viem";
import { createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mockErc8183JobAbi, mockUsdcAbi } from "../../src/abis/generated";
import { anvilChain } from "../../src/chains";
import { type AnvilHandle, startAnvil } from "./anvil";
import { loadArtifact } from "./artifacts";

export interface MockReputationEnv {
  publicClient: PublicClient;
  evaluatorWallet: WalletClient;
  registryAddr: Address;
  stop: () => void;
}

/**
 * Start anvil (port 8546), deploy MockReputationRegistry, and return everything Task 3.1 needs.
 * Caller is responsible for calling stop() when done.
 */
export async function deployMockReputation(): Promise<MockReputationEnv> {
  const anvil: AnvilHandle = await startAnvil(8546);
  const transport = http(anvil.rpcUrl);

  const publicClient = createPublicClient({ chain: anvilChain, transport });

  const evaluatorAccount = ACCT(2);
  const evaluatorWallet = createWalletClient({
    account: evaluatorAccount,
    chain: anvilChain,
    transport,
  });

  // Deploy using account 0 (deployer)
  const deployerWallet = createWalletClient({
    account: ACCT(0),
    chain: anvilChain,
    transport,
  });

  const registryAddr = await deployContract(deployerWallet, publicClient, "MockReputationRegistry");

  return {
    publicClient,
    evaluatorWallet,
    registryAddr,
    stop: anvil.stop,
  };
}

/** Deterministic anvil accounts (same keys as arcAdapter int tests). */
const ACCT = (i: number) =>
  privateKeyToAccount(
    [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    ][i] as `0x${string}`,
  );

async function deployContract(
  wallet: WalletClient,
  pub: PublicClient,
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: constructor args vary by contract
  args: any[] = [],
): Promise<Address> {
  const { abi, bytecode } = loadArtifact(name);
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args,
    account: wallet.account!,
    chain: wallet.chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy produced no address`);
  return getAddress(receipt.contractAddress);
}

export interface MockJobEnv {
  publicClient: PublicClient;
  clientWallet: WalletClient;
  providerWallet: WalletClient;
  evaluatorWallet: WalletClient;
  clientAddr: Address;
  providerAddr: Address;
  evaluatorAddr: Address;
  usdcAddr: Address;
  jobAddr: Address;
  mintUsdc: (to: Address, amount: bigint) => Promise<void>;
  usdcBalanceOf: (addr: Address) => Promise<bigint>;
  stop: () => void;
}

/**
 * Start anvil (port 8546), deploy MockUSDC + MockERC8183Job, and return everything Tasks 2.1–2.3 need.
 * Caller is responsible for calling stop() in afterAll.
 */
export async function deployMockJob(): Promise<MockJobEnv> {
  const anvil: AnvilHandle = await startAnvil(8546);
  const transport = http(anvil.rpcUrl);

  const publicClient = createPublicClient({ chain: anvilChain, transport });

  const clientAccount = ACCT(0);
  const providerAccount = ACCT(1);
  const evaluatorAccount = ACCT(2);

  const clientWallet = createWalletClient({ account: clientAccount, chain: anvilChain, transport });
  const providerWallet = createWalletClient({
    account: providerAccount,
    chain: anvilChain,
    transport,
  });
  const evaluatorWallet = createWalletClient({
    account: evaluatorAccount,
    chain: anvilChain,
    transport,
  });

  const usdcAddr = await deployContract(clientWallet, publicClient, "MockUSDC");
  const jobAddr = await deployContract(clientWallet, publicClient, "MockERC8183Job", [usdcAddr]);

  const mintUsdc = async (to: Address, amount: bigint): Promise<void> => {
    const { request } = await publicClient.simulateContract({
      address: usdcAddr,
      abi: mockUsdcAbi,
      functionName: "mint",
      args: [to, amount],
      account: clientAccount,
    });
    const hash = await clientWallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
  };

  const usdcBalanceOf = async (addr: Address): Promise<bigint> => {
    return publicClient.readContract({
      address: usdcAddr,
      abi: mockUsdcAbi,
      functionName: "balanceOf",
      args: [addr],
    }) as Promise<bigint>;
  };

  return {
    publicClient,
    clientWallet,
    providerWallet,
    evaluatorWallet,
    clientAddr: clientAccount.address,
    providerAddr: providerAccount.address,
    evaluatorAddr: evaluatorAccount.address,
    usdcAddr,
    jobAddr,
    mintUsdc,
    usdcBalanceOf,
    stop: anvil.stop,
  };
}
