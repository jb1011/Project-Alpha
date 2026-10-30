import { LANDING } from "./copy";
import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";

export function Why() {
  const why = LANDING.why;
  return (
    <section id="why" className="bg-paper">
      <div className="mx-auto max-w-[1240px] px-6 py-20 lg:px-10 lg:py-24">
        <Reveal variant="up">
          <SectionLabel index="01" label={why.label} />
          <h2 className="mt-4 max-w-3xl text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-[46px]">
            {why.heading}
          </h2>
          <p className="mt-5 max-w-2xl text-[16px] leading-[1.6] text-muted lg:text-[17px]">
            {why.intro}
          </p>
        </Reveal>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {why.points.map((point, i) => (
            <Reveal key={point.title} delay={i * 80} variant="up">
              <article className="h-full rounded-2xl border hairline bg-paper-2 p-6">
                <h3 className="text-[20px] font-medium leading-snug text-ink">
                  {point.title}
                </h3>
                <p className="mt-3 text-[15px] leading-[1.6] text-muted">
                  {point.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
