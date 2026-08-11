"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";

type Feature = {
  title: string;
  body: string;
  tag: string;
  icon: ReactNode;
  cta?: { label: string; href: string };
};

const features: Feature[] = [
  {
    tag: "Custody",
    title: "Key custody, your choice",
    body: "Novi-managed (Circle MPC smart account, gasless) is the recommended default. Or choose passkey-rooted keys in a Turnkey vault you control. Either way, your guardian wallet keeps every on-chain override.",
    icon: <IconPasskey />,
  },
  {
    tag: "Policy",
    title: "Spending rules",
    body: "Per-transaction caps, rolling period limits, recipient allowlists, and timelocks. The on-chain period cap is the hard backstop; software gates re-check fresh on-chain state before every x402 payment.",
    icon: <IconPolicy />,
  },
  {
    tag: "Identity",
    title: "World ID accountability",
    body: "Wyoming DAO LLCs need a natural person. World ID proves one unique human per account without storing name, document, or face. AgentBook on World Chain powers human-backed payment trust.",
    icon: <IconWorld />,
  },
  {
    tag: "Legal",
    title: "Law-to-code agreement",
    body: "Your policy becomes a Wyoming DAO LLC operating agreement. A cryptographic fingerprint binds the legal document to the deployed smart contracts.",
    icon: <IconAgreement />,
  },
  {
    tag: "Chain",
    title: "Arc deployment",
    body: "Agent identity, treasury, and governance deploy on Arc in one resumable saga. ENS names, ERC-8183 jobs, and x402 payments are live on testnet today.",
    icon: <IconArc />,
  },
  {
    tag: "Guardian",
    title: "Human safety brake",
    body: "Pause the agent, veto actions held in timelock, or emergency withdraw to the payout address. You are the legally responsible guardian member.",
    icon: <IconGuardian />,
  },
  {
    tag: "Agents",
    title: "MCP agent connect",
    body: "Connect Claude Code, Cursor, or any of 11 MCP clients via /agents/connect. Bootstrap with a link code, claim_connection, and onboard_agent — scoped keys with a capability ladder from read to provision.",
    icon: <IconMcp />,
    cta: { label: "Connect your agent", href: "/agents/connect" },
  },
];

const PANEL_COUNT = features.length;
const STEP_SCROLL_VH = 50;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function FeatureCard({
  feature,
  index,
  active,
  stacked = false,
}: {
  feature: Feature;
  index: number;
  active: boolean;
  stacked?: boolean;
}) {
  return (
    <article
      className={cx(
        "group rounded-2xl border hairline-strong bg-paper p-8 transition-all duration-500 ease-[cubic-bezier(0.22,0.95,0.32,1.1)] lg:p-10",
        stacked
          ? active
            ? "relative z-10 translate-y-0 scale-100 opacity-100"
            : "pointer-events-none absolute inset-x-0 top-0 z-0 translate-y-4 scale-[0.98] opacity-0"
          : active
            ? "relative translate-y-0 scale-100 opacity-100"
            : "relative translate-y-6 scale-[0.98] opacity-40",
      )}
    >
      <div className="flex items-start justify-between">
        <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg border hairline-strong bg-paper-2 text-ink transition-all group-hover:bg-ink group-hover:text-paper group-hover:-translate-y-0.5 group-hover:border-transparent">
          {feature.icon}
        </div>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-2">
          {feature.tag}
        </span>
      </div>

      <div className="mt-8 font-mono text-[12px] text-muted-2">
        FEATURE {index + 1}
      </div>
      <h3 className="mt-4 text-[28px] font-medium leading-none tracking-[-0.01em] text-ink">
        {feature.title}
      </h3>
      <p className="mt-3 max-w-prose text-[14.5px] leading-[1.6] text-muted">
        {feature.body}
      </p>

      {feature.cta && (
        <a
          href={feature.cta.href}
          className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-ink px-5 py-2.5 text-[13px] font-medium text-paper transition-colors hover:bg-ink-hover"
        >
          {feature.cta.label} <span aria-hidden>→</span>
        </a>
      )}
    </article>
  );
}

