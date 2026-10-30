import { CREATE_COMPANY_CTA, LANDING, READ_QUESTIONS_CTA } from "./copy";
import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";

export function AgentCTA() {
  const close = LANDING.close;
  return (
    <section className="relative overflow-hidden bg-ink-grain text-ink">
      <div
        aria-hidden
        className="absolute inset-0 ink-grid pointer-events-none"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hero-mesh-dark anim-mesh opacity-90"
      />

      <div className="relative mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <Reveal variant="scale">
            <SectionLabel index="" label={close.label} tone="paper" />
          </Reveal>

          <Reveal delay={120} variant="pop" duration={760}>
            <h2 className="mt-5 text-balance text-[42px] font-medium leading-[1.02] tracking-[-0.025em] text-ink sm:text-[56px] lg:text-[64px]">
              {close.heading}
            </h2>
          </Reveal>

          <Reveal delay={240} variant="up">
            <p className="mt-6 max-w-xl text-pretty text-[16px] leading-[1.6] text-muted-dark lg:text-[17.5px]">
              {close.body}
            </p>
          </Reveal>

          <Reveal delay={360} variant="pop">
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <a
                href="/onboarding"
                className="group inline-flex items-center gap-2 rounded-full bg-paper px-6 py-3.5 text-[14.5px] font-medium text-ink transition-all duration-300 hover:bg-paper-2 hover:scale-[1.04] active:scale-[0.98]"
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
                href="#faq"
                className="inline-flex items-center gap-2 rounded-full border hairline-dark-strong px-6 py-3.5 text-[14.5px] text-ink transition-all duration-300 hover:bg-ink-3 hover:scale-[1.04] active:scale-[0.98]"
              >
                {READ_QUESTIONS_CTA}
              </a>
            </div>
          </Reveal>

          <Reveal delay={480} variant="up">
            <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 text-[14px] text-muted-dark">
              {close.notes.map((note) => (
                <li key={note} className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-soft" />
                  {note}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
