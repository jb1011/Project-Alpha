import type { Metadata } from "next";
import { TextPage } from "@/components/landing/TextPage";
import { LANDING } from "@/components/landing/copy";

export const metadata: Metadata = {
  title: "Terms",
  description: LANDING.terms.paragraphs[2],
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <TextPage label="Novi Corpus" title={LANDING.terms.title}>
      {LANDING.terms.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </TextPage>
  );
}
