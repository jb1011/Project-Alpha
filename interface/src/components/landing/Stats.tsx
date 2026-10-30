import { LANDING } from "./copy";
import { Reveal } from "./Reveal";

export function Stats() {
  return (
    <section className="relative bg-paper-2">
      <div className="mx-auto max-w-[1240px] px-6 lg:px-10">
        <h2 className="sr-only">What you get</h2>
        <div className="grid grid-cols-1 md:grid-cols-3">
          {LANDING.reasons.map((reason, i) => (
            <Reveal key={reason.title} delay={i * 90} variant="pop" duration={640}>
              <div className="px-6 py-8 md:px-8 md:py-10">
                <h3 className="text-[22px] font-medium leading-[1.2] tracking-[-0.02em] text-ink sm:text-[26px]">
                  {reason.title}
                </h3>
                <p className="mt-3 max-w-sm text-[15px] leading-[1.55] text-muted">
                  {reason.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
