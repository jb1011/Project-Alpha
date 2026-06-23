import { SectionLabel } from "./SectionLabel";

const steps = [
  {
    n: "00",
    title: "Passkey",
    body: "One tap creates a secure key vault for your agent. Your device's passkey becomes the root of control — no email, no password, no account.",
    bullets: ["Turnkey vault", "WebAuthn / Face ID", "Non-custodial by design"],
    glyph: <PasskeyGlyph />,
  },
  {
    n: "01",
    title: "Define agent",
    body: "Set identity and spending rules: per-transaction caps, daily limits, recipient allowlists, and timelocks. Fill the form yourself or let your agent draft it via MCP.",
    bullets: ["USDC spending caps", "Recipient allowlist", "MCP self-config"],
    glyph: <PolicyGlyph />,
  },
  {
    n: "02",
    title: "Operating agreement",
    body: "A law-to-code translator turns your rules into a Wyoming DAO LLC operating agreement. A cryptographic fingerprint guarantees the legal document and on-chain policy are identical.",
    bullets: ["Wyoming DAO LLC", "Law-to-code binding", "Policy fingerprint"],
    glyph: <AgreementGlyph />,
  },
  {
    n: "03",
    title: "Deploy on-chain",
    body: "Four automated steps provision the agent key, register identity on Arc, deploy treasury and governance contracts, and wire everything together. Resumable if anything fails.",
    bullets: ["Arc identity registry", "Treasury contracts", "Guardian recorded"],
    glyph: <DeployGlyph />,
  },
  {
    n: "04",
    title: "Fund treasury",
    body: "Send USDC from your own wallet to the agent's on-chain treasury. You sign the transfer yourself — projectAlpha can never move your funds.",
    bullets: ["USDC on Arc", "Your wallet signs", "Testnet faucet available"],
    glyph: <FundGlyph />,
  },
  {
    n: "05",
    title: "Live",
    body: "Your agent transacts autonomously within its limits. You monitor activity, pause the agent, veto held actions, or recover the full treasury at any time.",
    bullets: ["Activity log", "Pause & veto", "Fund recovery"],
    glyph: <LiveGlyph />,
  },
];

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
              Six steps from passkey to live agent.
            </h2>
          </div>
          <p className="max-w-sm text-[14.5px] leading-[1.55] text-muted-dark">
            The same flow you walk through in onboarding — passkey vault,
            spending policy, legal agreement, on-chain deployment, funding, and
            guardian dashboard.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border hairline-dark-strong bg-line-dark-strong md:grid-cols-2 lg:grid-cols-3">
          {steps.map((s) => (
            <div
              key={s.n}
              className="group relative bg-ink-2 p-8 transition-colors hover:bg-ink-3 lg:p-10"
            >
              <div className="flex items-start justify-between">
                <div className="font-mono text-[12px] text-muted-dark-2">
                  STEP {s.n}
                </div>
                <div className="text-accent-soft/80 transition-transform group-hover:-translate-y-0.5">
                  {s.glyph}
                </div>
              </div>

              <h3 className="mt-10 text-[28px] font-medium leading-none tracking-[-0.01em] text-ink">
                {s.title}
              </h3>
              <p className="mt-3 text-[14.5px] leading-[1.6] text-muted-dark">
                {s.body}
              </p>

              <ul className="mt-7 space-y-2">
                {s.bullets.map((b) => (
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
          ))}
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

function LiveGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
      <path
        d="M20 6l12 5v6c0 8-5 13-12 17-7-4-12-9-12-17v-6l12-5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M15 20l4 4 7-8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
