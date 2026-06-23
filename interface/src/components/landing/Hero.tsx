import { Terminal } from "./Terminal";

export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden bg-paper">
      <div aria-hidden className="absolute inset-0 -z-10 hero-mesh anim-mesh" />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 paper-grid opacity-60"
      />

      <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-16 px-6 pb-28 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:px-10 lg:pb-36 lg:pt-24">
        <div className="flex flex-col justify-center">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border hairline-strong bg-paper/70 backdrop-blur px-3 py-1 text-[11.5px] uppercase tracking-[0.18em] text-muted">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="anim-pulse-dot relative inline-block h-1.5 w-1.5 rounded-full text-accent" />
            </span>
            <span>Live on Arc</span>
            <span className="text-line-strong">/</span>
            <span>Wyoming DAO LLC</span>
          </div>

          <h1 className="mt-7 text-balance text-[44px] font-medium leading-[1.02] tracking-[-0.025em] text-ink sm:text-[60px] lg:text-[78px]">
            A society
            <span className="relative inline-block">
              <span
                aria-hidden
                className="absolute -bottom-1 left-0 h-[3px] w-full bg-accent/70"
              />
            </span>
            {" "}
            for your agent,
            <br />
            by design.
          </h1>

          <p className="mt-7 max-w-xl text-pretty text-[17px] leading-[1.55] text-muted lg:text-[18.5px]">
            Give your agent real infrastructure: identity, money, governance,
            and enforceable rules. Your passkey controls the vault. You define
            the spending policy. A law-to-code operating agreement binds it on
            Arc — and you stay the guardian.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              href="/onboarding"
              className="group inline-flex items-center gap-2 rounded-full bg-ink px-5 py-3 text-[14px] font-medium text-paper hover:bg-ink-hover transition-colors"
            >
              <span>Create my agent</span>
              <span
                aria-hidden
                className="transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </a>
            <a
              href="#how"
              className="inline-flex items-center gap-2 rounded-full border hairline-strong bg-paper/60 px-5 py-3 text-[14px] text-ink hover:bg-paper-2 transition-colors"
            >
              See how it works
            </a>
          </div>

          <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-2 text-[12.5px] text-muted">
            <span className="inline-flex items-center gap-2">
              <CheckDot /> Passkey-secured vault
            </span>
            <span className="inline-flex items-center gap-2">
              <CheckDot /> On-chain spending policy
            </span>
            <span className="inline-flex items-center gap-2">
              <CheckDot /> You keep guardian control
            </span>
          </div>
        </div>

        <div className="relative flex flex-col gap-4">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-6 -z-10 rounded-[28px] bg-gradient-to-br from-accent/15 via-transparent to-highlight/20 blur-2xl"
          />

          <Terminal
            title="projectAlpha · onboarding"
            lines={[
              { kind: "out", text: "→ binding passkey as vault root…", tone: "muted" },
              { kind: "out", text: "✓ Turnkey vault provisioned", tone: "ok" },
              { kind: "blank" },
              {
                kind: "out",
                text: "→ validating agent policy…",
                tone: "muted",
              },
              {
                kind: "out",
                text: "✓ Caps $500 / tx · $2,500 / day · 12h timelock",
                tone: "ok",
              },
              { kind: "blank" },
              {
                kind: "out",
                text: "→ generating operating agreement…",
                tone: "muted",
              },
              {
                kind: "out",
                text: "✓ Law-to-code fingerprint 0x7d3a…f8c2",
                tone: "ok",
              },
              { kind: "blank" },
              {
                kind: "out",
                text: "→ deploying identity + treasury on Arc…",
                tone: "muted",
              },
              {
                kind: "out",
                text: "✓ Contracts live · guardian recorded",
                tone: "ok",
              },
              { kind: "blank" },
              {
                kind: "out",
                text: "✓ Treasury funded · 1,000.00 USDC",
                tone: "info",
              },
            ]}
          />

          <div className="grid grid-cols-3 gap-3">
            <MiniMetric label="Passkey" value="1 tap" />
            <MiniMetric label="Policy" value="On-chain" />
            <MiniMetric label="Treasury" value="USDC · Arc" />
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-5 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted lg:flex">
        <span>Scroll to explore</span>
        <span className="anim-scroll-hint inline-block h-6 w-px bg-muted/60" />
      </div>
    </section>
  );
}

function CheckDot() {
  return (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border hairline-strong bg-paper">
      <svg
        viewBox="0 0 12 12"
        className="h-2.5 w-2.5 text-accent"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M2.5 6.5l2.5 2.5 4.5-5" />
      </svg>
    </span>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border hairline bg-paper/70 backdrop-blur px-3.5 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted-2">
        {label}
      </div>
      <div className="mt-1 font-mono text-[13.5px] text-ink tabular-nums">
        {value}
      </div>
    </div>
  );
}
