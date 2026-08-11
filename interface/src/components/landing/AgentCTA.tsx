import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";

export function AgentCTA() {
  return (
    <section
      id="agents"
      className="relative overflow-hidden bg-ink-grain text-ink"
    >
      <div
        aria-hidden
        className="absolute inset-0 ink-grid pointer-events-none"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hero-mesh-dark anim-mesh opacity-90"
      />

      <div className="relative mx-auto max-w-[1240px] px-6 py-28 lg:px-10 lg:py-36">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <Reveal variant="scale">
            <SectionLabel index="06" label="Guardian controlled" tone="paper" />
          </Reveal>

          <Reveal delay={120} variant="pop" duration={760}>
            <h2 className="mt-5 text-balance text-[42px] font-medium leading-[1.02] tracking-[-0.025em] text-ink sm:text-[56px] lg:text-[72px]">
              Your passkey. Your rules. Your agent.
            </h2>
          </Reveal>

          <Reveal delay={240} variant="up">
            <p className="mt-6 max-w-xl text-pretty text-[16px] leading-[1.6] text-muted-dark lg:text-[17.5px]">
              Sign in with your wallet, create a guardian passkey, and sign one
              transaction per allowlist address. Treasury funding needs no user
              signature. After that, your agent runs within the limits you set.
              You stay the guardian: pause, veto, or recover funds at any time.
            </p>
          </Reveal>

          <Reveal delay={360} variant="pop">
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <a
                href="/onboarding"
                className="group inline-flex items-center gap-2 rounded-full bg-paper px-6 py-3.5 text-[14.5px] font-medium text-ink transition-all duration-300 hover:bg-paper-2 hover:scale-[1.04] active:scale-[0.98]"
              >
                <span>Start onboarding</span>
                <span
                  aria-hidden
                  className="transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </a>
              <a
                href="#how"
                className="inline-flex items-center gap-2 rounded-full border hairline-dark-strong px-6 py-3.5 text-[14.5px] text-ink transition-all duration-300 hover:bg-ink-3 hover:scale-[1.04] active:scale-[0.98]"
              >
                See the seven steps
              </a>
            </div>
          </Reveal>

          <Reveal delay={480} variant="up">
            <div className="mt-10 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 text-[12.5px] text-muted-dark">
              <span className="inline-flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-soft" />
                Custody choice built in
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-soft" />
                On-chain cap + software gates
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-soft" />
                Guardian controls built in
              </span>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
