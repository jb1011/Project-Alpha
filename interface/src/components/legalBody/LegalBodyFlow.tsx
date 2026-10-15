"use client";

import { Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useBytecode } from "wagmi";
import { Wordmark } from "@/components/landing/Wordmark";
import { AuthProvider, useAuth } from "@/components/onboarding/AuthProvider";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Stepper } from "@/components/onboarding/Stepper";
import { Button, Callout, Card, Spinner, StepHeader } from "@/components/onboarding/primitives";
import { PaymentStep } from "@/components/onboarding/steps/PaymentStep";
import { Web3Provider } from "@/components/providers/Web3Provider";
import {
  useCompaniesQuery,
  useCompanyQuery,
  usePublicConfigQuery,
  useWorldIdMeQuery,
} from "@/lib/api/hooks";
import {
  useLegalBodyConfig,
  useLegalBodyOrderQuery,
  useLegalBodyOrdersQuery,
} from "@/lib/api/legalBodyHooks";
import type {
  Address,
  AuthSession,
  CompanyView,
  LegalBodyConfig,
  LegalBodyOrderView,
} from "@/lib/api/types";
import { arcTestnet } from "@/lib/chain";
import {
  agreementReadAfterJump,
  sentenceOnArrival,
  withAgreementRead,
  type CarriedSentence,
} from "@/lib/legalBody/agreement";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import {
  deriveLegalBodyPhase,
  selectLegalBodyThread,
  type LegalBodyDerivation,
  type LegalBodyThreadRef,
} from "@/lib/legalBody/flow";
import {
  anySignInRequired,
  bannerLines,
  declarationsClosed,
  isSignInRequired,
  legalBodyDoor,
  legalBodyGate,
  signInStepState,
  type CodeRead,
  type GateView,
  type LegalBodyDoor,
} from "@/lib/legalBody/gates";
import { closedSentence, noticeSentence } from "@/lib/legalBody/notice";
import {
  canJumpTo,
  phaseLabel,
  railCurrentOf,
  railDone,
  railPhaseOf,
  visibleLegalBodyPhases,
  type LegalBodyRailPhase,
} from "@/lib/legalBody/phases";
import {
  chooserRows,
  draftChoices,
  flowNowMs,
  jumpMemoryPatch,
  memoryAfterThread,
  mergeLegalBodyMemory,
  patchEndsIntent,
  threadRefsOf,
  threadWithIntent,
  type LegalBodyIntent,
} from "@/lib/legalBody/resume";
import {
  readLegalBodyMemory,
  writeLegalBodyMemory,
  type LegalBodyMemory,
} from "@/lib/legalBody/storage";
import { worldIdGateState, worldIdMeStatus } from "@/lib/legalBody/worldIdGate";
import { AgreementStep } from "./AgreementStep";
import { ClosedNotice } from "./ClosedNotice";
import { CompanyStep } from "./CompanyStep";
import { HumanStep } from "./HumanStep";
import { IdentityStep } from "./IdentityStep";
import { SandboxBanner } from "./SandboxBanner";
import { SignInStep } from "./SignInStep";
import { ThreadChooser } from "./ThreadChooser";

/**
 * The legal-body flow at `/legal-body`: a person gives an agent they already run, on an identity
 * they already hold, a legal body.
 *
 * The server decides where a person is, on every visit. After the deployment's door and the two
 * gates (a signed-in wallet that can be the guardian, a person the real-human check accepts), the
 * tenant's companies and orders and this browser's memory pick the thread
 * (`selectLegalBodyThread`), and the thread's company and order decide the phase
 * (`deriveLegalBodyPhase`). Every decision is a pure function in `src/lib/legalBody`; this file
 * reads, calls them, and renders their answers.
 *
 * Nothing here writes to the server on its own: every write is a click's. The only effects are the
 * memory's write once a thread is on screen, and the scroll to the top when the screen changes.
 *
 * Two facts live in this visit's memory only, never in the store: that a draft's agreement was
 * read (so the draft moves on to the identity step, and a reload shows the agreement again), and
 * a door's sentence carried back to the step it sends the person to.
 */

type AvailableConfig = Extract<LegalBodyConfig, { available: true }>;
type MemoryPatch = Partial<Omit<LegalBodyMemory, "tenant">>;

