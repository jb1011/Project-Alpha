"use client";

import { Web3Provider } from "@/components/providers/Web3Provider";
import { AuthProvider } from "@/components/onboarding/AuthProvider";

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Web3Provider>
      <AuthProvider>{children}</AuthProvider>
    </Web3Provider>
  );
}
