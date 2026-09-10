"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AgentConfig,
  emptyConfig,
  emptyParty,
  emptySession,
  FormationParty,
  indexIn,
  nextPhase,
  OnboardingSession,
  Phase,
  PHASES,
  prevPhase,
  resumePhase,
  screenLabel,
  snapToVisiblePhase,
  visiblePhases,
} from "./types";
import type { EntityView } from "@/lib/api/types";
import {
  emptyCompanyIntake,
  type CompanyIntakeForm,
} from "@/lib/formation/companyIntake";
import { useCompanyQuery, usePublicConfigQuery } from "@/lib/api/hooks";
import { PAYMENT_NO_LONGER_REQUIRED } from "@/lib/formation/payment";
import {
  buildPersistedOnboarding,
  clearOnboardingStorage,
  isOnboardingComplete,
  ONBOARDING_STORAGE_KEY,
  readPersistedOnboarding,
  type PersistedOnboarding,
} from "@/lib/onboarding/storage";
import { WelcomeStep } from "./steps/WelcomeStep";
import { GuardianStep } from "./steps/GuardianStep";
import { LegalBodyStep } from "./steps/LegalBodyStep";
import { PaymentStep } from "./steps/PaymentStep";
import { CustodyStep } from "./steps/CustodyStep";
import { ConfigureStep } from "./steps/ConfigureStep";
import { AgreementStep } from "./steps/AgreementStep";
import { DeployStep } from "./steps/DeployStep";
import { FundStep } from "./steps/FundStep";
import { Stepper } from "./Stepper";
import { Wordmark } from "../landing/Wordmark";
import { Button, cx } from "./primitives";
import { AuthProvider } from "./AuthProvider";
import { Web3Provider } from "../providers/Web3Provider";

type Persisted = PersistedOnboarding;

function phaseIndex(phase: Phase): number {
  return PHASES.findIndex((p) => p.id === phase);
}

