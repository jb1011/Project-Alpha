import type { Metadata } from "next";
import { TextPage } from "@/components/landing/TextPage";
import { LANDING } from "@/components/landing/copy";

export const metadata: Metadata = {
  title: "Privacy",
  description: LANDING.privacy.paragraphs[1],
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <TextPage label="Novi Corpus" title={LANDING.privacy.title}>
      {LANDING.privacy.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </TextPage>
  );
}
