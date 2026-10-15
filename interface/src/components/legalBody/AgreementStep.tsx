"use client";

import { useRef, useState } from "react";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import {
  AmberPill,
  Button,
  Callout,
  Card,
  SectionTitle,
  Spinner,
  StepHeader,
} from "@/components/onboarding/primitives";
import {
  useCreateLegalBodyOrderMutation,
  useLegalBodyAgreementQuery,
  useLegalBodyOrdersQuery,
} from "@/lib/api/legalBodyHooks";
import type { LegalBodyAgreement, LegalBodyOrderView } from "@/lib/api/types";
import {
  agreementFacts,
  agreementOnScreen,
  agreementReadSentence,
  delayLine,
  draftOffer,
  expiryLine,
  orderRefusalOutcome,
  placedOrder,
  termsParagraphs,
  verifyAgreement,
} from "@/lib/legalBody/agreement";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { flowNowMs } from "@/lib/legalBody/resume";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const A = LEGAL_BODY_COPY.agreement;

/**
 * The agreement: the order is placed, and its frozen operating agreement is read.
 *
 * Before the order exists the step offers one thing: the live draft of this company when there is
 * one ("Continue with the order placed N hours ago"), else "Place the order and read the
 * agreement". The order is placed by that click alone, once per click: never on mount and never
 * in an effect, since React runs effects twice in development and an effect would place two
 * orders against a cap. This component has no effect at all.
 *
 * Once the order exists, its agreement is read and checked against its hash in the browser
 * (`verifyAgreement`) before a word of it is shown; one that does not check is a stop, with no
 * Continue. The terms are shown as text, with the hash the link will sign, the draft badge, the
 * amendment delay and the draft's expiry. "I have read this draft" gates Continue, which records
 * nothing: it tells the shell, in memory, that this order's agreement was read (`onRead`), and the
 * shell moves on to the identity step. A reload shows the agreement again.
 */
export function AgreementStep({
  kit,
  onRead,
  onBackToCompany,
}: {
  kit: LegalBodyStepKit;
  /** In memory only: this order's agreement was read on this visit. */
  onRead: (orderId: string) => void;
  /** The order door said the company cannot stand behind a body: the shell reads the company
   *  again and carries the door's sentence back to the company step. */
  onBackToCompany: (sentence: string) => void;
}) {
  // The order just placed, until the thread names it: the list is read again before the click
  // settles, so this covers only a list that could not be read.
  const [placed, setPlaced] = useState<LegalBodyOrderView | null>(null);
  const order =
    kit.order ?? (placed !== null && placed.companyId === kit.companyId ? placed : null);

  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.agreement}
        title={A.title}
        intro={order ? A.introAfter : A.introBefore}
      />
      {order ? (
        <OrderAgreement
          key={order.id}
          kit={kit}
          order={order}
          canContinue={kit.order !== null && kit.order.id === order.id}
          onRead={onRead}
        />
      ) : (
        <PlaceOrder kit={kit} onPlaced={setPlaced} onBackToCompany={onBackToCompany} />
      )}
    </div>
  );
}

/* ── Before the order ─────────────────────────────────────────────────────────────────────── */

