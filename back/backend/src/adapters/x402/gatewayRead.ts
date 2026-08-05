// backend/src/adapters/x402/gatewayRead.ts
import { http, createPublicClient } from "viem";
import { chainFor } from "../../chains";
import type { Address } from "../../types";
import { arcBatchingConfig } from "./pocket";

/** GatewayWallet.availableBalance(token, depositor) — the same view PocketGateway.getAvailable()
 *  reads through the key-constructed GatewayClient, exposed as a plain address-based read. */
const availableBalanceAbi = [
  {
    name: "availableBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Read a depositor's spendable Gateway balance BY ADDRESS (atomic 6-dec USDC, no rounding).
 *
 * Tier-0: the circle-path pocket has NO local private key (Circle MPC holds it), so the
 * key-constructed GatewayClient cannot be built for it — and the turnkey path shouldn't need the
 * master seed just to READ a balance either. This is the seed-free read used whenever the
 * entity's pocket address is stored (backfilled for every agent in P1a).
 */
export async function readGatewayAvailable(p: {
  rpcUrl: string;
  chainId: number;
  usdc: Address;
  depositor: Address;
  gatewayWallet?: Address;
}): Promise<bigint> {
  const pub = createPublicClient({
    chain: chainFor(p.chainId, p.rpcUrl),
    transport: http(p.rpcUrl),
  });
  return pub.readContract({
    address: p.gatewayWallet ?? arcBatchingConfig.verifyingContract,
    abi: availableBalanceAbi,
    functionName: "availableBalance",
    args: [p.usdc, p.depositor],
  });
}
