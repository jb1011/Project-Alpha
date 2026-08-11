"use client";

import { type ReactNode } from "react";
import { Web3Provider } from "@/components/providers/Web3Provider";
import { AuthProvider } from "@/components/onboarding/AuthProvider";

export default function AgentsLayout({ children }: { children: ReactNode }) {
  return (
    <Web3Provider>
      <AuthProvider>{children}</AuthProvider>
    </Web3Provider>
  );
}
