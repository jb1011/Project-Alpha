import { SectionLabel } from "./SectionLabel";
import type { ReactNode } from "react";

type Feature = {
  title: string;
  body: string;
  tag: string;
  icon: ReactNode;
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
  },
];

function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <article className="group relative flex flex-col gap-6 bg-paper p-7 transition-colors hover:bg-paper-2 lg:p-8">
      <div className="flex items-start justify-between">
        <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg border hairline-strong bg-paper-2 text-ink transition-all group-hover:bg-ink group-hover:text-paper group-hover:-translate-y-0.5 group-hover:border-transparent">
          {feature.icon}
        </div>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-2">
          {feature.tag}
        </span>
      </div>

      <div>
        <h3 className="text-[19px] font-medium tracking-[-0.01em] text-ink">
          {feature.title}
        </h3>
        <p className="mt-2 text-[14px] leading-[1.55] text-muted">{feature.body}</p>
      </div>
    </article>
  );
}

export function Features() {
  return (
    <section id="features" className="relative bg-paper-grain">
      <div className="mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <SectionLabel index="02" label="What you get" />
            <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] sm:text-[46px] lg:text-[54px]">
              Everything in the onboarding flow.
            </h2>
          </div>
          <p className="max-w-md text-[14.5px] leading-[1.55] text-muted">
            Custody choice, World ID verification, spending policy, legal agreement,
            on-chain deployment, MCP connect, and guardian controls — the full stack
            for an autonomous agent that holds real money.
          </p>
        </div>

        <div className="mt-14 overflow-hidden rounded-2xl border hairline-strong bg-line-strong">
          <div className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">
            {features.slice(0, 6).map((f) => (
              <FeatureCard key={f.title} feature={f} />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-px border-t hairline-strong lg:grid-cols-[1fr_auto]">
            <FeatureCard feature={features[6]!} />
            <div className="flex flex-col justify-center bg-paper-2 px-7 py-8 lg:px-8 lg:py-10">
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-2">
                Connect
              </div>
              <p className="mt-2 max-w-xs text-[15px] font-medium leading-snug text-ink">
                Hook up Claude, Cursor, or any MCP client.
              </p>
              <p className="mt-2 max-w-xs text-[13px] leading-[1.55] text-muted">
                Bootstrap a link code and let your agent onboard itself.
              </p>
              <a
                href="/agents/connect"
                className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent-soft transition-colors hover:text-ink"
              >
                Connect your agent <span aria-hidden>→</span>
              </a>
            </div>
          </div>
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
