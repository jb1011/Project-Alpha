"use client";

import { useState } from "react";
import { useConnection, useSignTypedData } from "wagmi";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import {
  AmberPill,
  Button,
  Callout,
  Card,
  Field,
  SectionTitle,
  Spinner,
  StepHeader,
  TextInput,
} from "@/components/onboarding/primitives";
import { useCompaniesQuery } from "@/lib/api/hooks";
import {
  useAbandonCompanyMutation,
  useCreateCustomerCompanyMutation,
  useStatementMessageMutation,
} from "@/lib/api/legalBodyHooks";
import type { CustomerStatementInput, StatementMessageAnswer } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import {
  abandonRefusalSentence,
  companyScreen,
  declarationInput,
  declinedSentence,
  gateRefusalOutcome,
  hasProblems,
  isAlreadyDeclared,
  ownCompanyWithNumber,
  statementOnScreen,
  statementSubmitOutcome,
  stopSentence,
  validateDeclaration,
  type CompanyScreen,
  type DeclarationForm,
  type DeclarationProblems,
} from "@/lib/legalBody/declaration";
import type { NoticeSentence } from "@/lib/legalBody/notice";
import { signThroughGate, statementSignGate } from "@/lib/legalBody/signGate";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const C = LEGAL_BODY_COPY.company;

const EMPTY_FORM: DeclarationForm = {
  companyName: "",
  filingNumber: "",
  declarantName: "",
  declarantTitle: "",
};

/**
 * Your company: the person declares the company behind their agent and signs the statement of
 * authority in their wallet; the company is created and the flow moves on.
 *
 * On a sandbox the declaration is a test one, said out loud: the label, the hints that the name
 * says it is a test and the number starts with TEST-, and the sentence that the check is automatic
 * and checks nothing. On production the person types the four fields.
 *
 * What the step shows is `companyScreen`'s answer for the derivation's state. Every request is a
 * click's: the form, then the statement, then the gate (the wallet opens only for a statement the
 * gate accepted, and the page shows its sentence meanwhile), then the company, then the memory,
 * and the derivation moves on once the check reads `verified`. The form lives in this component's
 * state, never in a store.
 */
export function CompanyStep({ kit }: { kit: LegalBodyStepKit }) {
  const { config, derivation } = kit;
  const screen = companyScreen({
    step: derivation.companyStep ?? "loading",
    notice: derivation.notice,
    environment: config.environment,
    verificationState: kit.company?.verification?.state ?? null,
  });
  const intro =
    screen.kind === "form"
      ? config.environment === "sandbox"
        ? C.introSandbox
        : C.introProduction
      : undefined;

  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.company}
        title={screen.kind === "status" ? screen.title : C.title}
        intro={intro}
      />
      {screen.kind === "form" && <Declaration kit={kit} notice={screen.notice} />}
      {screen.kind === "loading" && (
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> {LEGAL_BODY_COPY.frame.loading}
        </div>
      )}
      {screen.kind === "status" && <CompanyStatus kit={kit} screen={screen} />}
    </div>
  );
}

/* ── The declaration ───────────────────────────────────────────────────────────────────────── */

type Said = { tone: "warn" | "info"; text: string };

/** Which door a refusal came from: only the create door answers `statement_stale`. */
type Door = "statement" | "create";

