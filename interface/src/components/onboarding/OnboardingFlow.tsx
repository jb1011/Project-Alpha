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
  screenLabel,
  visiblePhases,
} from "./types";
import type { EntityView } from "@/lib/api/types";
import { usePublicConfigQuery } from "@/lib/api/hooks";
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
import { LegalIdentityStep } from "./steps/LegalIdentityStep";
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
   * The PII slice (design §3, audit 16/L8).
   *
   * Deliberately its own piece of state, beside `config` rather than inside it: `config` is what
   * gets persisted and what becomes the AgentSpec, and a legal name that lived on it would follow
   * it into both. Nothing here is ever written to storage — the persistence allowlist does not
   * name a single field of it — and the flow clears it the moment the backend returns a handle.
   */
  const [party, setParty] = useState<FormationParty>(emptyParty);

  // Which phases this deployment HAS. Anything other than an explicit `true` hides the
  // legal-identity step: a backend that predates the field forms nothing, and a deployment we
  // could not ask must not be shown a step whose only endpoint would answer 503.
  const { data: publicConfig } = usePublicConfigQuery();
  const formationAvailable = publicConfig?.formationAvailable === true;
  const formationRequired = publicConfig?.formationRequired === true;
  const phases = useMemo(() => visiblePhases(formationAvailable), [formationAvailable]);

  /**
   * Past the legal-identity step with no party handle, on a deployment that REQUIRES one → the
   * wizard shows that step again.
   *
   * The passkey precedent: a restored session that lost the credential a step produces re-does
   * that step, explicitly, rather than carrying the user to a submit that will be refused. It
   * corrects a race too (a fast click while `GET /config` is still in flight), which is strictly
   * safer than a restore-only check.
   *
   * DERIVED during render rather than corrected by an effect — an effect that called `goTo` would
   * paint the wrong screen first and cascade a second render to fix it.
   *
   * NEVER once the entity exists: by `deploy` the handle has already been consumed by /onboard,
   * and sending the user back to collect another one would be nonsense.
   */
  const phase: Phase =
    formationRequired &&
    // A box that reports `required` always reports `available` too (they are projections of one
    // dep). If one ever did not, this guard is what stops the correction from sending the wizard
    // to a phase that is not in the list and rendering nothing at all.
    formationAvailable &&
    !session.partyId &&
    !session.entityId &&
    storedPhase !== "dashboard" &&
    indexIn(phases, storedPhase) > indexIn(phases, "legal-identity")
      ? "legal-identity"
      : storedPhase;

  const goTo = useCallback((next: Phase) => {
    setPhase(next);
    setResumed(false);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const startOver = useCallback(() => {
    clearOnboardingStorage();
    setConfig(emptyConfig());
    setSession(emptySession());
    setParty(emptyParty());
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
            <span className="hidden items-center gap-1.5 rounded-full border hairline-strong bg-paper-2/60 px-2.5 py-1 text-[10.5px] uppercase tracking-[0.16em] text-muted-2 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Live on Arc · Mainnet coming soon
            </span>
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
            {phase === "legal-identity" && (
              <LegalIdentityStep
                eyebrow={screenLabel(phases, "legal-identity")}
                party={party}
                onParty={setParty}
                partyId={session.partyId}
                synthetic={session.partySynthetic}
                onCreated={(partyId, synthetic) => {
                  setSession((s) => ({ ...s, partyId, partySynthetic: synthetic }));
                  // Belt and braces on top of the allowlist: once the backend holds the identity
                  // and has issued a handle, there is no reason for this browser to keep a copy
                  // of it in memory either.
                  setParty(emptyParty());
                  completePhase("legal-identity", "custody");
                }}
                onClear={() => setSession((s) => ({ ...s, partyId: null, partySynthetic: false }))}
                onBack={() => goTo("guardian")}
                onComplete={() => completePhase("legal-identity", "custody")}
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
                partyId={session.partyId}
                partySynthetic={session.partySynthetic}
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
