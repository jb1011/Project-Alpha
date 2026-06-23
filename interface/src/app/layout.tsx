import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "projectAlpha — A society for your agent",
  description:
    "Create a society for your agent: passkey-secured vault, on-chain spending policy, law-to-code operating agreement, and a USDC treasury on Arc.",
  metadataBase: new URL("https://projectalpha.example"),
  openGraph: {
    title: "projectAlpha — A society for your agent",
    description:
      "Passkey-secured agents with enforceable spending rules, Wyoming DAO LLC operating agreements, and guardian controls. Deploy and fund on Arc.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${archivo.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-paper text-ink font-sans">
        {children}
      </body>
    </html>
  );
}
