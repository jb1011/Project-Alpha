"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";
import {
  CREATE_COMPANY_CTA,
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEPS_HEADING,
} from "./copy";

const steps = [
  {
    title: "Wallet and passkey",
    body: "Sign in with your wallet, then create a guardian passkey. The passkey is your human approval. It becomes the vault root only if you choose keys under your passkey.",
    bullets: ["SIWE sign in", "WebAuthn / Face ID", "Guardian anchor"],
    glyph: <PasskeyGlyph />,
  },
  {
    title: "Accountable human",
    body: "Verify with World ID so a unique human stands behind the Wyoming DAO LLC. We store a nullifier, never your name, document, or face.",
    bullets: ["World ID proof", "One human per account", "Sybil resistant"],
    glyph: <WorldGlyph />,
  },
  {
    title: "Legal body",
    body: "Pick a company you already own or file a new Wyoming DAO LLC. The agent becomes the managing member. You stay the guardian.",
    bullets: ["Wyoming DAO LLC", "Existing or new filing", "Guardian member"],
    glyph: <LegalGlyph />,
  },
  {
    title: "Key custody",
    body: "Choose Novi managed (Circle MPC, gasless, recommended) or keys under your passkey in a Turnkey vault. The payment float is platform managed on both paths.",
    bullets: [
      "Novi managed default",
      "Keys under your passkey",
      "Guardian overrides",
    ],
    glyph: <CustodyGlyph />,
  },
  {
    title: "Define agent",
    body: "Set identity and spending rules: per transaction caps, period limits, recipient allowlists, and timelocks. Fill the form yourself or connect an MCP agent to draft it.",
    bullets: ["USDC spending caps", "Recipient allowlist", "MCP or manual"],
    glyph: <PolicyGlyph />,
  },
  {
    title: "Operating agreement",
    body: "A law to code translator turns your rules into a Wyoming DAO LLC operating agreement. A cryptographic fingerprint guarantees the legal document and on chain policy are identical.",
    bullets: ["Wyoming DAO LLC", "Law to code binding", "Policy fingerprint"],
    glyph: <AgreementGlyph />,
  },
  {
    title: "Deploy on chain",
    body: "Automated steps provision the agent key, register identity on Arc, deploy treasury and governance contracts, and wire the allowlist. One guardian signed transaction per allowlist address.",
    bullets: [
      "Arc identity registry",
      "Treasury contracts",
      "Guardian recorded",
    ],
    glyph: <DeployGlyph />,
  },
  {
    title: "Fund treasury",
    body: "The platform wallet transfers USDC to your agent's on chain treasury. No user signature required for funding. You set the amount and the backend handles the transfer.",
    bullets: [
      "USDC on Arc",
      "Platform wallet transfer",
      "Up to 25 USDC per call",
    ],
    glyph: <FundGlyph />,
  },
] as const;

