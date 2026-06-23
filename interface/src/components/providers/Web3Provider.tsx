"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "@/lib/chain";

const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(),
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
