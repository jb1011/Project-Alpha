"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  AgentConfig,
  emptyConfig,
  emptySession,
  OnboardingSession,
  Phase,
  PHASES,
} from "./types";
import type { EntityView } from "@/lib/api/types";
import { WelcomeStep } from "./steps/WelcomeStep";
import { ConfigureStep } from "./steps/ConfigureStep";
import { AgreementStep } from "./steps/AgreementStep";
import { DeployStep } from "./steps/DeployStep";
import { FundStep } from "./steps/FundStep";
import { DashboardStep } from "./steps/DashboardStep";
import { Stepper } from "./Stepper";
import { Wordmark } from "../landing/Wordmark";
import { Button, cx } from "./primitives";
import { AuthProvider, useAuth } from "./AuthProvider";
import { Web3Provider } from "../providers/Web3Provider";

const STORAGE_KEY = "pa-onboarding-v2";

type Persisted = {
  phase: Phase;
  config: AgentConfig;
  done: Record<string, boolean>;
  session: OnboardingSession;
};

function phaseIndex(phase: Phase): number {
  return PHASES.findIndex((p) => p.id === phase);
}

let cachedOnboardingRaw: string | null | undefined;
let cachedOnboarding: Persisted | null = null;

function readPersistedOnboarding(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedOnboardingRaw) return cachedOnboarding;
    cachedOnboardingRaw = raw;
    if (!raw) {
      cachedOnboarding = null;
      return null;
    }
    cachedOnboarding = JSON.parse(raw) as Persisted;
    return cachedOnboarding;
  } catch {
    cachedOnboardingRaw = null;
    cachedOnboarding = null;
    return null;
  }
}

function OnboardingFlowInner({ initial }: { initial: Persisted | null }) {
  const { logout } = useAuth();
  const [phase, setPhase] = useState<Phase>(() =>
    initial?.phase && phaseIndex(initial.phase) > 0 ? initial.phase : "welcome",
  );
  const [config, setConfig] = useState<AgentConfig>(() =>
    initial?.config ? { ...emptyConfig(), ...initial.config } : emptyConfig(),
  );
  const [session, setSession] = useState<OnboardingSession>(() =>
    initial?.session
      ? { ...emptySession(), ...initial.session, guardianPasskey: null }
      : emptySession(),
  );
  const [done, setDone] = useState<Record<string, boolean>>(() => initial?.done ?? {});
  const [resumed, setResumed] = useState(
    () => !!(initial?.phase && phaseIndex(initial.phase) > 0),
  );

  const handleEntityUpdate = useCallback((entity: EntityView) => {
    setSession((s) => ({ ...s, entity }));
  }, []);

  useEffect(() => {
    const data: Persisted = {
      phase,
      config,
      done,
      session: { ...session, guardianPasskey: null },
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage full / disabled */
    }
  }, [phase, config, done, session]);

  const goTo = useCallback((next: Phase) => {
    setPhase(next);
    setResumed(false);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const completePhase = useCallback(
    (current: Phase, next: Phase) => {
      setDone((d) => ({ ...d, [current]: true }));
      goTo(next);
    },
    [goTo],
  );

  const resetAll = useCallback(() => {
    logout();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setConfig(emptyConfig());
    setSession(emptySession());
    setDone({});
    goTo("welcome");
  }, [goTo, logout]);

  const idx = phaseIndex(phase);
  const isDashboard = phase === "dashboard";

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
              Arc testnet
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!isDashboard && (
              <span className="hidden text-[12px] text-muted-2 sm:inline">
                Step {idx + 1} of {PHASES.length}
              </span>
            )}
            <Link
              href="/"
              className="rounded-full px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
            >
              Exit
            </Link>
          </div>
        </div>
      </header>

      {isDashboard ? (
        <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-8 lg:px-8">
          <DashboardStep
            config={config}
            entity={session.entity}
            onRestart={resetAll}
          />
        </main>
      ) : (
        <main className="mx-auto grid max-w-[1180px] grid-cols-1 gap-10 px-5 pb-24 pt-10 lg:grid-cols-[230px_1fr] lg:gap-14 lg:px-8 lg:pt-14">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <Stepper
              current={phase}
              done={done}
              onJump={(p) => {
                if (done[p] || phaseIndex(p) < idx) goTo(p);
              }}
            />
          </div>

          <div className="min-w-0">
            {resumed && (
              <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/[0.06] px-4 py-2.5 text-[12.5px] text-accent-soft">
                <span>Welcome back — we picked up your onboarding where you left off.</span>
                <button
                  onClick={resetAll}
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
                  onComplete={() => completePhase("welcome", "configure")}
                />
              )}
              {phase === "configure" && (
                <ConfigureStep
                  config={config}
                  onChange={setConfig}
                  onBack={() => goTo("welcome")}
                  onComplete={() => completePhase("configure", "agreement")}
                />
              )}
              {phase === "agreement" && (
                <AgreementStep
                  config={config}
                  guardianPasskey={session.guardianPasskey}
                  idempotencyKey={session.idempotencyKey}
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
                  entityId={session.entityId}
                  onEntity={handleEntityUpdate}
                  onComplete={() => completePhase("deploy", "fund")}
                />
              )}
              {phase === "fund" && (
                <FundStep
                  config={config}
                  entityId={session.entityId}
                  entity={session.entity}
                  onEntity={handleEntityUpdate}
                  onComplete={() => completePhase("fund", "dashboard")}
                />
              )}
            </StepFrame>
          </div>
        </main>
      )}
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
        <OnboardingFlowHydrated />
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
  children: React.ReactNode;
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