function Declaration({ kit, notice }: { kit: LegalBodyStepKit; notice: NoticeSentence | null }) {
  const { config, tenant } = kit;
  const environment = config.environment;
  const sandbox = environment === "sandbox";

  const [form, setForm] = useState<DeclarationForm>(EMPTY_FORM);
  const [problems, setProblems] = useState<DeclarationProblems>({});
  // The statement on screen: one the gate accepted, for the form as it now stands.
  const [onScreen, setOnScreen] = useState<StatementMessageAnswer | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  // The tenant's own company that already declared the typed number, when the door said so.
  const [continueWith, setContinueWith] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const statementMessage = useStatementMessageMutation();
  const createCompany = useCreateCustomerCompanyMutation();
  const companiesQuery = useCompaniesQuery();
  const { signTypedDataAsync } = useSignTypedData();
  const { chainId: walletChainId } = useConnection();

  function edit(field: keyof DeclarationForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    // The statement on screen and the offer were for the form as it was.
    setOnScreen(null);
    setContinueWith(null);
    setProblems((p) => {
      const next = { ...p };
      delete next[field];
      return next;
    });
  }

  /** The gate's context, with the clock read at the click. */
  function gateContext(input: CustomerStatementInput) {
    return {
      config: { chainId: config.chainId, factory: config.factory },
      sessionAddress: tenant,
      typed: input,
      nowSeconds: Math.floor(Date.now() / 1000),
    };
  }

  async function onSign() {
    if (busy) return;
    const local = validateDeclaration(form, environment);
    setProblems(local);
    setSaid(null);
    setContinueWith(null);
    if (hasProblems(local)) return;
    const input = declarationInput(form, environment);
    setBusy(true);
    try {
      await declare(input, onScreen);
    } finally {
      setBusy(false);
    }
  }

  /** The click's chain: the statement (the one on screen, or a new one), the gate, the wallet,
   *  the company, the memory. */
  async function declare(input: CustomerStatementInput, shown: StatementMessageAnswer | null) {
    let served = shown;
    if (served === null) {
      try {
        served = await statementMessage.mutateAsync(input);
      } catch (e) {
        await refusedBy(e, input, "statement");
        return;
      }
    }

    const gate = statementSignGate(served, gateContext(input));
    if (!gate.ok) {
      setOnScreen(null);
      const outcome = gateRefusalOutcome(gate.problem, shown !== null);
      if (outcome.kind === "refetch") await renew(input);
      else if (outcome.kind === "stop") setSaid({ tone: "warn", text: stopSentence(outcome.problem) });
      return;
    }

    // The sentence the wallet is about to show, on the page as well.
    setOnScreen(served);
    const signed = await signThroughGate(gate, (typedData) => signTypedDataAsync(typedData));
    if (signed.kind === "declined") {
      setSaid({ tone: "warn", text: declinedSentence(walletChainId, config) });
      return;
    }
    if (signed.kind === "refused") {
      setOnScreen(null);
      setSaid({ tone: "warn", text: stopSentence(signed.problem) });
      return;
    }

    let companyId: string;
    try {
      ({ companyId } = await createCompany.mutateAsync({
        ...input,
        issuedAt: served.typedData.message.issuedAt,
        signature: signed.signature,
      }));
    } catch (e) {
      await refusedBy(e, input, "create");
      return;
    }
    kit.remember({ companyId, orderId: null });
  }

  /** A new statement for the same form, checked and shown, with a word that it is new: the person
   *  signs it with a click of their own. */
  async function renew(input: CustomerStatementInput) {
    let served: StatementMessageAnswer;
    try {
      served = await statementMessage.mutateAsync(input);
    } catch (e) {
      await refusedBy(e, input, "statement");
      return;
    }
    const gate = statementSignGate(served, gateContext(input));
    if (!gate.ok) {
      setOnScreen(null);
      setSaid({ tone: "warn", text: stopSentence(gate.problem) });
      return;
    }
    setOnScreen(served);
    setSaid({ tone: "info", text: C.renewed });
  }

  async function refusedBy(e: unknown, input: CustomerStatementInput, door: Door) {
    if (kit.routeSignIn(e)) return;
    const outcome = statementSubmitOutcome(e);
    setOnScreen(null);
    switch (outcome.kind) {
      case "refetch":
        // Asked again once per click: a new statement refused the same way is not asked again.
        if (door === "create") await renew(input);
        else setSaid({ tone: "warn", text: e instanceof Error ? e.message : C.noAnswer });
        return;
      case "fields": {
        setProblems(outcome.problems);
        if (isAlreadyDeclared(outcome)) {
          // Read the list again first: the company may be one declared from here a moment ago.
          const read = await companiesQuery.refetch();
          setContinueWith(
            ownCompanyWithNumber(outcome, input.filingNumber, read.data?.companies ?? []),
          );
        }
        return;
      }
      case "sentence":
        setSaid({ tone: "warn", text: outcome.sentence });
        // A company may have been made all the same: the list read again shows it.
        if (door === "create") void companiesQuery.refetch();
        return;
      case "stop":
        setSaid({ tone: "warn", text: stopSentence(outcome.problem) });
        void companiesQuery.refetch();
        return;
    }
  }

  const field = (name: keyof DeclarationForm, hint: string | undefined, placeholder?: string) => (
    <Field label={C.labels[name]} hint={hint} error={problems[name]} htmlFor={`legal-body-${name}`}>
      <TextInput
        id={`legal-body-${name}`}
        value={form[name]}
        onChange={(e) => edit(name, e.target.value)}
        invalid={problems[name] !== undefined}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
    </Field>
  );

  const shown = onScreen ? statementOnScreen(onScreen) : null;

  return (
    <>
      {notice && (
        <Callout tone="warn" title={notice.title} className="mb-6">
          {notice.body}
        </Callout>
      )}

      <Card className="p-6">
        {sandbox && (
          <div className="mb-5">
            <AmberPill size="label">{C.testLabel}</AmberPill>
          </div>
        )}
        <div className="flex flex-col gap-5">
          {field(
            "companyName",
            sandbox ? C.nameHintSandbox : undefined,
            sandbox ? C.placeholdersSandbox.companyName : undefined,
          )}
          {field(
            "filingNumber",
            sandbox ? C.numberHintSandbox : C.numberHintProduction,
            sandbox ? C.placeholdersSandbox.filingNumber : undefined,
          )}
          {!sandbox && field("declarantName", undefined)}
          {!sandbox && field("declarantTitle", undefined)}
        </div>
        {sandbox && (
          <Callout tone="warn" className="mt-6">
            {C.sandboxCheck}
          </Callout>
        )}
      </Card>

      {shown && (
        <Card className="mt-6 p-6">
          <div className="flex flex-wrap items-center gap-3">
            <SectionTitle>{C.statementHeading}</SectionTitle>
            <span className="font-mono text-[11px] text-muted-2">{shown.wordingVersion}</span>
            {shown.draft && <AmberPill size="sm">{C.draftWording}</AmberPill>}
          </div>
          <p className="mt-3 text-[13.5px] leading-[1.6] text-ink">{shown.sentence}</p>
        </Card>
      )}

      {said && (
        <Callout tone={said.tone} className="mt-6">
          {said.text}
        </Callout>
      )}
      {continueWith && (
        <Callout tone="info" className="mt-6">
          {C.alreadyYours}
        </Callout>
      )}

      <StepNav>
        {continueWith && (
          <Button
            variant="ghost"
            onClick={() => kit.remember({ companyId: continueWith, orderId: null })}
            disabled={busy}
          >
            {C.continueWith}
          </Button>
        )}
        <Button onClick={() => void onSign()} loading={busy}>
          {C.sign}
        </Button>
      </StepNav>
    </>
  );
}

