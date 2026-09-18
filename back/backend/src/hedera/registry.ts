/**
 * ERC-8004 identity registration on Hedera testnet (design D10, task 10).
 *
 * One write, one read-back: simulate `register(metadataURI)`, send exactly the request the
 * simulation produced, and wait for the receipt. The agent id is the SIMULATION's return value,
 * not a parsed log — `iIdentityRegistryAbi` declares `register` as returning `uint256 agentId`
 * and carries no event at all, so there is nothing in the receipt to decode. Simulating first is
 * therefore load-bearing twice over: it is both the revert check and the only source of the id.
 *
 * The registry address is a CONSTANT, never an env var (audit C3). An operator who can point this
 * at a different registry can mint an identity that the served metadata and the UAID both claim
 * is ours; the address is public, immutable and the same for every Hedera testnet caller, so
 * there is nothing to configure and a config knob here would only be an attack surface.
 *
 * The client parameters are typed structurally rather than as viem's `PublicClient` and
 * `WalletClient`: this module needs three methods, the script passes real viem clients, and the
 * test passes plain objects. Widening to the two viem interfaces would buy no safety here (the
 * ABI, the function name and the args are all fixed below) and would cost the tests a fake chain.
 */
import type { Account } from "viem";
import { iIdentityRegistryAbi } from "../abis/generated";
import type { Address, Hex } from "../types";

/** ERC-8004 IdentityRegistry on Hedera testnet (chain id 296). Public, immutable, not a secret. */
export const HEDERA_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;

/** The three reads/writes `registerOnHedera` performs, and nothing else. */
export interface RegistryPublicClient {
  simulateContract(args: {
    address: Address;
    abi: typeof iIdentityRegistryAbi;
    functionName: "register";
    args: readonly [string];
    /** viem's own account union: the SIMULATED request carries this through to the write, so
     *  handing it a bare address here would turn a locally-signed write into an
     *  `eth_sendTransaction` against a node that holds no keys. */
    account: Account | Address | undefined;
  }): Promise<{ result: bigint; request: unknown }>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string }>;
}

export interface RegistryWalletClient {
  account?: Account | null;
  /** Takes the object `simulateContract` returned. `never` keeps the parameter bivariant, so a
   *  real viem wallet client and a test's plain object both satisfy this shape. */
  writeContract(request: never): Promise<Hex>;
}

/**
 * Registers one metadata URI in the ERC-8004 identity registry and returns the minted agent id
 * as a decimal string (the shape `EntityRecord.hederaAgentId` and `setHederaIdentity` store).
 *
 * Throws `register reverted` if the receipt is anything but `success`: a reverted registration
 * must never be written to a row, because the row is what the public `/verify` surface answers
 * from.
 */
export async function registerOnHedera(o: {
  publicClient: RegistryPublicClient;
  walletClient: RegistryWalletClient;
  registry: Address;
  metadataURI: string;
}): Promise<{ agentId: string; txHash: Hex }> {
  const { result, request } = await o.publicClient.simulateContract({
    address: o.registry,
    abi: iIdentityRegistryAbi,
    functionName: "register",
    args: [o.metadataURI],
    account: o.walletClient.account ?? undefined,
  });
  const txHash = await o.walletClient.writeContract(request as never);
  const receipt = await o.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`register reverted (tx ${txHash}, status ${receipt.status})`);
  }
  return { agentId: result.toString(), txHash };
}