/** What the shell gives a step after the gates: the thread's facts, and the three ways a step
 *  reaches back into the shell (the memory, a new start, a refusal that means sign in). */
export type LegalBodyStepKit = {
  config: AvailableConfig;
  tenant: Address;
  derivation: LegalBodyDerivation;
  companyId: string | null;
  orderId: string | null;
  company: CompanyView | null;
  order: LegalBodyOrderView | null;
  orders: LegalBodyOrderView[];
  /** A click's change to the memory (the owner choice, an identity, a new company or order). */
  remember: (patch: MemoryPatch) => void;
  /** A new order on this company, or a new declaration. */
  startAnother: (kind: "new_order" | "new_company") => void;
  /** For a failed request: true when it meant "sign in" and the flow went there. */
  routeSignIn: (e: unknown) => boolean;
};

const F = LEGAL_BODY_COPY.frame;
const T = LEGAL_BODY_COPY.thread;
const NO_CODE: CodeRead = { status: "pending", data: undefined };
const NO_COMPANIES: CompanyView[] = [];
const NO_ORDERS: LegalBodyOrderView[] = [];

export function LegalBodyFlow() {
  return (
    <Web3Provider>
      <AuthProvider>
        <Suspense fallback={<Blank />}>
          <LegalBodyHydrated />
        </Suspense>
      </AuthProvider>
    </Web3Provider>
  );
}

const noSubscription = () => () => {};

/** The server renders the blank: the session and the memory live in this browser only. */
function LegalBodyHydrated() {
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!hydrated) return <Blank />;
  return <LegalBodyFrame />;
}

function LegalBodyFrame() {
  const door = legalBodyDoor(useLegalBodyConfig());
  const { refetch } = usePublicConfigQuery();
  return (
    <div className="min-h-screen bg-paper font-mono text-ink">
      <FlowBackground />
      <FlowHeader />
      {door.kind === "open" ? (
        <LegalBodyOpen config={door.config} />
      ) : (
        <DoorScreen door={door} onRetry={() => void refetch()} />
      )}
    </div>
  );
}

/** The flow before a session: the sign-in step alone. Once signed in, the session's own screen,
 *  remounted for each wallet so one wallet's memory never serves another. */
function LegalBodyOpen({ config }: { config: AvailableConfig }) {
  const { session } = useAuth();
  // Whether the person acted on the sign-in card here: if so, the sign-in step stays on screen
  // after the session appears, with its Continue.
  const [engaged, setEngaged] = useState(false);

  if (!session) {
    return (
      <FlowLayout config={config} current="signin" onJump={() => {}}>
        <SignInStep
          code={NO_CODE}
          expired={false}
          onEngage={() => setEngaged(true)}
          onContinue={() => {}}
          onRetryCheck={() => {}}
        />
      </FlowLayout>
    );
  }
  return (
    <LegalBodySession
      key={session.address.toLowerCase()}
      config={config}
      session={session}
      engaged={engaged}
    />
  );
}

