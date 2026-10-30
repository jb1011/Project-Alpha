import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Public record",
  description:
    "Test entities on Arc testnet. Real companies are not listed here yet.",
  robots: { index: false, follow: true },
};

export default function TransparencyLayout({ children }: { children: ReactNode }) {
  return children;
}
