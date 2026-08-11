import { SectionLabel } from "./SectionLabel";

const steps = [
  {
    n: "1",
    title: "Wallet & passkey",
    body: "Sign in with your wallet, then create a guardian passkey. The passkey anchors your human approval — it becomes the vault root only if you choose passkey-rooted custody.",
    bullets: ["SIWE sign-in", "WebAuthn / Face ID", "Guardian anchor"],
    glyph: <PasskeyGlyph />,
  },
  {
    n: "2",
    title: "Accountable human",
    body: "Verify with World ID so a unique human stands behind the Wyoming DAO LLC. We store a nullifier, never your name, document, or face.",
    bullets: ["World ID proof", "One human per account", "Sybil resistant"],
    glyph: <WorldGlyph />,
  },
  {
    n: "3",
    title: "Key custody",
    body: "Choose Novi-managed (Circle MPC, gasless, recommended) or passkey-rooted (Turnkey vault under your passkey). The payment float is platform-managed on both paths.",
    bullets: [
      "Novi-managed default",
      "Passkey-rooted option",
      "Guardian overrides",
    ],
    glyph: <CustodyGlyph />,
  },
  {
    n: "4",
    title: "Define agent",
    body: "Set identity and spending rules: per-transaction caps, period limits, recipient allowlists, and timelocks. Fill the form yourself or connect an MCP agent to draft it.",
    bullets: ["USDC spending caps", "Recipient allowlist", "MCP or manual"],
    glyph: <PolicyGlyph />,
  },
  {
    n: "5",
    title: "Operating agreement",
    body: "A law-to-code translator turns your rules into a Wyoming DAO LLC operating agreement. A cryptographic fingerprint guarantees the legal document and on-chain policy are identical.",
    bullets: ["Wyoming DAO LLC", "Law-to-code binding", "Policy fingerprint"],
    glyph: <AgreementGlyph />,
  },
  {
    n: "6",
    title: "Deploy on-chain",
    body: "Automated steps provision the agent key, register identity on Arc, deploy treasury and governance contracts, and wire the allowlist. One guardian-signed transaction per allowlist address.",
    bullets: [
      "Arc identity registry",
      "Treasury contracts",
      "Guardian recorded",
    ],
    glyph: <DeployGlyph />,
  },
  {
    n: "7",
    title: "Fund treasury",
    body: "The platform wallet transfers USDC to your agent's on-chain treasury. No user signature required for funding — you set the amount and the backend handles the transfer.",
    bullets: [
      "USDC on Arc",
      "Platform wallet transfer",
      "Up to 25 USDC per call",
    ],
    glyph: <FundGlyph />,
  },
];

type Step = (typeof steps)[number];

function StepCard({ step, finale }: { step: Step; finale?: boolean }) {
  return (
    <div
      className={`group relative bg-ink-2 transition-colors hover:bg-ink-3 ${
        finale ? "p-8 lg:p-10" : "p-8 lg:p-10"
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="font-mono text-[12px] text-muted-dark-2">STEP {step.n}</div>
        <div className="text-accent-soft/80 transition-transform group-hover:-translate-y-0.5">
          {step.glyph}
        </div>
      </div>

      <h3
        className={`font-medium leading-none tracking-[-0.01em] text-ink ${
          finale ? "mt-6 text-[24px] lg:mt-8 lg:text-[28px]" : "mt-10 text-[28px]"
        }`}
      >
        {step.title}
      </h3>
      <p className="mt-3 max-w-prose text-[14.5px] leading-[1.6] text-muted-dark">
        {step.body}
      </p>

      <ul className={`space-y-2 ${finale ? "mt-5 flex flex-wrap gap-x-6 gap-y-2 lg:mt-6" : "mt-7"}`}>
        {step.bullets.map((b) => (
          <li
            key={b}
            className={`flex items-center gap-2.5 text-[13px] text-ink/85 ${
              finale ? "shrink-0" : ""
            }`}
          >
            <span className="h-1 w-1 rounded-full bg-accent" />
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HowItWorks() {
  return (
    <section
      id="how"
      className="relative overflow-hidden bg-ink-grain text-ink"
    >
      <div
        aria-hidden
        className="absolute inset-0 ink-grid pointer-events-none"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-1/2 h-[480px] w-[480px] -translate-y-1/2 rounded-full bg-accent/15 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-0 h-[420px] w-[420px] rounded-full bg-highlight/10 blur-[120px]"
      />

      <div className="relative mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <SectionLabel index="01" label="Onboarding" tone="paper" />
            <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-[46px] lg:text-[56px]">
              Seven steps from passkey to live agent.
            </h2>
          </div>
          <p className="max-w-sm text-[14.5px] leading-[1.55] text-muted-dark">
            The same flow you walk through in onboarding — World ID
            verification, custody choice, spending policy, legal agreement,
            on-chain deployment, funding, and your guardian dashboard.
          </p>
        </div>

        <div className="mt-14 overflow-hidden rounded-2xl border hairline-dark-strong bg-line-dark-strong">
          <div className="grid grid-cols-1 gap-px md:grid-cols-2 lg:grid-cols-3">
            {steps.slice(0, 6).map((s) => (
              <StepCard key={s.n} step={s} />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-px border-t hairline-dark-strong lg:grid-cols-[1fr_auto]">
            <StepCard step={steps[6]!} finale />
            <div className="bg-ink-2 px-8 py-8 lg:py-10 lg:pl-10 lg:pr-10">
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-dark-2">
                Done
              </div>
              <p className="mt-2 max-w-xs text-[15px] font-medium leading-snug text-ink">
                Your agent is live on the dashboard.
              </p>
              <p className="mt-2 max-w-xs text-[13px] leading-[1.55] text-muted-dark">
                Monitor treasury, pause spending, connect via MCP.
              </p>
              <a
                href="/onboarding"
                className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent-soft transition-colors hover:text-ink"
              >
                Start onboarding <span aria-hidden>→</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
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
