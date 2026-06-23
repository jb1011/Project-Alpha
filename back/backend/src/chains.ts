import { type Chain, defineChain } from "viem";

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
