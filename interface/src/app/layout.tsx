import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";
import { type ReactNode } from "react";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://novicorpus.xyz";

export const metadata: Metadata = {
  title: "Novi Corpus — A company for your agent",
  description:
    "Create a company for your agent: custody choice, World ID verification, on-chain spending policy, law-to-code operating agreement, and a USDC treasury on Arc.",
  metadataBase: new URL(siteUrl),
  openGraph: {
    title: "Novi Corpus — A company for your agent",
    description:
      "Agents with enforceable spending rules, Wyoming DAO LLC operating agreements, custody choice, and guardian controls. Deploy and fund on Arc.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className={`${archivo.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-paper text-ink font-sans">
        {children}
      </body>
    </html>
  );
}