function PlaceOrder({
  kit,
  onPlaced,
  onBackToCompany,
}: {
  kit: LegalBodyStepKit;
  onPlaced: (order: LegalBodyOrderView) => void;
  onBackToCompany: (sentence: string) => void;
}) {
  const { config, companyId } = kit;
  const createOrder = useCreateLegalBodyOrderMutation();
  const ordersQuery = useLegalBodyOrdersQuery();
  const [said, setSaid] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set and cleared inside the click: a second click before the first settles places nothing.
  const inFlight = useRef(false);
  const [mountedAt] = useState(() => Date.now());
  // The shell's clock: it moves with every read of the list, so no timer runs for a draft's age.
  const nowMs = flowNowMs(mountedAt, [ordersQuery.dataUpdatedAt]);

  const offer =
    companyId === null
      ? null
      : draftOffer({
          orders: kit.orders,
          companyId,
          where: { chainId: config.chainId, factory: config.factory },
          nowMs,
        });

  /** The live draft, continued: the memory names it, with no owner chosen for it yet. */
  function continueWith(draft: LegalBodyOrderView) {
    kit.remember({ companyId: draft.companyId, orderId: draft.id, ownerChoice: null, agentId: null });
  }

  /** The click: one order, once. */
  async function onPlace() {
    if (companyId === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setSaid(null);
    try {
      let answer: unknown;
      try {
        answer = await createOrder.mutateAsync(companyId);
      } catch (e) {
        if (kit.routeSignIn(e)) return;
        const outcome = orderRefusalOutcome(e);
        if (outcome.kind === "company") {
          setSaid(outcome.sentence);
          onBackToCompany(outcome.sentence);
          return;
        }
        setSaid(outcome.kind === "sentence" ? outcome.sentence : A.noAnswer);
        // An order may have been placed all the same: the list read again offers it as a draft.
        void ordersQuery.refetch();
        return;
      }
      const placed = placedOrder(answer, companyId);
      if (placed === null) {
        setSaid(A.noAnswer);
        void ordersQuery.refetch();
        return;
      }
      onPlaced(placed);
      kit.remember({ companyId, orderId: placed.id, ownerChoice: null, agentId: null });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      {offer && (
        <Card className="p-6">
          <p className="text-[13.5px] leading-[1.6] text-muted">{A.draftOffered}</p>
        </Card>
      )}
      {said && (
        <Callout tone="warn" className="mt-6">
          {said}
        </Callout>
      )}
      <StepNav>
        {offer ? (
          <Button onClick={() => continueWith(offer.order)} disabled={submitting}>
            {offer.label}
          </Button>
        ) : (
          <Button onClick={() => void onPlace()} loading={submitting} disabled={companyId === null}>
            {A.placeOrder}
          </Button>
        )}
      </StepNav>
    </>
  );
}

/* ── The order's agreement ────────────────────────────────────────────────────────────────── */

function OrderAgreement({
  kit,
  order,
  canContinue,
  onRead,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  /** Whether the thread names this order yet: Continue moves the thread's order. */
  canContinue: boolean;
  onRead: (orderId: string) => void;
}) {
  const agreementQuery = useLegalBodyAgreementQuery(order.id);
  const { data, error } = agreementQuery;

  if (data !== undefined) {
    const check = verifyAgreement(data);
    if (!check.ok) {
      return (
        <Callout tone="warn">
          {A.unverifiable}{" "}
          <span className="font-mono text-[11px] text-muted-2">({check.problem})</span>
        </Callout>
      );
    }
    return (
      <CheckedAgreement
        agreement={data}
        order={order}
        canContinue={canContinue}
        onContinue={() => onRead(order.id)}
      />
    );
  }

  if (error) {
    return (
      <>
        <Callout tone="warn">{agreementReadSentence(error)}</Callout>
        <StepNav>
          <Button
            onClick={() => {
              if (kit.routeSignIn(error)) return;
              void agreementQuery.refetch();
            }}
          >
            {A.retry}
          </Button>
        </StepNav>
      </>
    );
  }

  return (
    <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
      <Spinner className="h-3.5 w-3.5" /> {A.reading}
    </div>
  );
}

/** An agreement that checked against its hash, with every fact beside it. */
function CheckedAgreement({
  agreement,
  order,
  canContinue,
  onContinue,
}: {
  agreement: LegalBodyAgreement;
  order: LegalBodyOrderView;
  canContinue: boolean;
  onContinue: () => void;
}) {
  const [read, setRead] = useState(false);
  const [nowMs] = useState(() => Date.now());
  const shown = agreementOnScreen(agreement);
  const facts = agreementFacts(order, nowMs);
  const expiry = expiryLine(facts);
  const paragraphs = termsParagraphs(agreement.termsDoc);

  return (
    <>
      <Card className="p-6">
        <div className="flex flex-wrap items-center gap-3">
          <SectionTitle>{A.termsHeading}</SectionTitle>
          <span className="font-mono text-[11px] text-muted-2">{shown.wordingVersion}</span>
          {shown.draft && <AmberPill size="sm">{A.draftWording}</AmberPill>}
        </div>
        <div className="mt-4 flex max-h-[28rem] flex-col gap-3 overflow-y-auto pr-2">
          {paragraphs.map((p, i) => (
            // The terms never change for this order: a paragraph's place is its identity.
            <p key={i} className="whitespace-pre-wrap text-[13px] leading-[1.6] text-ink">
              {p}
            </p>
          ))}
        </div>
      </Card>

      <Card className="mt-6 p-6">
        <SectionTitle>{A.hashLabel}</SectionTitle>
        <p className="mt-2 break-all font-mono text-[12px] text-ink">{agreement.manifestHash}</p>
        <p className="mt-1 text-[12px] text-muted-2">{A.hashNote}</p>
        <div className="mt-5 flex flex-col gap-2">
          <p className="text-[13px] leading-[1.6] text-muted">{delayLine(facts)}</p>
          {expiry && <p className="text-[13px] leading-[1.6] text-muted">{expiry}</p>}
        </div>
      </Card>

      <label className="mt-6 flex cursor-pointer items-start gap-3 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={read}
          onChange={(e) => setRead(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border bg-paper-2 accent-[var(--accent)]"
        />
        <span className="text-muted">{A.readCheckbox}</span>
      </label>

      <StepNav>
        <Button onClick={onContinue} disabled={!read || !canContinue}>
          {A.continue}
        </Button>
      </StepNav>
    </>
  );
}
