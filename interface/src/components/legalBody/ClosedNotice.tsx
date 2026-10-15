"use client";

import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Card, StepHeader } from "@/components/onboarding/primitives";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import type { NoticeSentence } from "@/lib/legalBody/notice";

/**
 * An order that can no longer move: what happened, in the notice's words, and the one way out it
 * offers (a new order on the same company, or a new declaration), or none.
 */
export function ClosedNotice({
  sentence,
  onWayOut,
}: {
  sentence: NoticeSentence;
  onWayOut: (wayOut: "new_order" | "new_company") => void;
}) {
  const { wayOut } = sentence;
  return (
    <div>
      <StepHeader eyebrow={LEGAL_BODY_COPY.closed.eyebrow} title={sentence.title} />
      <Card className="p-6">
        <p className="text-[13.5px] leading-[1.6] text-muted">{sentence.body}</p>
      </Card>
      {wayOut !== "none" && (
        <StepNav>
          <Button onClick={() => onWayOut(wayOut)}>
            {wayOut === "new_order"
              ? LEGAL_BODY_COPY.closed.newOrder
              : LEGAL_BODY_COPY.closed.newCompany}
          </Button>
        </StepNav>
      )}
    </div>
  );
}

/**
 * The two ways on from an order that can no longer move here, though it is still open: a new order
 * on the same company, or a new declaration. The pointer steps show it under a stop no click there
 * can lift, so a deployed order whose pointer can never be written does not hold the person.
 */
export function WayOn({ onWayOut }: { onWayOut: (wayOut: "new_order" | "new_company") => void }) {
  return (
    <StepNav>
      <Button variant="ghost" onClick={() => onWayOut("new_company")}>
        {LEGAL_BODY_COPY.closed.newCompany}
      </Button>
      <Button onClick={() => onWayOut("new_order")}>{LEGAL_BODY_COPY.closed.newOrder}</Button>
    </StepNav>
  );
}