if (steps.length !== ONBOARDING_STEP_COUNT) {
  throw new Error("Landing walkthrough must match ONBOARDING_STEP_COUNT");
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/** Viewport heights per step, the scroll runway under the sticky stage. */
const STEP_SCROLL_VH = 50;

export function HowItWorks() {
  const [activeIndex, setActiveIndex] = useState(0);
  const sentinelRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    function updateActiveStep() {
      const center = window.innerHeight * 0.42;
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;

      sentinelRefs.current.forEach((el, index) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const distance = Math.abs(midpoint - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });

      setActiveIndex(bestIndex);
    }

    window.addEventListener("scroll", updateActiveStep, { passive: true });
    window.addEventListener("resize", updateActiveStep);
    updateActiveStep();

    return () => {
      window.removeEventListener("scroll", updateActiveStep);
      window.removeEventListener("resize", updateActiveStep);
    };
  }, []);

  function scrollToStep(index: number) {
    sentinelRefs.current[index]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  return (
    <section id="how" className="relative bg-ink-grain text-ink">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute inset-0 ink-grid" />
        <div className="absolute -left-40 top-1/2 h-[480px] w-[480px] -translate-y-1/2 rounded-full bg-accent/15 blur-[120px]" />
        <div className="absolute -right-40 top-0 h-[420px] w-[420px] rounded-full bg-highlight/10 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <Reveal variant="left" className="max-w-2xl">
            <SectionLabel index="01" label="Onboarding" tone="paper" />
            <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-[46px] lg:text-[56px]">
              {ONBOARDING_STEPS_HEADING}
            </h2>
          </Reveal>
          <Reveal variant="right" delay={120} className="max-w-sm">
            <p className="text-[14.5px] leading-[1.55] text-muted-dark">
              Scroll through the same eight screens you walk in onboarding, from
              passkey to a funded company.
            </p>
          </Reveal>
        </div>

        <div className="mt-10 lg:hidden">
          <MobileProgress activeIndex={activeIndex} />
        </div>

        <div className="relative mt-8 lg:mt-14">
          <div className="sticky top-20 z-10 lg:top-24">
            <div className="flex min-h-[calc(100dvh-5.5rem)] items-center py-4 lg:min-h-[calc(100dvh-6.5rem)] lg:py-6">
              <div className="grid w-full gap-10 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)] lg:gap-14">
                <aside className="hidden lg:block">
                  <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-dark-2">
                    Step {activeIndex + 1} of {ONBOARDING_STEP_COUNT}
                  </p>
                  <ol className="space-y-1">
                    {steps.map((item, i) => {
                      const active = activeIndex === i;
                      const done = activeIndex > i;
                      return (
                        <li key={item.title}>
                          <button
                            type="button"
                            onClick={() => scrollToStep(i)}
                            aria-current={active ? "step" : undefined}
                            aria-label={`Step ${i + 1}, ${item.title}`}
                            className={cx(
                              "group flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors",
                              active ? "bg-ink-3/80" : "hover:bg-ink-3/40",
                            )}
                          >
                            <span
                              className={cx(
                                "mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-[10px] font-mono transition-colors",
                                active
                                  ? "border-accent bg-accent text-paper"
                                  : done
                                    ? "border-accent/40 bg-ink-2 text-accent-soft"
                                    : "border-line-dark-strong bg-ink-2 text-muted-dark-2",
                              )}
                            >
                              {i + 1}
                            </span>
                            <span
                              className={cx(
                                "pt-0.5 text-[13px] font-medium leading-snug transition-colors",
                                active
                                  ? "text-ink"
                                  : done
                                    ? "text-ink/70"
                                    : "text-muted-dark",
                              )}
                            >
                              {item.title}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </aside>

                <div className="relative min-h-[380px] lg:min-h-[400px]">
                  {steps.map((item, i) => (
                    <StepCard
                      key={item.title}
                      n={String(i + 1)}
                      title={item.title}
                      body={item.body}
                      bullets={item.bullets}
                      glyph={item.glyph}
                      active={activeIndex === i}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {steps.map((item, i) => (
            <div
              key={item.title}
              ref={(el) => {
                sentinelRefs.current[i] = el;
              }}
              aria-hidden
              className="pointer-events-none"
              style={{ height: `${STEP_SCROLL_VH}vh` }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function MobileProgress({ activeIndex }: { activeIndex: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-muted-dark-2">
        <span>
          Step {activeIndex + 1} / {ONBOARDING_STEP_COUNT}
        </span>
        <span>{steps[activeIndex]?.title}</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-line-dark-strong">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
          style={{
            width: `${((activeIndex + 1) / ONBOARDING_STEP_COUNT) * 100}%`,
          }}
        />
      </div>
    </div>
  );
}

function StepCard({
  n,
  title,
  body,
  bullets,
  glyph,
  active,
}: {
  n: string;
  title: string;
  body: string;
  bullets: readonly string[];
  glyph: ReactNode;
  active: boolean;
}) {
  return (
    <div
      className={cx(
        "group rounded-2xl border hairline-dark-strong bg-ink-2 p-8 transition-all duration-500 ease-[cubic-bezier(0.22,0.95,0.32,1.1)] lg:p-10",
        active
          ? "relative z-10 translate-y-0 scale-100 opacity-100"
          : "pointer-events-none absolute inset-x-0 top-0 z-0 translate-y-4 scale-[0.98] opacity-0",
      )}
    >
      <div className="flex items-start justify-between">
        <div className="font-mono text-[12px] text-muted-dark-2">STEP {n}</div>
        <div
          className={cx(
            "text-accent-soft/80 transition-transform duration-500",
            active && "group-hover:-translate-y-0.5",
          )}
        >
          {glyph}
        </div>
      </div>
      <h3 className="mt-10 text-[28px] font-medium leading-none tracking-[-0.01em] text-ink">
        {title}
      </h3>
      <p className="mt-3 max-w-prose text-[14.5px] leading-[1.6] text-muted-dark">
        {body}
      </p>
      <ul className="mt-7 space-y-2">
        {bullets.map((b) => (
          <li
            key={b}
            className="flex items-center gap-2.5 text-[13px] text-ink/85"
          >
            <span className="h-1 w-1 rounded-full bg-accent" />
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PasskeyGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <circle cx="20" cy="20" r="12" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M14 20c0-3.3 2.7-6 6-6s6 2.7 6 6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M16 24c1.5 2 2.5 3 4 3s2.5-1 4-3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WorldGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <circle cx="20" cy="20" r="12" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 20h24M20 8c3 4 3 20 0 24M20 8c-3 4-3 20 0 24"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function LegalGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <path
        d="M8 32V16l12-8 12 8v16"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M16 32v-8h8v8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CustodyGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <rect
        x="10"
        y="14"
        width="20"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M14 14v-4h12v4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="22" r="3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function PolicyGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <rect
        x="8"
        y="6"
        width="24"
        height="28"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M14 14h12M14 20h8M14 26h10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AgreementGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <path
        d="M10 8l10-3 10 3v24l-10 3-10-3V8z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M17 20l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DeployGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <circle cx="20" cy="20" r="10" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M20 10v4M20 26v4M10 20h4M26 20h4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="20" cy="20" r="3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FundGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <rect
        x="6"
        y="11"
        width="28"
        height="20"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6 18h28" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="20" cy="24" r="3" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M20 22v4M18.5 24h3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
