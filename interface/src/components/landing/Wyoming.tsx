import { SectionLabel } from "./SectionLabel";

const facts = [
  { k: "2021", v: "First state to recognize DAO LLCs" },
  { k: "0%", v: "State corporate income tax" },
  { k: "$60", v: "Annual report minimum" },
  { k: "Agent", v: "Algorithmic member eligibility" },
];

export function Wyoming() {
  return (
    <section id="wyoming" className="relative bg-paper-2">
      <div className="mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1fr] lg:gap-20">
          <div className="flex flex-col">
            <SectionLabel index="05" label="Jurisdiction" />
            <h2 className="mt-4 text-balance text-[34px] font-medium leading-[1.05] tracking-[-0.02em] sm:text-[42px] lg:text-[48px]">
              Why Wyoming.
            </h2>
            <p className="mt-6 max-w-md text-[15px] leading-[1.6] text-muted">
              Wyoming was the first jurisdiction to recognize DAO LLCs and let an
              autonomous agent serve as the managing member — with a human
              guardian retaining ultimate authority. Your on-chain spending policy
              becomes the operating agreement, bound by law-to-code.
            </p>

            <dl className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border hairline-strong bg-line-strong">
              {facts.map((f) => (
                <div key={f.k} className="bg-paper px-5 py-5">
                  <dt className="font-medium tabular-nums text-ink text-[22px] tracking-[-0.01em]">
                    {f.k}
                  </dt>
                  <dd className="mt-1 text-[12.5px] leading-[1.45] text-muted">
                    {f.v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <figure className="relative flex flex-col justify-center">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-6 -z-10 rounded-[28px] bg-gradient-to-br from-accent/10 via-transparent to-highlight/15 blur-2xl"
            />
            <div className="relative rounded-3xl border hairline-strong bg-paper p-8 lg:p-12">
              <svg
                aria-hidden
                viewBox="0 0 60 48"
                className="h-10 w-10 text-ink/15"
                fill="currentColor"
              >
                <path d="M0 48V28C0 12.5 9 2.5 24 0v8C13 10 8 16 8 26h12v22H0zm36 0V28C36 12.5 45 2.5 60 0v8c-11 2-16 8-16 18h12v22H36z" />
              </svg>

              <blockquote className="mt-6 font-serif text-[28px] leading-[1.18] text-ink lg:text-[34px]">
                Wyoming gave software legal standing. We made it{" "}
                <em className="font-serif italic">trivial</em> for an agent to
                operate within real rules.
              </blockquote>

              <figcaption className="mt-10 flex items-center gap-4 border-t hairline pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-paper">
                  <span className="font-serif text-[15px]">α</span>
                </div>
                <div>
                  <div className="text-[14px] font-medium text-ink">
                    Lena Whitfield
                  </div>
                  <div className="text-[12.5px] text-muted">
                    Co-founder · projectAlpha
                  </div>
                </div>
              </figcaption>
            </div>
          </figure>
        </div>
      </div>
    </section>
  );
}