function LegalBodySession({
  config,
  session,
  engaged,
}: {
  config: AvailableConfig;
  session: AuthSession;
  engaged: boolean;
}) {
  const tenant = session.address;
  const token = session.token;

  const [view, setView] = useState<GateView>(engaged ? "signin" : null);
  // The token a step's request was refused under: that session is over, whatever it still says.
  const [refusedToken, setRefusedToken] = useState<string | null>(null);
  // This visit's snapshot of the memory. The store is written once a thread is on screen; the
  // snapshot changes only on a click, so a closed order stays on screen for this visit.
  const [memory, setMemory] = useState<LegalBodyMemory | null>(() => readLegalBodyMemory(tenant));
  const [intent, setIntent] = useState<LegalBodyIntent | null>(null);
  const [mountedAt] = useState(() => Date.now());
  // The draft whose agreement was read on this visit: in memory only, so a reload shows it again.
  const [agreementReadFor, setAgreementReadFor] = useState<string | null>(null);
  // A door's sentence for the step it sends the person back to, until the next click that moves
  // the thread.
  const [carried, setCarried] = useState<CarriedSentence | null>(null);

  // Reads only.
  const code = useBytecode({ address: tenant, chainId: arcTestnet.id });
  const meQuery = useWorldIdMeQuery();
  const companiesQuery = useCompaniesQuery();
  const ordersQuery = useLegalBodyOrdersQuery();

  const companies = companiesQuery.data?.companies ?? NO_COMPANIES;
  const orders = ordersQuery.data?.orders ?? NO_ORDERS;
  const listsRead = companiesQuery.data !== undefined && ordersQuery.data !== undefined;
  const listNow = flowNowMs(mountedAt, [companiesQuery.dataUpdatedAt, ordersQuery.dataUpdatedAt]);

  const thread = listsRead
    ? threadWithIntent(
        selectLegalBodyThread({ companies, orders, stored: memory, nowMs: listNow }),
        intent,
        { companies, orders, nowMs: listNow, where: config },
      )
    : null;
  const refs = thread ? threadRefsOf(thread) : null;

  const companyQuery = useCompanyQuery(refs?.companyId);
  const orderQuery = useLegalBodyOrderQuery(refs?.orderId, { pollWhileReserved: true });

  const nowMs = flowNowMs(listNow, [companyQuery.dataUpdatedAt, orderQuery.dataUpdatedAt]);
  const company =
    companyQuery.data ?? companies.find((c) => c.companyId === refs?.companyId) ?? null;
  const order = orderQuery.data ?? orders.find((o) => o.id === refs?.orderId) ?? null;
  const derivation: LegalBodyDerivation | null =
    thread && thread.kind !== "chooser"
      ? withAgreementRead(
          deriveLegalBodyPhase({
            config,
            sessionAddress: tenant,
            nowMs,
            company,
            documents:
              config.environment === "production" ? (companyQuery.data?.documents ?? null) : null,
            orders,
            order,
            ...draftChoices(memory, thread),
          }),
          { order, readFor: agreementReadFor },
        )
      : null;

  const expired =
    refusedToken === token ||
    anySignInRequired([
      meQuery.error,
      companiesQuery.error,
      ordersQuery.error,
      companyQuery.error,
      orderQuery.error,
    ]);
  const codeRead: CodeRead = { status: code.status, data: code.data };
  const signIn = signInStepState({ hasSession: true, attempt: null, expired, code: codeRead });
  const me = meQuery.data ?? null;
  const human = worldIdGateState({
    me,
    meStatus: worldIdMeStatus(me, meQuery.error),
    requireRealHuman: true,
    forceRequired: true,
  });
  const gate = legalBodyGate({ signIn, human, view });

  const toStore = gate === "flow" && thread ? memoryAfterThread({ tenant, stored: memory, thread }) : null;
  useStoredThread(toStore);

  const screen =
    gate !== "flow"
      ? gate
      : derivation
        ? `${derivation.phase}:${derivation.companyStep ?? ""}`
        : (thread?.kind ?? "loading");
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [screen]);

  /** A click's change to the memory: written to the store and to this visit's snapshot. */
  function remember(patch: MemoryPatch) {
    const next = mergeLegalBodyMemory(tenant, toStore ?? memory, patch);
    writeLegalBodyMemory(next);
    setMemory(next);
    setCarried(null);
    if (patchEndsIntent(patch)) setIntent(null);
  }

  /** Continue on the agreement: this draft's agreement was read. Nothing is recorded. */
  function agreementRead(orderId: string) {
    setAgreementReadFor(orderId);
    setCarried(null);
  }

  /** The order door refused the company: read it again, and say the door's sentence on the
   *  company step if the derivation goes back there. */
  function backToCompany(sentence: string) {
    setCarried({ to: "company", sentence });
    if (refs?.companyId) void companyQuery.refetch();
    void companiesQuery.refetch();
  }

  /** For a step's failed request: a refusal that means "sign in" goes to the sign-in step, and its
   *  message is never shown. True when it did. */
  function routeSignIn(e: unknown): boolean {
    if (!isSignInRequired(e)) return false;
    setRefusedToken(token);
    setView("signin");
    return true;
  }

  const phases = visibleLegalBodyPhases(config);
  const current = railCurrentOf(gate, derivation);

  function jump(target: LegalBodyRailPhase) {
    if (!canJumpTo(phases, current, target)) return;
    setCarried(null);
    setAgreementReadFor((readFor) => agreementReadAfterJump(target, readFor));
    if (target === "signin" || target === "human") {
      setView(target);
      return;
    }
    // Back into the thread: only the local inputs change, then the derivation decides again.
    const patch = jumpMemoryPatch(target);
    if (patch) remember(patch);
    setView(null);
  }

  function back() {
    const at = phases.findIndex((p) => p.id === current);
    if (at > 0) jump(phases[at - 1].id);
  }

  function startAnother(kind: "new_order" | "new_company") {
    if (kind === "new_order" && refs?.companyId)
      setIntent({
        kind: "another-agent",
        companyId: refs.companyId,
        known: orders.map((o) => o.id),
      });
    if (kind === "new_company")
      setIntent({ kind: "another-company", known: companies.map((c) => c.companyId) });
    // A closed order shown here is done with: this visit forgets it too.
    remember({});
  }

  const arrival = sentenceOnArrival(carried, current);

  function choose(ref: LegalBodyThreadRef) {
    remember({ companyId: ref.companyId, orderId: ref.kind === "order" ? ref.orderId : null });
  }

  function body(): ReactNode {
    if (gate === "signin")
      return (
        <SignInStep
          code={codeRead}
          expired={expired}
          onEngage={() => setView("signin")}
          onContinue={() => setView(null)}
          onRetryCheck={() => void code.refetch()}
        />
      );
    if (gate === "human")
      return (
        <HumanStep
          onEngage={() => setView("human")}
          onContinue={() => setView(null)}
          onBack={() => setView("signin")}
        />
      );

    if (!thread) {
      const failed = [companiesQuery.error, ordersQuery.error].some((e) => e && !isSignInRequired(e));
      return failed ? (
        <ThreadUnreadable
          onRetry={() => {
            void companiesQuery.refetch();
            void ordersQuery.refetch();
          }}
        />
      ) : (
        <ThreadLoading />
      );
    }
    if (thread.kind === "chooser")
      return <ThreadChooser rows={chooserRows(thread.threads, companies, orders)} onChoose={choose} />;
    if (!derivation) return null;

    const kit: LegalBodyStepKit = {
      config,
      tenant,
      derivation,
      companyId: refs?.companyId ?? null,
      orderId: refs?.orderId ?? null,
      company,
      order,
      orders,
      remember,
      startAnother,
      routeSignIn,
    };
    const label = LEGAL_BODY_COPY.rail.labels;
    switch (derivation.phase) {
      case "closed":
        return (
          <ClosedNotice
            sentence={closedSentence(derivation.notice, config.environment)}
            onWayOut={startAnother}
          />
        );
      case "payment":
        return (
          <PaymentStep
            eyebrow={label.payment}
            companyId={kit.companyId}
            onBack={back}
            onComplete={() => {
              void companyQuery.refetch();
              void companiesQuery.refetch();
            }}
          />
        );
      case "company":
        return declarationsClosed(config, derivation) ? (
          <StepPlaceholder kit={kit} sentence={LEGAL_BODY_COPY.company.declarationsOff} />
        ) : (
          // One form per thread: a new declaration never inherits another thread's typing.
          <CompanyStep key={kit.companyId ?? "new"} kit={kit} />
        );
      case "agreement":
        return (
          // One step per company: a placed order is held across the moment the list names it.
          <AgreementStep
            key={kit.companyId ?? "none"}
            kit={kit}
            onRead={agreementRead}
            onBackToCompany={backToCompany}
          />
        );
      case "identity":
        // One step per order: a new order never inherits another's typing or reads.
        return <IdentityStep key={kit.orderId ?? "none"} kit={kit} />;
      default:
        return <StepPlaceholder kit={kit} />;
    }
  }

  return (
    <FlowLayout config={config} current={current} onJump={jump}>
      {arrival && (
        <Callout tone="warn" className="mb-6">
          {arrival}
        </Callout>
      )}
      {body()}
    </FlowLayout>
  );
}