function OnboardingFlowInner({ initial }: { initial: Persisted | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const wantsNewAgent = searchParams.get("new") === "1";
  const [storedPhase, setPhase] = useState<Phase>(() => {
    if (wantsNewAgent) return "welcome";
    return initial?.phase && phaseIndex(initial.phase) > 0 ? initial.phase : "welcome";
  });
  const [config, setConfig] = useState<AgentConfig>(() =>
    wantsNewAgent ? emptyConfig() : initial?.config ? { ...emptyConfig(), ...initial.config } : emptyConfig(),
  );
  const [session, setSession] = useState<OnboardingSession>(() =>
    wantsNewAgent
      ? emptySession()
      : initial?.session
        ? { ...emptySession(), ...initial.session, guardianPasskey: null }
        : emptySession(),
  );
  const [done, setDone] = useState<Record<string, boolean>>(() =>
    wantsNewAgent ? {} : (initial?.done ?? {}),
  );
  const [resumed, setResumed] = useState(
    () => !wantsNewAgent && !!(initial?.phase && phaseIndex(initial.phase) > 0),
  );
  /**
   * This session was migrated from v2 and carried a PARTY HANDLE with no company (§7, A3).
   *
   * A one-time fact about the restore, held like `resumed` and spent the same way — `goTo` clears
   * it — because it corrects where a returning user LANDS, not where they may go. Without the
   * clearing, somebody on a deployment where formation is optional who answers the bounce by
   * clicking "Skip — no legal filing" would be bounced straight back to it, forever.
   */
  const [needsCompany, setNeedsCompany] = useState(
    () => !wantsNewAgent && initial?.resumeNeedsCompany === true,
  );
  /**
   * The PII slice (design §3, audit 16/L8).
   *
   * Deliberately its own piece of state, beside `config` rather than inside it: `config` is what
   * gets persisted and what becomes the AgentSpec, and a legal name that lived on it would follow
   * it into both. Nothing here is ever written to storage — the persistence allowlist does not
   * name a single field of it — and the flow clears it the moment the backend returns a handle.
   */
  const [party, setParty] = useState<FormationParty>(emptyParty);
  /**
   * The COMPANY's own intake — three name candidates, the purpose, the industry.
   *
   * Not personal data, and not persisted either. It is typed once and consumed by one call, and
   * from the moment `POST /companies` returns it lives on the server, where the Companies section
   * reads it. Keeping it beside `party` rather than on `config` is the same discipline the PII
   * slice follows: `config` is what gets persisted and what becomes the AgentSpec, and a company
   * name that lived on it would follow it into both.
   */
  const [intake, setIntake] = useState<CompanyIntakeForm>(emptyCompanyIntake);

  // Which phases this deployment HAS. Anything other than an explicit `true` hides the
  // legal-identity step: a backend that predates the field forms nothing, and a deployment we
  // could not ask must not be shown a step whose only endpoint would answer 503.
  const { data: publicConfig } = usePublicConfigQuery();
  const formationAvailable = publicConfig?.formationAvailable === true;
  const formationRequired = publicConfig?.formationRequired === true;
  // B1: the fee step, present only where the deployment charges. Anything other than an explicit
  // `true` hides it — a backend that predates the field does not charge, and a payment step whose
  // every endpoint would 404 is worse than no step.
  const paymentRequired = publicConfig?.formationPaymentRequired === true;
  // …and only once there is a COMPANY to owe it (finding B5). With formation optional a user can
  // skip the legal-body step, and a payment phase behind that skip has nothing to quote for and
  // no way out. The step appears the moment `POST /companies` returns a handle — which is the
  // moment the fee is actually owed.
  const phases = useMemo(
    () => visiblePhases(formationAvailable, paymentRequired, session.companyId !== null),
    [formationAvailable, paymentRequired, session.companyId],
  );

  /**
   * Past the legal-body step with no company handle → the wizard shows that step again.
   *
   * ONE pure function (`resumePhase`), because there are now two reasons and they are not the
   * same reason: the deployment REQUIRES a filing, or this session was migrated from v2 carrying
   * a party handle that A3's onboard door refuses. See `resumePhase` for both, and for why the
   * second is spent by the first deliberate navigation.
   *
   * DERIVED during render rather than corrected by an effect — an effect that called `goTo` would
   * paint the wrong screen first and cascade a second render to fix it.
   */
  /**
   * The company's state, for the one correction that needs it (finding B6).
   *
   * Fetched ONLY in the situation that reads it — a session parked on the fee step of a
   * deployment that has stopped charging — because `session.company` is in-memory and is exactly
   * what a resumed session does not have. Everywhere else this is a request nobody needs.
   */
  const strandedOnFee = storedPhase === "payment" && indexIn(phases, "payment") < 0;
  const { data: fetchedCompany } = useCompanyQuery(session.companyId, {
    enabled: strandedOnFee && !session.company,
  });
  const companyState = session.company?.state ?? fetchedCompany?.state ?? null;

  const requestedPhase: Phase = resumePhase({
    phases,
    storedPhase,
    // A box that reports `required` always reports `available` too (they are projections of one
    // dep). If one ever did not, this guard is what stops the correction from sending the wizard
    // to a phase that is not in the list and rendering nothing at all.
    formationAvailable,
    formationRequired,
    companyId: session.companyId,
    entityId: session.entityId,
    needsCompany,
    companyState,
  });

  /**
   * THE INVARIANT: the phase we render is always a member of `phases`.
   *
   * `phases` is the list the header counter and the Stepper rail index into, and `storedPhase`
   * comes from localStorage — written on a visit when the list may have been longer. Restore a
   * session parked on `legal-identity` while `GET /config` is still in flight (formation unknown →
   * the step is hidden), or after `/config` failed, or on a deployment that turned formation off
   * between visits, and `indexIn` returns -1. Nothing throws: the header says "Step 0 of 7", the
   * rail highlights nothing, and the wizard reports a position that is wrong by one screen while
   * looking entirely healthy.
   *
   * Snapping is DERIVED here rather than corrected by an effect, for the same reason the bounce
   * above is: an effect would paint the phantom step for a frame first. And it composes with that
   * bounce rather than replacing it — if the environment resolves and `legal-identity` becomes
   * visible and required again, `storedPhase` is untouched and the user lands back on it.
   */
  const phase = snapToVisiblePhase(phases, requestedPhase);
  // …and if that correction is the B6 one, the legal-body step says why rather than appearing for
  // no reason a user could name.
  const legalBodyNotice =
    strandedOnFee && requestedPhase === "legal-body" ? PAYMENT_NO_LONGER_REQUIRED : undefined;

  const goTo = useCallback((next: Phase) => {
    setPhase(next);
    setResumed(false);
    // The v2 correction is spent by the first deliberate move — see `resumePhase`.
    setNeedsCompany(false);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const startOver = useCallback(() => {
    clearOnboardingStorage();
    setConfig(emptyConfig());
    setSession(emptySession());
    setParty(emptyParty());
    setIntake(emptyCompanyIntake());
    setDone({});
    setResumed(false);
    goTo("welcome");
  }, [goTo]);

  // ?new=1 → fresh wizard for another agent (keep wallet session).
  useEffect(() => {
    if (!wantsNewAgent) return;
    clearOnboardingStorage();
    router.replace("/onboarding");
  }, [wantsNewAgent, router]);

  // Completed wizard in storage → send to that agent's dashboard, not a stale fund step.
  useEffect(() => {
    if (wantsNewAgent || !initial) return;
    if (!isOnboardingComplete(initial)) return;
    const id = initial.session.entityId ?? initial.session.entity?.id;
    if (id) router.replace(`/agents/${encodeURIComponent(id)}`);
  }, [initial, wantsNewAgent, router]);

  const handleEntityUpdate = useCallback((entity: EntityView) => {
    setSession((s) => ({ ...s, entity }));
  }, []);

  useEffect(() => {
    if (phase === "dashboard") {
      const id = session.entityId ?? session.entity?.id;
      if (id) router.replace(`/agents/${encodeURIComponent(id)}`);
    }
  }, [phase, session.entityId, session.entity?.id, router]);

  useEffect(() => {
    // An ALLOWLIST, not a spread with one field nulled (audit 16/L8): the wizard now holds
    // personal data, and a denylist fails open on the next field somebody forgets.
    const data: Persisted = buildPersistedOnboarding({ phase, config, done, session });
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage full / disabled */
    }
  }, [phase, config, done, session]);

  const completePhase = useCallback(
    (current: Phase, next: Phase) => {
      setDone((d) => ({ ...d, [current]: true }));
      goTo(next);
    },
    [goTo],
  );

  const idx = indexIn(phases, phase);

  const finishOnboarding = useCallback(() => {
    const id = session.entityId ?? session.entity?.id;
    clearOnboardingStorage();
    if (id) {
      router.push(`/agents/${encodeURIComponent(id)}`);
      return;
    }
    goTo("fund");
  }, [session.entityId, session.entity?.id, router, goTo]);

  return (
    <div className="min-h-screen bg-paper font-mono text-ink">
      <FlowBackground />

      <header className="sticky top-0 z-40">
        <div className="absolute inset-0 -z-10 border-b hairline bg-paper/80 backdrop-blur-md" />
        <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between px-5 lg:px-8">
          <div className="flex items-center gap-4">
            <Wordmark />
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-[12px] text-muted-2 sm:inline">
              Step {idx + 1} of {phases.length - 1}
            </span>
            <Link
              href="/"
              className="rounded-full px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
            >
              Exit
            </Link>
            {phase !== "welcome" && (
              <button
                type="button"
                onClick={startOver}
                className="rounded-full border hairline-strong px-3 py-1.5 text-[12px] text-muted-2 transition-colors hover:bg-paper-2 hover:text-ink"
              >
                Start over
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1180px] grid-cols-1 gap-10 px-5 pb-24 pt-10 lg:grid-cols-[230px_1fr] lg:gap-14 lg:px-8 lg:pt-14">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <Stepper
            phases={phases}
            current={phase}
            done={done}
            onJump={(p) => {
              if (p === "dashboard") return;
              if (done[p] || indexIn(phases, p) < idx) goTo(p);
            }}
          />
        </div>

        <div className="min-w-0">
          {resumed && (
            <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/[0.06] px-4 py-2.5 text-[12.5px] text-accent-soft">
              <span>Welcome back — we picked up your onboarding where you left off.</span>
              <button
                onClick={startOver}
                className="shrink-0 text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
              >
                Start over
              </button>
            </div>
          )}

          <StepFrame phase={phase}>
            {phase === "welcome" && (
              <WelcomeStep
                guardianPasskey={session.guardianPasskey}
                onPasskey={(guardianPasskey) =>
                  setSession((s) => ({ ...s, guardianPasskey }))
                }
                onComplete={() => completePhase("welcome", "guardian")}
              />
            )}
            {phase === "guardian" && (
              <GuardianStep
                onBack={() => goTo("welcome")}
                onComplete={() =>
                  // The step AFTER guardian is deployment-dependent: legal-identity where the box
                  // can form entities, custody where it can't. Asked of the VISIBLE list rather
                  // than re-derived from `formationAvailable`, so there is one answer to it.
                  completePhase("guardian", nextPhase(phases, "guardian"))
                }
              />
            )}
            {phase === "legal-body" && (
              <LegalBodyStep
                eyebrow={screenLabel(phases, "legal-body")}
                party={party}
                onParty={setParty}
                intake={intake}
                onIntake={setIntake}
                companyId={session.companyId}
                company={session.company}
                notice={legalBodyNotice}
                onCompany={(companyId, company) => {
                  // The ROW travels with the handle when we have one (the attach branch picked
                  // it out of a list); a freshly created company has none, and the screens after
                  // this one fetch it. It is in-memory state only — never in the allowlist.
                  setSession((s) => ({ ...s, companyId, company: company ?? null }));
                  // Belt and braces on top of the allowlist: once the backend holds the identity
                  // and has issued a company handle, there is no reason for this browser to keep
                  // a copy of either in memory. (The SSN never reaches this component at all —
                  // it lives in the step's own state and is cleared there.)
                  setParty(emptyParty());
                  setIntake(emptyCompanyIntake());
                  // The NEXT phase is asked of the visible list, never named: `payment` sits
                  // between this step and custody on a deployment that charges, and re-deriving
                  // it from `paymentRequired` here would be a second answer to a question
                  // `visiblePhases` already holds.
                  completePhase("legal-body", nextPhase(phases, "legal-body"));
                }}
                onClear={() => setSession((s) => ({ ...s, companyId: null, company: null }))}
                onBack={() => goTo("guardian")}
                onComplete={() => completePhase("legal-body", nextPhase(phases, "legal-body"))}
              />
            )}
            {phase === "payment" && (
              <PaymentStep
                eyebrow={screenLabel(phases, "payment")}
                companyId={session.companyId}
                onBack={() => goTo("legal-body")}
                onComplete={() => completePhase("payment", "custody")}
              />
            )}
            {phase === "custody" && (
              <CustodyStep
                eyebrow={screenLabel(phases, "custody")}
                config={config}
                onChange={setConfig}
                onBack={() => goTo(prevPhase(phases, "custody"))}
                onComplete={() => completePhase("custody", "configure")}
              />
            )}
            {phase === "configure" && (
              <ConfigureStep
                eyebrow={screenLabel(phases, "configure")}
                config={config}
                onChange={setConfig}
                onBack={() => goTo("custody")}
                onComplete={() => completePhase("configure", "agreement")}
              />
            )}
            {phase === "agreement" && (
              <AgreementStep
                eyebrow={screenLabel(phases, "agreement")}
                config={config}
                guardianPasskey={session.guardianPasskey}
                idempotencyKey={session.idempotencyKey}
                companyId={session.companyId}
                company={session.company}
                onBack={() => goTo("configure")}
                onSubmitted={(entityId, idempotencyKey) => {
                  setSession((s) => ({
                    ...s,
                    entityId,
                    idempotencyKey,
                  }));
                  completePhase("agreement", "deploy");
                }}
              />
            )}
            {phase === "deploy" && (
              <DeployStep
                eyebrow={screenLabel(phases, "deploy")}
                entityId={session.entityId}
                config={config}
                onEntity={handleEntityUpdate}
                onComplete={() => completePhase("deploy", "fund")}
              />
            )}
            {phase === "fund" && (
              <FundStep
                eyebrow={screenLabel(phases, "fund")}
                config={config}
                entityId={session.entityId}
                entity={session.entity}
                onEntity={handleEntityUpdate}
                onComplete={finishOnboarding}
              />
            )}
            {phase === "dashboard" && (
              <div className="py-8 text-center text-[13px] text-muted">
                Redirecting to your agent dashboard…
              </div>
            )}
          </StepFrame>
        </div>
      </main>
    </div>
  );
}

function OnboardingFlowHydrated() {
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const initial = useSyncExternalStore(
    () => () => {},
    readPersistedOnboarding,
    () => null,
  );

  if (!hydrated) {
    return <div className="min-h-screen bg-paper" aria-hidden />;
  }

  return <OnboardingFlowInner initial={initial} />;
}

export function OnboardingFlow() {
  return (
    <Web3Provider>
      <AuthProvider>
        <Suspense fallback={<div className="min-h-screen bg-paper" aria-hidden />}>
          <OnboardingFlowHydrated />
        </Suspense>
      </AuthProvider>
    </Web3Provider>
  );
}

function StepFrame({
  phase,
  children,
}: {
  phase: Phase;
  children: ReactNode;
}) {
  return (
    <div key={phase} className="anim-line" style={{ animationDuration: "0.4s" }}>
      {children}
    </div>
  );
}

function FlowBackground() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 hero-mesh-dark opacity-70"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-paper-grain opacity-60"
      />
    </>
  );
}

export function StepNav({
  onBack,
  backLabel = "Back",
  children,
  className,
}: {
  onBack?: () => void;
  backLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "mt-10 flex flex-wrap items-center gap-3 border-t hairline pt-6",
        className,
      )}
    >
      {onBack && (
        <Button variant="subtle" onClick={onBack}>
          ← {backLabel}
        </Button>
      )}
      <div className="ml-auto flex items-center gap-3">{children}</div>
    </div>
  );
}
