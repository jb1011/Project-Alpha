"use client";

import { useRef, useState } from "react";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import {
  Button,
  Callout,
  Card,
  Field,
  SectionTitle,
  Spinner,
  StepHeader,
  Textarea,
} from "@/components/onboarding/primitives";
import {
  useLegalBodyAgreementQuery,
  useLinkMessageMutation,
  useSubmitLinkMutation,
} from "@/lib/api/legalBodyHooks";
import type {
  LegalBodyAgreement,
  LegalBodyOrderView,
  LinkMessageResult,
  LinkSubmitAnswer,
} from "@/lib/api/types";
import { agreementProblem, agreementReadSentence } from "@/lib/legalBody/agreement";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import {
  decodeLinkFields,
  linkAnswerOutcome,
  linkFieldRows,
  linkRequestFor,
  type LinkFieldRow,
  type LinkSendBack,
} from "@/lib/legalBody/link";
import {
  pasteCopyGate,
  pasteErrorOutcome,
  pasteOutcomeView,
  pasteSubmitPlan,
  type PasteOutcome,
} from "@/lib/legalBody/paste";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const P = LEGAL_BODY_COPY.paste;
const L = LEGAL_BODY_COPY.link;
const A = LEGAL_BODY_COPY.agreement;

/** Where the click is: asking for the link, or sending the pasted signature. */
type Stage = "asking" | "sending";

const STAGE_WORDS: Record<Stage, string> = { asking: L.asking, sending: L.sending };

/**
 * Sign the link elsewhere: the identity is owned by another key (an agent's signer, a hardware
 * wallet, a Circle wallet), so the link is signed wherever that key lives and the signature pasted
 * back here. No wallet is prompted on this panel and no API key is asked for.
 *
 * The link is asked for on the click of "Get the link" alone, with the six hours this branch
 * needs, never on mount and never in an effect. Its fields are all checked before anything is
 * shown (`pasteCopyGate`); then the fields decoded, the signer note, and the typed data exactly
 * as served in a copy box. The pasted signature goes through `pasteSubmitPlan`: a problem is said
 * under the field and never reaches the door. One click sends once (a `submitting` stage for the
 * screen, a ref for the click itself). The doors' answers are read by the link step's own
 * functions and shown by `pasteOutcomeView`, the doors' sentences as served; a flat refusal keeps
 * the draft, so the owner key can sign again.
 */
export function PasteLinkPanel({
  kit,
  agentId,
  onSendBack,
}: {
  kit: LegalBodyStepKit;
  /** The identity picked for this draft, from this browser's memory. */
  agentId: string | null;
  /** A door's refusal that sends the person to another step, with its sentence. */
  onSendBack: (to: LinkSendBack, sentence: string) => void;
}) {
  const order = kit.order;
  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.link}
        title={P.title}
        intro={agentId !== null ? fillCopy(P.intro, { agentId }) : undefined}
      />
      {order === null || agentId === null ? (
        <Callout tone="warn">{L.identityUnknown}</Callout>
      ) : (
        <PasteOrderLink kit={kit} order={order} agentId={agentId} onSendBack={onSendBack} />
      )}
      <McpNote />
    </div>
  );
}

