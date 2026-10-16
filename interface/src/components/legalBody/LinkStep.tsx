"use client";

import { useRef, useState } from "react";
import { useConnection, useSignTypedData } from "wagmi";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import {
  Button,
  Callout,
  Card,
  SectionTitle,
  Spinner,
  StepHeader,
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
import { sameAddress } from "@/lib/legalBody/flow";
import { identityOnStep } from "@/lib/legalBody/identity";
import {
  decodeLinkFields,
  keepsSignedLink,
  linkAnswerOutcome,
  linkClickPlan,
  linkErrorOutcome,
  linkFieldRows,
  linkOutcomeView,
  linkRequestFor,
  linkScreen,
  type LinkOutcomeView,
  type LinkSendBack,
  type LinkStepOutcome,
  type SignedLink,
} from "@/lib/legalBody/link";
import { noticeSentence } from "@/lib/legalBody/notice";
import { linkSignGate, signThroughGate } from "@/lib/legalBody/signGate";
import { IdentityLine } from "./IdentityLine";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const L = LEGAL_BODY_COPY.link;
const A = LEGAL_BODY_COPY.agreement;

/** Where the click is: asking for the link, in the wallet, or sending the signed link. */
type Stage = "asking" | "wallet" | "sending";

const STAGE_WORDS: Record<Stage, string> = {
  asking: L.asking,
  wallet: L.inWallet,
  sending: L.sending,
};

/**
 * Sign the link, on the branch where the wallet in session owns the identity: the signature that
 * creates the legal body.
 *
 * Before the click the step shows what will be signed in words and nothing else: the link is
 * asked for on the click of "Sign" alone, never on mount and never in an effect. One click is one
 * chain: the link asked for once; the gate (every field against the order, the agreement read on
 * it, the identity picked and this wallet, then the identity's owner against this wallet); the
 * five fields and the domain shown decoded while the wallet opens; one signature; one send. The
 * wallet opens only for typed data the gate accepted. A second click while one is in flight does
 * nothing (a `submitting` flag for the screen, a ref for the click itself).
 *
 * Every answer of the two link doors is read by a pure function (`linkAnswerOutcome`,
 * `linkErrorOutcome`) and shown by another (`linkOutcomeView`); the doors' sentences are shown as
 * served. A refusal that sends the person elsewhere goes back to the shell (`onSendBack`), which
 * carries the sentence there. While the body is being created the step says so, and the shell
 * reads the order every 5 seconds.
 */
export function LinkStep({
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
  const screen = linkScreen(kit.derivation);
  const shownId = identityOnStep({ order: kit.order, memoryAgentId: agentId });

  if (screen === "creating") {
    const notice = noticeSentence({ kind: "creating" }, kit.config.environment);
    return (
      <div>
        <StepHeader eyebrow={LEGAL_BODY_COPY.rail.labels.link} title={L.creating} />
        <IdentityLine agentId={shownId} />
        <Card className="p-6">
          <p className="flex items-center gap-2 text-[13.5px] leading-[1.6] text-muted">
            <Spinner className="h-3.5 w-3.5" /> {notice.body}
          </p>
        </Card>
      </div>
    );
  }
  // The paste branch has its own panel: this step never opens this browser's wallet for it.
  if (screen !== "sign") return null;

  const order = kit.order;
  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.link}
        title={L.title}
        intro={agentId !== null ? fillCopy(L.intro, { agentId }) : undefined}
      />
      <IdentityLine agentId={shownId} />
      {order === null || agentId === null ? (
        <Callout tone="warn">{L.identityUnknown}</Callout>
      ) : (
        <OrderLink kit={kit} order={order} agentId={agentId} onSendBack={onSendBack} />
      )}
    </div>
  );
}