/**
 * The memory's write, once a thread is on screen: the one effect besides the scroll. It writes
 * only what `memoryAfterThread` says has changed, from the values themselves, so a re-render with
 * the same thread writes nothing.
 */
function useStoredThread(next: LegalBodyMemory | null) {
  const tenant = next?.tenant ?? null;
  const companyId = next?.companyId ?? null;
  const orderId = next?.orderId ?? null;
  const ownerChoice = next?.ownerChoice ?? null;
  const agentId = next?.agentId ?? null;
  useEffect(() => {
    if (tenant === null) return;
    writeLegalBodyMemory({ tenant, companyId, orderId, ownerChoice, agentId });
  }, [tenant, companyId, orderId, ownerChoice, agentId]);
}

/* ── The frame ─────────────────────────────────────────────────────────────────────────────── */

function FlowLayout({
  config,
  current,
  onJump,
  children,
}: {
  config: AvailableConfig;
  current: LegalBodyRailPhase;
  onJump: (phase: LegalBodyRailPhase) => void;
  children: ReactNode;
}) {
  const phases = visibleLegalBodyPhases(config);
  return (
    <main className="mx-auto grid max-w-[1180px] grid-cols-1 gap-10 px-5 pb-24 pt-10 lg:grid-cols-[230px_1fr] lg:gap-14 lg:px-8 lg:pt-14">
      <div className="lg:sticky lg:top-24 lg:self-start">
        <Stepper<LegalBodyRailPhase>
          phases={phases}
          current={current}
          done={railDone(phases, current)}
          onJump={onJump}
          heading={LEGAL_BODY_COPY.rail.heading}
          footer={LEGAL_BODY_COPY.rail.footer}
        />
      </div>
      <div className="min-w-0">
        <SandboxBanner lines={bannerLines(config)} />
        <div key={current} className="anim-line" style={{ animationDuration: "0.4s" }}>
          {children}
        </div>
      </div>
    </main>
  );
}

