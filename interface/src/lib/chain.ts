import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  // Arc's native unit (USDC as gas) has 18 decimals on chain; the ERC-20 USDC contract has 6, and
  // that number does not belong here. wagmi hands this object to a wallet's
  // `wallet_addEthereumChain` when the wallet does not know the chain yet.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.testnet.arc.io"],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: process.env.NEXT_PUBLIC_ARC_EXPLORER ?? "https://explorer.testnet.arc.io",
    },
  },
});

export const arcExplorer =
  process.env.NEXT_PUBLIC_ARC_EXPLORER ?? "https://explorer.testnet.arc.io";

export function txUrl(hash: string): string {
  return `${arcExplorer}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${arcExplorer}/address/${address}`;
}
