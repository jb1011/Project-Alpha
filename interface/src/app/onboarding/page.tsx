import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

export const metadata: Metadata = {
  title: "Create your agent — Novi Corpus",
  description:
    "Spin up a non-custodial autonomous agent: passkey, policy, on-chain treasury and governance — in one guided flow.",
};

export default function OnboardingPage() {
  return <OnboardingFlow />;
}
