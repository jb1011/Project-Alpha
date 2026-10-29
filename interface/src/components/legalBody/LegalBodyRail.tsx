"use client";

import { Stepper } from "@/components/onboarding/Stepper";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { railCurrentTag, type LegalBodyRailPhase } from "@/lib/legalBody/phases";

/**
 * The legal-body flow's rail: the wizard's rail with the flow's heading, footer and words. The
 * phases, the current one and the done map are the shell's (`visibleLegalBodyPhases`,
 * `railCurrentOf`, `railDoneOf`); the word under the current phase is `railCurrentTag`'s, so the
 * done page never reads "In progress".
 */
export function LegalBodyRail({
  phases,
  current,
  done,
  onJump,
}: {
  phases: { id: LegalBodyRailPhase; label: string }[];
  current: LegalBodyRailPhase;
  done: Record<string, boolean>;
  onJump: (phase: LegalBodyRailPhase) => void;
}) {
  return (
    <Stepper<LegalBodyRailPhase>
      phases={phases}
      current={current}
      done={done}
      onJump={onJump}
      heading={LEGAL_BODY_COPY.rail.heading}
      footer={LEGAL_BODY_COPY.rail.footer}
      currentTag={railCurrentTag(current)}
    />
  );
}
