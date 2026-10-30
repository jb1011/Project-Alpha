import { CREATE_COMPANY_CTA, LANDING, SEE_HOW_CTA } from "./copy";
import { Reveal } from "./Reveal";

export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden bg-paper">
      <div aria-hidden className="absolute inset-0 -z-10 hero-mesh anim-mesh" />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 paper-grid opacity-60"
      />

      <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-16 px-6 pb-20 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:px-10 lg:pb-28 lg:pt-24">
        <div className="flex flex-col justify-center">
          <Reveal immediate delay={120} variant="up" duration={640}>
            <p className="inline-flex items-center rounded-full border hairline-strong bg-paper/70 px-3 py-1.5 text-[13px] font-medium tracking-[0.04em] text-ink">
              {LANDING.badge}
            </p>
          </Reveal>

          <Reveal immediate delay={180} variant="up" duration={760}>
            <h1 className="mt-6 text-balance text-[44px] font-medium leading-[1.02] tracking-[-0.025em] text-ink sm:text-[60px] lg:text-[78px]">
              <span className="relative inline-block">Create a company</span>
              <br />
              for your agent.
            </h1>
          </Reveal>

          <Reveal immediate delay={300} variant="up">
            <p className="mt-7 max-w-xl text-pretty text-[17px] leading-[1.5] text-ink lg:text-[18px]">
              {LANDING.problem}
            </p>
            <p className="mt-4 max-w-xl text-pretty text-[16px] leading-[1.55] text-muted lg:text-[17px]">
              {LANDING.product}
            </p>
          </Reveal>

          <Reveal immediate delay={420} variant="pop">
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href="/onboarding"
                className="group inline-flex items-center gap-2 rounded-full bg-ink px-5 py-3 text-[14px] font-medium text-paper transition-all duration-300 hover:bg-ink-hover hover:scale-[1.03] active:scale-[0.98]"
              >
                <span>{CREATE_COMPANY_CTA}</span>
                <span
                  aria-hidden
                  className="transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </a>
              <a
                href="#how"
                className="inline-flex items-center gap-2 rounded-full border hairline-strong bg-paper/60 px-5 py-3 text-[14px] text-ink transition-all duration-300 hover:bg-paper-2 hover:scale-[1.03] active:scale-[0.98]"
              >
                {SEE_HOW_CTA}
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal
          immediate
          delay={520}
          variant="right"
          duration={820}
          className="flex items-center justify-center py-6 lg:justify-end lg:py-8"
        >
          <div className="w-full max-w-[400px] rotate-[2.5deg] transition-transform duration-500 hover:rotate-[1.5deg] hover:scale-[1.02] lg:max-w-[420px]">
            <AgentDeskPreview />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function AgentDeskPreview() {
  const preview = LANDING.preview;
  return (
    <div className="overflow-hidden rounded-2xl border hairline-strong bg-paper shadow-[0_12px_40px_-12px_rgba(0,0,0,0.3)]">
      <div className="flex items-center justify-between border-b hairline bg-paper-2/80 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <span className="text-[13px] tracking-wide text-muted">
          {preview.window}
        </span>
        <span className="w-12" aria-hidden />
      </div>

      <div className="space-y-3 p-5">
        <Reveal immediate delay={640} variant="pop" duration={560}>
          <div className="rounded-xl border hairline bg-paper-2/50 px-4 py-3">
            <div className="text-[13px] uppercase tracking-[0.14em] text-muted">
              {preview.policyLabel}
            </div>
            <p className="mt-1.5 text-[15px] leading-[1.5] text-ink">
              {preview.policy}
            </p>
          </div>
        </Reveal>

        <div className="flex flex-col items-center py-1">
          <div className="h-4 w-px bg-line-strong" />
          <span className="my-1 rounded-full bg-ink px-2.5 py-0.5 text-[13px] font-medium uppercase tracking-[0.08em] text-paper">
            {preview.chip}
          </span>
          <div className="h-4 w-px bg-line-strong" />
        </div>

        <Reveal immediate delay={760} variant="scale" duration={620}>
          <div className="overflow-hidden rounded-xl border-2 border-accent/40 bg-accent/[0.06]">
            <div className="flex items-start gap-3 p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent/30 to-highlight/25 text-[14px] font-medium text-ink">
                AG
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[15px] font-medium text-ink">
                      {preview.agent}
                    </div>
                    <div className="mt-0.5 text-[13px] text-muted">
                      {preview.meta}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-ink px-2 py-0.5 text-[13px] font-medium text-paper">
                    ✓
                  </span>
                </div>
                <ul className="mt-2.5 space-y-1 text-[13px] text-muted">
                  {preview.points.map((point) => (
                    <li key={point}>· {point}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="border-t border-accent/25 bg-accent/10 px-4 py-2 text-[13px] font-medium text-accent-soft">
              {preview.status}
            </div>
          </div>
        </Reveal>

        <Reveal immediate delay={880} variant="up" duration={560}>
          <div className="flex items-center gap-3 rounded-xl border hairline bg-paper-2/40 px-3 py-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-paper-3 text-[13px] font-medium text-muted">
              YOU
            </div>
            <div>
              <div className="text-[15px] font-medium text-ink">{preview.you}</div>
              <div className="text-[13px] text-muted">{preview.role}</div>
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
