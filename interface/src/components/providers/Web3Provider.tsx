"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { WagmiProvider, createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "@/lib/chain";

const arcFallbackRpc =
  process.env.NEXT_PUBLIC_ARC_RPC_FALLBACK ?? "https://arc-testnet.drpc.org";

const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    // Ranked fallback: guardian actions (pause, funding) must survive a single RPC having a bad
    // day — during a live recording the primary blipped and every wallet write on the page died
    // with "RPC Request failed". The chain's configured URL stays first; drpc is the understudy.
    [arcTestnet.id]: fallback([http(), http(arcFallbackRpc)]),
  },
});

const queryClient = new QueryClient();

export function Web3Provider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
