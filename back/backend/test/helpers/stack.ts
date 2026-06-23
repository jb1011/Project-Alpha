import { type Address, type PublicClient, type WalletClient, getAddress } from "viem";
import { loadArtifact } from "./artifacts";

export interface DeployedStack {
  usdc: Address;
  registry: Address;
  impl: Address;
  factory: Address;
}

async function deploy(
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

/**
 * Deploy the full stack to a local anvil: MockUSDC, MockIdentityRegistry, LegalManager impl,
 * and the real LegalManagerFactory(impl, registry, beaconOwner). Mirrors script/Deploy.s.sol but
 * against the mock registry so tests exercise the real Factory bytecode end-to-end.
 */
export async function deployStack(
  wallet: WalletClient,
  pub: PublicClient,
  beaconOwner: Address,
): Promise<DeployedStack> {
  const usdc = await deploy(wallet, pub, "MockUSDC");
  const registry = await deploy(wallet, pub, "MockIdentityRegistry");
  const impl = await deploy(wallet, pub, "LegalManager");
  const factory = await deploy(wallet, pub, "LegalManagerFactory", [impl, registry, beaconOwner]);
  return { usdc, registry, impl, factory };
}
