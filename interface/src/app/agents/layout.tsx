import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AgentsProviders } from "./providers";

export const metadata: Metadata = {
  title: "Your agents",
  description: "Companies you have started on Arc testnet.",
  robots: { index: false, follow: true },
};

export default function AgentsLayout({ children }: { children: ReactNode }) {
  return <AgentsProviders>{children}</AgentsProviders>;
}