/** The order's agreement, read and checked first: the link signs its hash. */
function PasteOrderLink({
  kit,
  order,
  agentId,
  onSendBack,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  agentId: string;
  onSendBack: (to: LinkSendBack, sentence: string) => void;
}) {
  const agreementQuery = useLegalBodyAgreementQuery(order.id);
  const { data, error } = agreementQuery;

  if (data !== undefined) {
    const problem = agreementProblem(order, data);
    if (problem !== null) {
      return (
        <Callout tone="warn">
          {A.unverifiable} <span className="font-mono text-[11px] text-muted-2">({problem})</span>
        </Callout>
      );
    }
    return (
      <PastePanel
        kit={kit}
        order={order}
        agentId={agentId}
        agreement={data}
        onSendBack={onSendBack}
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
            {L.retry}
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

/** The link served and checked, as it is shown: with the clock read at its check. */
type ShownLink = { served: LinkMessageResult; text: string; at: number };

/** The two clicks, and what they showed. */
function PastePanel({
  kit,
  order,
  agentId,
  agreement,
  onSendBack,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  agentId: string;
  agreement: LegalBodyAgreement;
  onSendBack: (to: LinkSendBack, sentence: string) => void;
}) {
  const { config, tenant } = kit;
  const linkMessage = useLinkMessageMutation(order.id);
  const submitLink = useSubmitLinkMutation(order.id);

  const [submitting, setSubmitting] = useState<Stage | null>(null);
  // Set and cleared inside a click: a second click before the first settles asks and sends nothing.
  const inFlight = useRef(false);
  const [shown, setShown] = useState<ShownLink | null>(null);
  const [draft, setDraft] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [newOrder, setNewOrder] = useState(false);

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  /** The outcome of a click: what is kept, what is said, and where the flow goes. */
  function settle(outcome: PasteOutcome) {
    const view = pasteOutcomeView(outcome, config);
    if (view.dropLink) {
      setShown(null);
      setDraft("");
    }
    setLines(view.lines);
    setFieldError(view.fieldError);
    setNewOrder(view.newOrder);
    if (view.sendBack) onSendBack(view.sendBack.to, view.sendBack.sentence);
  }

  function begin(): boolean {
    if (inFlight.current) return false;
    inFlight.current = true;
    setLines([]);
    setFieldError(null);
    return true;
  }

  function end() {
    inFlight.current = false;
    setSubmitting(null);
  }

  /** "Get the link": asked for once, checked, then shown to copy. */
  async function onGetLink() {
    if (!begin()) return;
    try {
      setShown(null);
      setDraft("");
      const asked = linkRequestFor("paste", config);
      if ("problem" in asked) {
        settle({ kind: "stop", problem: asked.problem });
        return;
      }
      setSubmitting("asking");
      let served: LinkMessageResult;
      try {
        served = await linkMessage.mutateAsync({ agentId, ...asked });
      } catch (e) {
        if (kit.routeSignIn(e)) return;
        settle(pasteErrorOutcome(e, "message"));
        return;
      }
      const at = nowSeconds();
      const gate = pasteCopyGate(served, {
        order,
        agreement,
        sessionAddress: tenant,
        agentId,
        nowSeconds: at,
        linkTtlMax: config.linkTtl.max,
      });
      if (!gate.ok) {
        settle({ kind: "stop", problem: gate.problem });
        return;
      }
      setShown({ served, text: gate.text, at });
    } finally {
      end();
    }
  }

  /** "Send the signature": the pasted text checked here first, then sent once. */
  async function onSend() {
    if (shown === null || !begin()) return;
    try {
      const plan = pasteSubmitPlan({ served: shown.served, raw: draft, nowSeconds: nowSeconds() });
      if (plan.kind !== "send") {
        settle(plan);
        return;
      }
      setSubmitting("sending");
      let answer: LinkSubmitAnswer;
      try {
        answer = await submitLink.mutateAsync({
          message: shown.served.typedData.message,
          signature: plan.signature,
        });
      } catch (e) {
        if (kit.routeSignIn(e)) return;
        settle(pasteErrorOutcome(e, "submit"));
        return;
      }
      settle(linkAnswerOutcome(answer, order.id));
    } finally {
      end();
    }
  }

  const rows = shown ? linkFieldRows(decodeLinkFields(shown.served.typedData, shown.at)) : null;
  const owner: unknown = shown?.served.identityOwner;

  return (
    <>
      <Card className="p-6">
        <p className="text-[13.5px] leading-[1.6] text-muted">{P.howItWorks}</p>
      </Card>

      {shown && rows && (
        <>
          <Card className="mt-6 p-6">
            <SectionTitle>{L.fieldsHeading}</SectionTitle>
            <FieldRows rows={rows} />
            {typeof owner === "string" && (
              <p className="mt-4 break-all text-[12.5px] leading-[1.6] text-muted">
                {fillCopy(P.owner, { owner })}
              </p>
            )}
          </Card>

          <Callout tone="info" className="mt-6">
            {fillCopy(P.signerNote, { agentId })}
          </Callout>

          <Card className="mt-6 p-6">
            <CopyBox heading={P.typedDataHeading} text={shown.text} />
          </Card>

          <Card className="mt-6 p-6">
            <Field
              label={P.signatureLabel}
              hint={P.signatureHint}
              error={fieldError ?? undefined}
              htmlFor="legal-body-pasted-signature"
            >
              <Textarea
                id="legal-body-pasted-signature"
                rows={4}
                value={draft}
                invalid={fieldError !== null}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                className="break-all font-mono text-[12px]"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setFieldError(null);
                }}
              />
            </Field>
          </Card>
        </>
      )}

      <p className="mt-6 text-[12.5px] leading-[1.6] text-muted">
        {LEGAL_BODY_COPY.wallet.neverApprove}
      </p>

      {submitting && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> {STAGE_WORDS[submitting]}
        </div>
      )}

      {lines.length > 0 && (
        <Callout tone="warn" className="mt-6">
          <span className="flex flex-col gap-2">
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </Callout>
      )}

      <StepNav>
        {newOrder ? (
          <Button onClick={() => kit.startAnother("new_order")}>{L.placeNewOrder}</Button>
        ) : shown ? (
          <Button onClick={() => void onSend()} loading={submitting !== null}>
            {P.send}
          </Button>
        ) : (
          <Button onClick={() => void onGetLink()} loading={submitting !== null}>
            {P.getLink}
          </Button>
        )}
      </StepNav>
    </>
  );
}

/** Label, value and note, one row each; values break anywhere, so a long hex never widens the
 *  page. */
export function FieldRows({ rows }: { rows: LinkFieldRow[] }) {
  return (
    <dl className="mt-4 flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-1 gap-1 sm:grid-cols-[150px_1fr] sm:gap-4">
          <dt className="font-mono text-[11.5px] uppercase tracking-[0.12em] text-muted-2">
            {row.label}
          </dt>
          <dd className="min-w-0">
            <span className="break-all font-mono text-[12.5px] text-ink">{row.value}</span>
            {row.note && <span className="mt-0.5 block text-[12px] text-muted">{row.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Data to copy, shown whole and selectable, with a Copy button. When the clipboard is not there or
 * refuses, the person is told to select the text instead. The text is data (typed data, a hex
 * value), never a command.
 */
export function CopyBox({ heading, text }: { heading: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "by_hand">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("by_hand");
    }
  }

  return (
    <div className="min-w-0">
      <SectionTitle>{heading}</SectionTitle>
      <pre className="mt-3 max-h-80 select-all overflow-auto whitespace-pre-wrap break-all rounded-xl border hairline bg-paper-2/60 p-3 font-mono text-[11.5px] leading-relaxed text-ink">
        {text}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={() => void copy()}>
          {state === "copied" ? P.copied : P.copy}
        </Button>
        {state === "by_hand" && <span className="text-[11.5px] text-muted-2">{P.copyByHand}</span>}
      </div>
    </div>
  );
}

/** The tools an automated agent can use instead, by name, and where their key comes from. This
 *  page never asks for that key. */
export function McpNote() {
  return <p className="mt-10 text-[12px] leading-[1.6] text-muted-2">{P.mcp}</p>;
}
