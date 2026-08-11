import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";
import { Terminal } from "./Terminal";

const policyFields = [
  {
    name: "per_tx_cap",
    desc: "Maximum USDC per single transaction.",
  },
  {
    name: "daily_cap",
    desc: "Rolling period spend ceiling.",
  },
  {
    name: "allowlist",
    desc: "Approved recipient addresses only.",
  },
  {
    name: "timelock_hours",
    desc: "Hold period before sensitive actions execute.",
  },
  {
    name: "purpose",
    desc: "Plain-language mandate for the agent.",
  },
];

const MCP_URL =
  process.env.NEXT_PUBLIC_MCP_URL ?? "https://project-alpha-pi.vercel.app/mcp";

export function CLIShowcase() {
  return (
    <section
      id="mcp"
      className="relative overflow-hidden bg-ink-grain text-ink"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 top-10 h-[440px] w-[440px] rounded-full bg-accent/20 blur-[140px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 bottom-10 h-[400px] w-[400px] rounded-full bg-highlight/10 blur-[120px]"
      />

      <div className="relative mx-auto grid max-w-[1240px] grid-cols-1 gap-12 px-6 py-24 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16 lg:px-10 lg:py-32">
        <div className="flex flex-col justify-center">
          <Reveal variant="left">
            <SectionLabel index="03" label="MCP agent connect" tone="paper" />
            <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-[44px] lg:text-[52px]">
              Connect your agent via MCP.
            </h2>
            <p className="mt-5 max-w-md text-[15px] leading-[1.6] text-muted-dark">
              Bootstrap a tenant-wide connection at /agents/connect: generate a
              link code, have your agent call claim_connection and onboard_agent,
              then poll get_entity. Scoped keys with a capability ladder from read
              to provision.
            </p>
          </Reveal>

          <ul className="mt-8 space-y-px overflow-hidden rounded-xl border hairline-dark-strong bg-line-dark-strong">
            {policyFields.map((r, i) => (
              <Reveal key={r.name} as="li" delay={i * 70} variant="left" duration={560}>
                <div className="group flex items-center gap-4 bg-ink-2 px-5 py-3.5 transition-colors hover:bg-ink-3">
                  <span className="font-mono text-[12.5px] text-highlight w-36 shrink-0">
                    {r.name}
                  </span>
                  <span className="text-[13.5px] text-muted-dark">{r.desc}</span>
                </div>
              </Reveal>
            ))}
          </ul>

          <Reveal delay={420} variant="pop">
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href="/agents/connect"
                className="inline-flex items-center gap-1.5 rounded-full bg-paper px-4 py-2.5 text-[13px] font-medium text-ink transition-all duration-300 hover:bg-paper-2 hover:scale-[1.03] active:scale-[0.98]"
              >
                Connect your agent <span aria-hidden>→</span>
              </a>
              <a
                href="/onboarding"
                className="inline-flex items-center gap-1.5 rounded-full border hairline-dark-strong px-4 py-2.5 text-[13px] text-ink/90 transition-all duration-300 hover:bg-ink-3 hover:scale-[1.03] active:scale-[0.98]"
              >
                Manual onboarding
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal variant="right" delay={160} duration={760} className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-6 -z-10 rounded-[28px] bg-gradient-to-br from-accent/20 via-transparent to-highlight/20 blur-2xl"
          />
          <Terminal
            title="Example · MCP bootstrap"
            lines={[
              {
                kind: "out",
                text: `→ MCP endpoint: ${MCP_URL}`,
                tone: "muted",
              },
              {
                kind: "out",
                text: "→ agent calls claim_connection(link_code)…",
                tone: "muted",
              },
              {
                kind: "out",
                text: "✓ bound: true",
                tone: "ok",
              },
              {
                kind: "out",
                text: "→ agent calls onboard_agent(passkeyId, spec)…",
                tone: "muted",
              },
              {
                kind: "out",
                text: "✓ per_tx_cap: 25 USDC · daily_cap: 100 USDC",
                tone: "ok",
              },
              {
                kind: "out",
                text: "✓ timelock: 24h · allowlist: 0 recipients",
                tone: "ok",
              },
              { kind: "blank" },
              {
                kind: "out",
                text: "✓ Schema validated against /schema/agent-spec.json",
                tone: "ok",
              },
              {
                kind: "out",
                text: "ℹ Guardian approves before on-chain deploy",
                tone: "info",
              },
            ]}
          />

          <div className="mt-4 grid grid-cols-3 gap-3">
            {[
              { label: "Endpoint", value: "MCP" },
              { label: "Bootstrap", value: "Live" },
              { label: "Approval", value: "Human" },
            ].map((pill, i) => (
              <Reveal key={pill.label} delay={320 + i * 80} variant="scale" duration={520}>
                <Pill label={pill.label} value={pill.value} />
              </Reveal>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border hairline-dark-strong bg-ink-2 px-3.5 py-3 transition-transform duration-300 hover:scale-[1.04]">
      <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted-dark-2">
        {label}
      </div>
      <div className="mt-1 font-mono text-[13px] text-ink">{value}</div>
    </div>
  );
}
