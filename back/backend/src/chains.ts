import { type Address, type Chain, defineChain } from "viem";

/**
 * Multicall3, by chain id: the canonical deployment's address, listed only for a chain whose code
 * there was checked byte for byte against the canonical runtime code (3,808 bytes, keccak256
 * `0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891`). A chain that is not
 * listed reads with separate calls instead, each pinned to the same block.
 */
export const MULTICALL3_BY_CHAIN: Readonly<Record<number, Address>> = {
  5042002: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

/** Arc testnet. Native gas IS USDC (18-decimal native units); the ERC-20 USDC is 6-decimal. */
export const arcTestnet: Chain = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

/** Local anvil chain used by integration tests. */
export const anvilChain: Chain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

/** Build a viem Chain for a given id/rpc (Arc id keeps Arc metadata; else generic). */
export function chainFor(id: number, rpcUrl: string): Chain {
  if (id === arcTestnet.id) {
    return { ...arcTestnet, rpcUrls: { default: { http: [rpcUrl] } } };
  }
  return defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
