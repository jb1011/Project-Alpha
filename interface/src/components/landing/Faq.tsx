import { LANDING } from "./copy";
import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";

export function Faq() {
  const faq = LANDING.faq;
  return (
    <section id="faq" className="bg-paper">
      <div className="mx-auto max-w-[1240px] px-6 py-20 lg:px-10 lg:py-24">
        <Reveal variant="up" className="max-w-2xl">
          <SectionLabel index="03" label={faq.label} />
          <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-[46px]">
            {faq.heading}
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-8 md:grid-cols-2">
          {faq.items.map((item) => (
            <article key={item.q}>
              <h3 className="text-[18px] font-medium leading-snug text-ink">
                {item.q}
              </h3>
              <p className="mt-2 text-[15px] leading-[1.6] text-muted">{item.a}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
