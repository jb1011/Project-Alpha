import Link from "next/link";
import { SectionLabel } from "@/components/landing/SectionLabel";
import { Nav } from "@/components/landing/Nav";
import { Footer } from "@/components/landing/Footer";

export default function PersonhoodPage() {
  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <main className="flex flex-1 flex-col">
        <section className="relative bg-paper">
          <div className="mx-auto max-w-[840px] px-6 py-20 lg:px-10 lg:py-28">
            <SectionLabel index="01" label="Proof of personhood" />
            <h1 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] sm:text-[48px]">
              How proof of personhood works
            </h1>
            <p className="mt-5 max-w-2xl text-[16px] leading-[1.6] text-muted">
              Wyoming DAO LLCs require a natural person behind every agent. Novi
              Corpus uses World ID to prove one unique human per account without
              storing your name, document, or face.
            </p>
          </div>
        </section>

        <section className="border-t hairline bg-paper-2">
          <div className="mx-auto max-w-[840px] px-6 py-16 lg:px-10 lg:py-20">
            <h2 className="text-[24px] font-medium tracking-[-0.01em]">At onboarding</h2>
            <p className="mt-4 text-[15px] leading-[1.65] text-muted">
              During the Accountable human step, you verify with World ID using
              the World App (orb or NFC passport credential). We store a
              nullifier hash to ensure one human per account. We never store
              your name, government ID, or biometric data.
            </p>
            <p className="mt-4 text-[15px] leading-[1.65] text-muted">
              Learn more at{" "}
              <a
                href="https://world.org/world-id"
                target="_blank"
                rel="noreferrer"
                className="text-accent underline-offset-2 hover:underline"
              >
                world.org/world-id
              </a>
              .
            </p>
          </div>
        </section>

        <section className="border-t hairline bg-paper">
          <div className="mx-auto max-w-[840px] px-6 py-16 lg:px-10 lg:py-20">
            <h2 className="text-[24px] font-medium tracking-[-0.01em]">Identity Check step-up</h2>
            <p className="mt-4 text-[15px] leading-[1.65] text-muted">
              On the guardian page, an optional Identity Check attestation confirms
              you are over 18 for formation readiness. We learn exactly one extra
              bit: age eligibility. No document images are retained.
            </p>
          </div>
        </section>

        <section className="border-t hairline bg-paper-2">
          <div className="mx-auto max-w-[840px] px-6 py-16 lg:px-10 lg:py-20">
            <h2 className="text-[24px] font-medium tracking-[-0.01em]">AgentBook on World Chain</h2>
            <p className="mt-4 text-[15px] leading-[1.65] text-muted">
              AgentBook answers a simple question: does a verified human publicly
              answer for this wallet? Live reads on World Chain power the buyer
              trust dial tier &ldquo;verified sellers only&rdquo; and the dashboard
              &ldquo;human-backed&rdquo; chip.
            </p>
            <p className="mt-4 text-[15px] leading-[1.65] text-muted">
              When your agent pays via x402, the World agentkit fronts every buy
              so sellers can see an accountable buyer backed by a verified human.
            </p>
          </div>
        </section>

        <section className="border-t hairline bg-paper">
          <div className="mx-auto max-w-[840px] px-6 py-16 lg:px-10 lg:py-20">
            <h2 className="text-[24px] font-medium tracking-[-0.01em]">Guardian accountability</h2>
            <p className="mt-4 text-[15px] leading-[1.65] text-muted">
              World ID proves someone answers for the agent. Novi Corpus makes
              them answerable: the agent pays from a governed treasury with
              spending caps, a Wyoming DAO LLC operating agreement, and a guardian
              with on-chain pause and clawback.
            </p>
            <p className="mt-4 text-[15px] leading-[1.65] text-muted">
              AgentBook registration is permanent by design. Liability that can
              actually be enforced is the part we add through guardian controls
              and legal structure.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/onboarding"
                className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-3 text-[14px] font-medium text-paper hover:bg-ink-hover transition-colors"
              >
                Start onboarding
              </Link>
              <Link
                href="/guardian"
                className="inline-flex items-center gap-2 rounded-full border hairline-strong px-5 py-3 text-[14px] text-ink hover:bg-paper-2 transition-colors"
              >
                Guardian verification
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