/* ── The check's other states ──────────────────────────────────────────────────────────────── */

function CompanyStatus({
  kit,
  screen,
}: {
  kit: LegalBodyStepKit;
  screen: Extract<CompanyScreen, { kind: "status" }>;
}) {
  const abandon = useAbandonCompanyMutation();
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const companyId = kit.companyId;
  const canAbandon = screen.abandon && companyId !== null;

  async function onAbandon() {
    if (companyId === null || abandon.isPending) return;
    setRefusal(null);
    try {
      await abandon.mutateAsync(companyId);
    } catch (e) {
      if (kit.routeSignIn(e)) return;
      setRefusal(abandonRefusalSentence(e));
      return;
    }
    setConfirming(false);
    kit.startAnother("new_company");
  }

  return (
    <>
      <Card className="p-6">
        {screen.stateWord && (
          <div className="mb-4">
            <span className="rounded-full border hairline-strong px-2.5 py-0.5 font-mono text-[11px] text-muted">
              {screen.stateWord}
            </span>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {screen.lines.map((line) => (
            <p key={line} className="text-[13.5px] leading-[1.6] text-muted">
              {line}
            </p>
          ))}
        </div>
      </Card>

      {confirming && (
        <Callout tone="warn" className="mt-6">
          {C.abandonConfirm}
        </Callout>
      )}
      {refusal && (
        <Callout tone="warn" className="mt-6">
          {refusal}
        </Callout>
      )}

      {(screen.newDeclaration || canAbandon) && (
        <StepNav>
          {canAbandon &&
            (confirming ? (
              <>
                <Button variant="subtle" onClick={() => setConfirming(false)}>
                  {C.abandonKeep}
                </Button>
                <Button variant="danger" onClick={() => void onAbandon()} loading={abandon.isPending}>
                  {C.abandonYes}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming(true);
                  setRefusal(null);
                }}
              >
                {C.abandon}
              </Button>
            ))}
          {screen.newDeclaration && !confirming && (
            <Button onClick={() => kit.startAnother("new_company")}>{C.newDeclaration}</Button>
          )}
        </StepNav>
      )}
    </>
  );
}
