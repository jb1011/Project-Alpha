"use client";

import type { ReactNode } from "react";
import { GetWorldIdHelp } from "@/components/guardian/GetWorldIdHelp";
import { PersonhoodSeal } from "@/components/guardian/PersonhoodSeal";
import { useWorldIdGate, WorldIdStatusRow } from "@/components/guardian/WorldIdGate";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Card, Spinner, StepHeader } from "@/components/onboarding/primitives";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { humanErrorSentence, humanStepView } from "@/lib/legalBody/gates";

const H = LEGAL_BODY_COPY.human;

/**
 * The human gate of the legal-body flow: a person the server's real-human check accepts must be on
 * record, and no waiver counts here.
 *
 * What the screen shows is `humanStepView`'s answer over the World ID gate's state, under this
 * product's rule (`requireRealHuman`, `forceRequired`). A refused record shows the flow's own
 * sentence, never the record line. `onEngage` tells the flow the person is acting on this gate, so
 * it stays on screen through the verification until Continue.
 */
export function HumanStep({
  onEngage,
  onContinue,
  onBack,
}: {
  onEngage: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { address } = useAuth();
  const { state, me, begin, busy, error, widget, refetch, struck } = useWorldIdGate({
    requireRealHuman: true,
    forceRequired: true,
  });
  const view = humanStepView(state);
  const accepted = view.title === "accepted";
  const problem = humanErrorSentence(error);

  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.human}
        title={accepted ? H.titleAccepted : H.titleAsk}
        intro={accepted ? H.introAccepted : H.product}
      />

      <Card className="p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-8">
          <div className="mx-auto h-[124px] w-[124px] shrink-0 sm:mx-0">
            <PersonhoodSeal
              seed={me?.nullifier ?? address ?? "novi-corpus"}
              verified={accepted}
              struck={struck}
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {view.line === "checking" && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Spinner className="h-3.5 w-3.5" /> {H.checking}
              </div>
            )}
            {view.line === "unavailable" && (
              <p className="text-[12.5px] leading-[1.6] text-muted">{H.unavailable}</p>
            )}
            {view.line === "unreadable" && (
              <p className="text-[12.5px] leading-[1.6] text-muted">{H.unreadable}</p>
            )}
            {view.line === "record" && (
              <WorldIdStatusRow
                state={state}
                notAcceptedSentence={H.notAccepted}
                acceptedLine={(credential) => fillCopy(H.verifiedAs, { credential })}
              />
            )}

            {view.points && (
              <>
                <ul className="flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
                  {H.points.map((point) => (
                    <Point key={point}>{point}</Point>
                  ))}
                </ul>
                <GetWorldIdHelp showWaiver={false} comeBackSentence={H.comeBack} />
              </>
            )}

            {problem && <Callout tone="warn">{problem}</Callout>}
          </div>
        </div>
      </Card>

      <StepNav onBack={onBack} backLabel={H.back}>
        {view.retry && (
          <Button variant="subtle" onClick={refetch}>
            {H.retry}
          </Button>
        )}
        {view.verify && (
          <Button
            onClick={() => {
              onEngage();
              void begin();
            }}
            loading={busy}
          >
            {H.verify}
          </Button>
        )}
        {view.continue && <Button onClick={onContinue}>{H.continue}</Button>}
      </StepNav>

      {widget}
    </div>
  );
}

function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-2" />
      <span>{children}</span>
    </li>
  );
}