function FeatureRail({
  activeIndex,
  onSelect,
}: {
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="space-y-1">
      {features.map((feature, i) => {
        const active = activeIndex === i;
        const done = activeIndex > i;
        return (
          <li key={feature.title}>
            <button
              type="button"
              onClick={() => onSelect(i)}
              className={cx(
                "group flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors",
                active ? "bg-paper-2" : "hover:bg-paper-2/60",
              )}
            >
              <span
                className={cx(
                  "mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-[10px] font-mono transition-colors",
                  active
                    ? "border-accent bg-accent text-paper"
                    : done
                      ? "border-accent/40 bg-paper text-accent-soft"
                      : "border-line-strong bg-paper text-muted-2",
                )}
              >
                {i + 1}
              </span>
              <span className="min-w-0 pt-0.5">
                <span
                  className={cx(
                    "block text-[13px] font-medium leading-snug transition-colors",
                    active ? "text-ink" : done ? "text-ink/70" : "text-muted",
                  )}
                >
                  {feature.title}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function MobileProgress({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="lg:hidden">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-muted-2">
        <span>
          Feature {activeIndex + 1} / {PANEL_COUNT}
        </span>
        <span>{features[activeIndex]?.title}</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-line-strong">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
          style={{ width: `${((activeIndex + 1) / PANEL_COUNT) * 100}%` }}
        />
      </div>
    </div>
  );
}

export function Features() {
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

  function scrollToFeature(index: number) {
    sentinelRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <section id="features" className="relative bg-paper-grain">
      <div className="relative mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <Reveal variant="left" className="max-w-2xl">
          <SectionLabel index="02" label="What you get" />
          <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] sm:text-[46px] lg:text-[54px]">
            Everything in the onboarding flow.
          </h2>
        </Reveal>
        <Reveal variant="right" delay={120} className="max-w-md">
          <p className="text-[14.5px] leading-[1.55] text-muted">
            Scroll through each capability — custody, policy, identity, legal,
            chain, guardian controls, and MCP connect.
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
                  <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
                    Feature {activeIndex + 1} of {PANEL_COUNT}
                  </p>
                  <FeatureRail activeIndex={activeIndex} onSelect={scrollToFeature} />
                </aside>

                <div className="relative min-h-[380px] lg:min-h-[400px]">
                  {features.map((feature, i) => (
                    <FeatureCard
                      key={feature.title}
                      feature={feature}
                      index={i}
                      active={activeIndex === i}
                      stacked
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {Array.from({ length: PANEL_COUNT }, (_, i) => (
            <div
              key={i}
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

function IconPasskey() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 12c0-2.2 1.8-4 4-4s4 1.8 4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M9.5 14.5c1 1.5 2 2 2.5 2s1.5-.5 2.5-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconPolicy() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 3h9l3 3v15H6V3z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M15 3v3h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M9 12h6M9 16h4M9 8h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconWorld() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4 12h16M12 4c2.5 3 2.5 13 0 16M12 4c-2.5 3-2.5 13 0 16"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function IconAgreement() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 5l4-2 4 2 4-2 4 2v14l-4 2-4-2-4 2-4-2V5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 9l3 3 5-5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconArc() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4 12h16M12 4c2.5 3 2.5 13 0 16M12 4c-2.5 3-2.5 13 0 16"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function IconGuardian() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l8 3.5v5c0 5.5-3.5 9-8 11-4.5-2-8-5.5-8-11v-5L12 3z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M9 12l2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMcp() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="4"
        y="4"
        width="7"
        height="7"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="13"
        y="4"
        width="7"
        height="7"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="4"
        y="13"
        width="7"
        height="7"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle
        cx="16.5"
        cy="16.5"
        r="3.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
