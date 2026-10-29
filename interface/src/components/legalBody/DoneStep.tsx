"use client";

import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, StepHeader } from "@/components/onboarding/primitives";
import { useLegalBodyByAgentQuery } from "@/lib/api/legalBodyHooks";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { noticeSentence } from "@/lib/legalBody/notice";
import { publicReadAllowed } from "@/lib/legalBody/standing";
import { LegalBodyRecord } from "./LegalBodyRecord";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const D = LEGAL_BODY_COPY.done;

/**
 * Done: the body's public record, the thread's notice when it has one, and what to do next.
 *
 * The public by-agent answer is read only for a linked order (`publicReadAllowed`): there is no
 * public link before it. It is never polled and never retried on its own; Try again reads it once
 * more, on a click. The two ways on set the shell's intents: a new order on the same company, or a
 * new declaration. Nothing here writes.
 */
export function DoneStep({ kit }: { kit: LegalBodyStepKit }) {
  const order = kit.order;
  const byAgent = useLegalBodyByAgentQuery(order?.agentId, publicReadAllowed(order));
  const notice = kit.derivation.notice
    ? noticeSentence(kit.derivation.notice, kit.config.environment)
    : null;

  return (
    <div>
      <StepHeader eyebrow={LEGAL_BODY_COPY.rail.labels.done} title={D.title} intro={D.intro} />
      {notice && (
        <Callout tone="warn" title={notice.title} className="mb-6">
          {notice.body}
        </Callout>
      )}
      {order && (
        <LegalBodyRecord
          read={byAgent.data ?? null}
          orderState={order.state}
          environment={kit.config.environment}
          paymentRequired={kit.config.paymentRequired}
          onRetry={() => void byAgent.refetch()}
          retrying={byAgent.isFetching}
        />
      )}
      <StepNav>
        <Button onClick={() => kit.startAnother("new_order")}>{D.anotherAgent}</Button>
        <Button variant="ghost" onClick={() => kit.startAnother("new_company")}>
          {D.anotherCompany}
        </Button>
      </StepNav>
    </div>
  );
}