function DoorScreen({
  door,
  onRetry,
}: {
  door: Exclude<LegalBodyDoor, { kind: "open" }>;
  onRetry: () => void;
}) {
  if (door.kind === "loading") return <main className="min-h-[60vh]" aria-busy />;
  return (
    <main className="mx-auto max-w-[720px] px-5 pb-24 pt-16 lg:px-8">
      <Card className="p-6">
        <p className="text-[14px] leading-[1.6] text-ink">{door.sentence}</p>
      </Card>
      <StepNav>
        {door.kind === "error" ? (
          <Button onClick={onRetry}>{LEGAL_BODY_COPY.door.retry}</Button>
        ) : (
          <Link
            href="/"
            className="rounded-full border hairline-strong px-4 py-2 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
          >
            {LEGAL_BODY_COPY.door.home}
          </Link>
        )}
      </StepNav>
    </main>
  );
}

function ThreadLoading() {
  return (
    <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
      <Spinner className="h-3.5 w-3.5" /> {T.loading}
    </div>
  );
}

function ThreadUnreadable({ onRetry }: { onRetry: () => void }) {
  return (
    <div>
      <Callout tone="warn">{T.unreadable}</Callout>
      <StepNav>
        <Button onClick={onRetry}>{T.retry}</Button>
      </StepNav>
    </div>
  );
}

/** A step this page does not render yet: its name, the derivation's notice, and one sentence. */
function StepPlaceholder({
  kit,
  sentence = T.placeholder,
}: {
  kit: LegalBodyStepKit;
  sentence?: string;
}) {
  const eyebrow = phaseLabel(railPhaseOf(kit.derivation));
  const notice = kit.derivation.notice
    ? noticeSentence(kit.derivation.notice, kit.config.environment)
    : null;
  return (
    <div>
      <StepHeader eyebrow={eyebrow} title={eyebrow} />
      {notice && (
        <Callout tone="warn" title={notice.title} className="mb-6">
          {notice.body}
        </Callout>
      )}
      <Card className="p-6">
        <p className="text-[13.5px] leading-[1.6] text-muted">{sentence}</p>
      </Card>
    </div>
  );
}

function FlowHeader() {
  return (
    <header className="sticky top-0 z-40">
      <div className="absolute inset-0 -z-10 border-b hairline bg-paper/80 backdrop-blur-md" />
      <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between px-5 lg:px-8">
        <Wordmark />
        <Link
          href="/"
          className="rounded-full px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
        >
          {F.exit}
        </Link>
      </div>
    </header>
  );
}

/** The wizard's background, so both flows look like one product. */
function FlowBackground() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 hero-mesh-dark opacity-70"
      />
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-paper-grain opacity-60" />
    </>
  );
}

function Blank() {
  return <div className="min-h-screen bg-paper" aria-hidden />;
}
