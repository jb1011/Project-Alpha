import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

export const metadata: Metadata = {
  title: "Create a company",
  description:
    "Create a company for your agent on Arc testnet: a passkey, spending rules, and a USDC treasury.",
  robots: { index: false, follow: true },
};

export default function OnboardingPage() {
  return <OnboardingFlow />;
}
