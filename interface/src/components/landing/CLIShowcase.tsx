import { SectionLabel } from "./SectionLabel";
import { Terminal } from "./Terminal";

const policyFields = [
  {
    name: "per_tx_cap",
    desc: "Maximum USDC per single transaction.",
  },
  {
    name: "daily_cap",
    desc: "Rolling 24-hour spend ceiling.",
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
          <SectionLabel index="03" label="Agent self-config" tone="paper" />
          <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-[44px] lg:text-[52px]">
            Your agent drafts its own policy.
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-[1.6] text-muted-dark">
            Point your AI at our MCP server. It proposes spending rules in
            conversation — validated in real time against the policy schema. You
            review in plain language, then approve before anything goes on-chain.
          </p>

          <ul className="mt-8 space-y-px overflow-hidden rounded-xl border hairline-dark-strong bg-line-dark-strong">
            {policyFields.map((r) => (
              <li
                key={r.name}
                className="group flex items-center gap-4 bg-ink-2 px-5 py-3.5 transition-colors hover:bg-ink-3"
              >
                <span className="font-mono text-[12.5px] text-highlight w-36 shrink-0">
                  {r.name}
                </span>
                <span className="text-[13.5px] text-muted-dark">{r.desc}</span>
                <span
                  aria-hidden
                  className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 text-ink/70"
                >
                  →
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a
              href="/onboarding"
              className="inline-flex items-center gap-1.5 rounded-full bg-paper px-4 py-2.5 text-[13px] font-medium text-ink hover:bg-paper-2 transition-colors"
            >
              Try agent self-config <span aria-hidden>→</span>
            </a>
            <a
              href="#docs"
              className="inline-flex items-center gap-1.5 rounded-full border hairline-dark-strong px-4 py-2.5 text-[13px] text-ink/90 hover:bg-ink-3 transition-colors"
            >
              MCP docs
            </a>
          </div>
        </div>

        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-6 -z-10 rounded-[28px] bg-gradient-to-br from-accent/20 via-transparent to-highlight/20 blur-2xl"
          />
          <Terminal
            title="MCP · agent-policy"
            lines={[
              {
                kind: "out",
                text: "→ agent connected to mcp.projectalpha.xyz",
                tone: "muted",
              },
              {
                kind: "out",
                text: "→ drafting policy proposal…",
                tone: "muted",
              },
              {
                kind: "out",
                text: "✓ name: Atlas Treasury Bot",
                tone: "ok",
              },
              {
                kind: "out",
                text: "✓ per_tx_cap: 500 USDC · daily_cap: 2,500 USDC",
                tone: "ok",
              },
              {
                kind: "out",
                text: "✓ timelock: 12h · allowlist: 2 recipients",
                tone: "ok",
              },
              { kind: "blank" },
              {
                kind: "out",
                text: "✓ Schema-valid — ready for human review",
                tone: "ok",
              },
              {
                kind: "out",
                text: "ℹ Guardian must approve before on-chain deploy",
                tone: "info",
              },
            ]}
          />

          <div className="mt-4 grid grid-cols-3 gap-3">
            <Pill label="Endpoint" value="MCP" />
            <Pill label="Validation" value="Live" />
            <Pill label="Approval" value="Human" />
          </div>
        </div>
      </div>
    </section>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border hairline-dark-strong bg-ink-2 px-3.5 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted-dark-2">
        {label}
      </div>
      <div className="mt-1 font-mono text-[13px] text-ink">{value}</div>
    </div>
  );
}
