"use client";

import { type ReactNode } from "react";
import { AuthProvider } from "@/components/onboarding/AuthProvider";
import { Web3Provider } from "@/components/providers/Web3Provider";

/** Mirrors the /agents layout: wallet + session context for the authenticated area. */
export default function GuardianLayout({ children }: { children: ReactNode }) {
  return (
    <Web3Provider>
      <AuthProvider>{children}</AuthProvider>
    </Web3Provider>
  );
}