/** The order's agreement, read and checked before the link can be: the link signs its hash. */
function OrderLink({
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
    // Consistent in itself, and this order's own: anything else is a stop, with no Sign.
    const problem = agreementProblem(order, data);
    if (problem !== null) {
      return (
        <Callout tone="warn">
          {A.unverifiable} <span className="font-mono text-[11px] text-muted-2">({problem})</span>
        </Callout>
      );
    }
    return (
      <SignPanel
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

/** The click, and what it showed. */
function SignPanel({
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
  const { signTypedDataAsync } = useSignTypedData();
  const { address, chainId: walletChainId } = useConnection();

  const [submitting, setSubmitting] = useState<Stage | null>(null);
  // Set and cleared inside a click: a second click before the first settles asks and sends nothing.
  const inFlight = useRef(false);
  // The link the wallet is asked to sign, or was: shown decoded, with the clock read at its check.
  const [shown, setShown] = useState<{ served: LinkMessageResult; at: number } | null>(null);
  // A signed link the door changed nothing for: "Try again" sends it once more.
  const [held, setHeld] = useState<SignedLink | null>(null);
  const [said, setSaid] = useState<LinkOutcomeView | null>(null);

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  /** The outcome of a click: what is kept, what is said, and where the flow goes. */
  function settle(outcome: LinkStepOutcome, link: SignedLink | null) {
    const keep = link !== null && keepsSignedLink(outcome);
    setHeld(keep ? link : null);
    if (!keep) setShown(null);
    const view = linkOutcomeView(outcome, config);
    setSaid(view);
    if (view.sendBack) onSendBack(view.sendBack.to, view.sendBack.sentence);
  }

  /** One click: a fresh link, or the kept signed link sent once more. */
  async function onClick(click: "sign" | "retry") {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaid(null);
    try {
      const plan = linkClickPlan({ click, held, nowSeconds: nowSeconds() });
      if (plan.kind === "resubmit") await send(plan.link);
      else await signFresh();
    } finally {
      inFlight.current = false;
      setSubmitting(null);
    }
  }

  /** The link asked for, checked, shown, signed, and sent. */
  async function signFresh() {
    setHeld(null);
    setShown(null);
    // The wallet that signs is the one signed in: the gate checks the link against it.
    if (!address || !sameAddress(address, tenant)) {
      settle({ kind: "not_connected" }, null);
      return;
    }
    const asked = linkRequestFor("browser", config);
    if ("problem" in asked) {
      settle({ kind: "stop", problem: asked.problem }, null);
      return;
    }

    setSubmitting("asking");
    let served: LinkMessageResult;
    try {
      served = await linkMessage.mutateAsync({ agentId, ...asked });
    } catch (e) {
      if (kit.routeSignIn(e)) return;
      settle(linkErrorOutcome(e, "message"), null);
      return;
    }

    const at = nowSeconds();
    const gate = linkSignGate(served, {
      order,
      agreement,
      sessionAddress: tenant,
      agentId,
      nowSeconds: at,
      linkTtlMax: config.linkTtl.max,
      branch: "browser",
    });
    if (!gate.ok) {
      settle({ kind: "stop", problem: gate.problem }, null);
      return;
    }

    // What the wallet is about to show, on the page as well.
    setShown({ served, at });
    setSubmitting("wallet");
    const signed = await signThroughGate(gate, (typedData) => signTypedDataAsync(typedData));
    if (signed.kind === "refused") {
      settle({ kind: "stop", problem: signed.problem }, null);
      return;
    }
    if (signed.kind === "declined") {
      settle({ kind: "declined", walletChainId }, null);
      return;
    }
    await send({ served, signature: signed.signature });
  }

  /** The signed link, sent once, exactly as it was served. */
  async function send(link: SignedLink) {
    setSubmitting("sending");
    let answer: LinkSubmitAnswer;
    try {
      answer = await submitLink.mutateAsync({
        message: link.served.typedData.message,
        signature: link.signature,
      });
    } catch (e) {
      if (kit.routeSignIn(e)) return;
      settle(linkErrorOutcome(e, "submit"), link);
      return;
    }
    settle(linkAnswerOutcome(answer, order.id), link);
  }

  const decoded = shown ? decodeLinkFields(shown.served.typedData, shown.at) : null;
  const action = said?.action ?? "sign";
  const lines = said?.lines ?? [];

  return (
    <>
      <Card className="p-6">
        <p className="text-[13.5px] leading-[1.6] text-muted">{L.howItWorks}</p>
      </Card>

      {decoded && (
        <Card className="mt-6 p-6">
          <SectionTitle>{L.fieldsHeading}</SectionTitle>
          <dl className="mt-4 flex flex-col gap-3">
            {linkFieldRows(decoded).map((row) => (
              <div key={row.label} className="grid grid-cols-1 gap-1 sm:grid-cols-[150px_1fr] sm:gap-4">
                <dt className="font-mono text-[11.5px] uppercase tracking-[0.12em] text-muted-2">
                  {row.label}
                </dt>
                <dd className="min-w-0">
                  <span className="break-all font-mono text-[12.5px] text-ink">{row.value}</span>
                  {row.note && (
                    <span className="mt-0.5 block text-[12px] text-muted">{row.note}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
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
        {action === "new_order" ? (
          <Button onClick={() => kit.startAnother("new_order")}>{L.placeNewOrder}</Button>
        ) : (
          <Button onClick={() => void onClick(action)} loading={submitting !== null}>
            {action === "retry" ? L.retry : L.sign}
          </Button>
        )}
      </StepNav>
    </>
  );
}
