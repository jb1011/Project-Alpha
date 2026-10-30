import { LANDING, ONBOARDING_STEP_COUNT } from "./copy";
import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";

export function HowItWorks() {
  return (
    <section id="how" className="bg-paper-2">
      <div className="mx-auto max-w-[1240px] px-6 py-20 lg:px-10 lg:py-24">
        <Reveal variant="up" className="max-w-2xl">
          <SectionLabel index="02" label="Onboarding" />
          <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-[46px]">
            {LANDING.stepsHeading}
          </h2>
          <p className="mt-4 text-[16px] leading-[1.6] text-muted">
            {LANDING.stepsLede}
          </p>
        </Reveal>

        <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {LANDING.steps.map((step, i) => (
            <Reveal
              as="li"
              key={step.title}
              delay={(i % 4) * 60}
              variant="up"
              className="h-full"
            >
              <div className="h-full rounded-2xl border hairline bg-paper p-5">
                <div className="text-[13px] font-medium text-muted">
                  Step {i + 1} of {ONBOARDING_STEP_COUNT}
                </div>
                <h3 className="mt-3 text-[18px] font-medium leading-snug text-ink">
                  {step.title}
                </h3>
                <p className="mt-2 text-[15px] leading-[1.55] text-muted">
                  {step.body}
                </p>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
