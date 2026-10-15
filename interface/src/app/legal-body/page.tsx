import type { Metadata } from "next";
import { LegalBodyFlow } from "@/components/legalBody/LegalBodyFlow";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

export const metadata: Metadata = {
  title: LEGAL_BODY_COPY.page.title,
  description: LEGAL_BODY_COPY.page.description,
};

/** `/legal-body`: a legal body for an agent you already run. The flow brings its own providers. */
export default function LegalBodyPage() {
  return <LegalBodyFlow />;
}
