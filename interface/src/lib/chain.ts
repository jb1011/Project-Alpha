import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: process.env.NEXT_PUBLIC_ARC_EXPLORER ?? "https://testnet.arcscan.app",
    },
  },
});

export const arcExplorer =
  process.env.NEXT_PUBLIC_ARC_EXPLORER ?? "https://testnet.arcscan.app";

export function txUrl(hash: string): string {
  return `${arcExplorer}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${arcExplorer}/address/${address}`;
}
