import { SectionLabel } from "./SectionLabel";

const tiers = [
  {
    name: "Formation",
    price: "$299",
    cadence: "one-time",
    description:
      "Everything to go from passkey to a live, funded agent with on-chain spending rules and a Wyoming DAO LLC operating agreement.",
    cta: "Create my agent",
    href: "/onboarding",
    featured: false,
    bullets: [
      "Passkey-secured Turnkey vault",
      "Agent policy (caps, allowlist, timelock)",
      "Law-to-code operating agreement",
      "Arc deployment (identity + treasury)",
      "Guardian dashboard access",
    ],
  },
  {
    name: "Annual",
    price: "$99",
    cadence: "/ year",
    description:
      "Keep your agent operational with policy updates, guardian tools, and MCP access for agent self-configuration.",
    cta: "Add annual coverage",
    href: "/onboarding",
    featured: true,
    bullets: [
      "Wyoming annual report filing",
      "Policy amendments on-chain",
      "MCP server access",
      "Guardian controls (pause, veto, recover)",
      "Activity log + treasury monitoring",
    ],
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="relative bg-paper">
      <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-line" />
      <div className="mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <SectionLabel index="04" label="Pricing" />
            <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] sm:text-[46px] lg:text-[54px]">
              Honest pricing for real agents.
            </h2>
          </div>
          <p className="max-w-md text-[14.5px] leading-[1.55] text-muted">
            Pay once to deploy. Keep your agent alive for the cost of an annual
            report. No per-transaction fees, no custody charges.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
          {tiers.map((t) => (
            <article
              key={t.name}
              className={`relative flex flex-col overflow-hidden rounded-2xl border p-8 lg:p-10 ${
                t.featured
                  ? "bg-ink text-paper hairline-dark-strong"
                  : "bg-paper-2 hairline-strong"
              }`}
            >
              {t.featured && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute -top-32 -right-32 h-64 w-64 rounded-full bg-accent/25 blur-3xl"
                />
              )}

              <div className="flex items-center justify-between">
                <div
                  className={`text-[11.5px] uppercase tracking-[0.22em] ${
                    t.featured ? "text-paper/70" : "text-muted-2"
                  }`}
                >
                  {t.name}
                </div>
                {t.featured && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-accent-deep">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent-soft" />
                    Most agents start here
                  </span>
                )}
              </div>

              <div className="mt-6 flex items-baseline gap-2">
                <span
                  className={`text-[64px] font-medium leading-none tracking-[-0.03em] tabular-nums ${
                    t.featured ? "text-paper" : "text-ink"
                  }`}
                >
                  {t.price}
                </span>
                <span
                  className={`text-[14px] ${
                    t.featured ? "text-paper/70" : "text-muted"
                  }`}
                >
                  {t.cadence}
                </span>
              </div>

              <p
                className={`mt-4 text-[14.5px] leading-[1.55] ${
                  t.featured ? "text-paper/80" : "text-muted"
                }`}
              >
                {t.description}
              </p>

              <ul
                className={`mt-7 space-y-3 border-t pt-7 ${
                  t.featured ? "hairline-dark" : "hairline"
                }`}
              >
                {t.bullets.map((b) => (
                  <li
                    key={b}
                    className={`flex items-start gap-3 text-[14px] ${
                      t.featured ? "text-paper/90" : "text-ink/90"
                    }`}
                  >
                    <Check tone={t.featured ? "paper" : "ink"} />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <a
                href={t.href}
                className={`mt-8 inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-[14px] font-medium transition-colors ${
                  t.featured
                    ? "bg-paper text-ink hover:bg-paper-2"
                    : "bg-ink text-paper hover:bg-ink-hover"
                }`}
              >
                {t.cta} <span aria-hidden>→</span>
              </a>
            </article>
          ))}
        </div>

        <p className="mt-10 text-center text-[13px] text-muted">
          Need multiple agents or a custom deployment?{" "}
          <a
            href="#contact"
            className="underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            Talk to us
          </a>
          .
        </p>
      </div>
    </section>
  );
}

function Check({ tone }: { tone: "ink" | "paper" }) {
  const color = tone === "ink" ? "text-accent" : "text-accent-deep";
  return (
    <span
      className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center ${color}`}
    >
      <svg
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M2 6.5l2.5 2.5L10 3.5" />
      </svg>
    </span>
  );
}
