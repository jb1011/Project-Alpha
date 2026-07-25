"use client";

import * as React from "react";

/**
 * /proof — accountable-only commerce, demonstrated live.
 *
 * Public and self-running: two identities are sent against the real strict paywall server-side
 * (same store, same AgentBook reads, same price) and the transcript is rendered here. No wallet,
 * no session — a judge can watch the policy work without us present.
 */

type Leg = {
  actor: "bot" | "agent";
  status?: number;
  error?: string;
  detail?: string;
  how?: { register?: string; agentBook?: string; chain?: string };
  humanId?: string | null;
  rate?: string | null;
  invoice?: boolean;
  configured?: boolean;
};

type RunResult = {
  policy: string;
  resource: string;
  statement: string;
  legs: Leg[];
};

export default function ProofPage() {
  const [result, setResult] = React.useState<RunResult | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/backend/x402-demo/proof-run");
      if (res.status === 429) {
        setError("One run every 5 seconds — try again in a moment.");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResult((await res.json()) as RunResult);
    } catch (e) {
      setError(`The demonstration endpoint is unreachable: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, []);

  React.useEffect(() => {
    void run();
  }, [run]);

  const bot = result?.legs.find((l) => l.actor === "bot");
  const agent = result?.legs.find((l) => l.actor === "agent");

  return (
    <div className="min-h-screen bg-paper font-mono text-ink">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 hero-mesh-dark opacity-70" />
      <main className="mx-auto max-w-[1000px] px-5 py-14 lg:px-8">
        {/* Head */}
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-muted-2">
          <span className="font-mono text-muted">Novi Corpus × World</span>
          <span className="inline-block h-px w-6 bg-line-strong" />
          <span>Live demonstration</span>
        </div>
        <h1 className="mt-4 max-w-[24ch] text-balance text-[32px] font-medium leading-[1.08] tracking-[-0.025em] text-ink sm:text-[40px]">
          We don&apos;t trade with agents no one answers for.
        </h1>
        <p className="mt-4 max-w-[62ch] text-pretty text-[14px] leading-[1.65] text-muted">
          This seller&apos;s policy is <span className="text-ink">accountable-only</span>: an agent
          must prove a verified unique human stands behind it — via World&apos;s AgentBook, read
          live on World Chain — before its money is even accepted. Accountability first; then,
          and only then, commerce.
        </p>

        <div className="mt-6 flex items-center gap-4">
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="cursor-pointer rounded-full bg-ink px-5 py-2.5 text-[13.5px] font-medium text-paper transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            {running ? "Running…" : "Run it again"}
          </button>
          <span className="text-[11.5px] text-muted-2">
            Every run is live — real signatures, real AgentBook reads.
          </span>
        </div>

        {error && (
          <p className="mt-4 rounded-xl border border-[#febc2e]/30 bg-[#febc2e]/[0.07] px-4 py-3 text-[12.5px] text-[#f3cd72]">
            {error}
          </p>
        )}

        {/* The two identities */}
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <ActorPanel
            eyebrow="Identity one"
            title="An anonymous bot"
            subtitle="No human answers for this wallet."
            leg={bot}
            running={running && !result}
          >
            {bot && bot.status === 403 && (
              <>
                <Verdict tone="refused" code="403" label="REFUSED — money not accepted" />
                <p className="text-[12px] leading-[1.6] text-muted">
                  Payment would not have helped: the refusal is about accountability, not price.
                  The response even tells the bot how to become eligible —
                </p>
                <pre className="overflow-x-auto rounded-xl border hairline bg-paper/60 px-3.5 py-3 text-[11px] leading-[1.7] text-muted">
                  {JSON.stringify({ error: bot.error, how: bot.how }, null, 2)}
                </pre>
              </>
            )}
          </ActorPanel>

          <ActorPanel
            eyebrow="Identity two"
            title="A Novi Corpus agent"
            subtitle="Backed by a verified human, on the record."
            leg={agent}
            running={running && !result}
          >
            {agent?.configured === false && (
              <p className="text-[12px] leading-[1.6] text-muted-2">
                The demo agent&apos;s registered key isn&apos;t configured on this deployment yet.
              </p>
            )}
            {agent && agent.status === 402 && (
              <>
                <Verdict tone="cleared" code="402" label="CLEARED TO BUY — invoice issued" />
                {agent.humanId && (
                  <Fact label="AgentBook says" value={`human ${agent.humanId.slice(0, 18)}… answers for it`} />
                )}
                {agent.rate && <Fact label="Per-human budget" value={agent.rate} />}
                <p className="text-[12px] leading-[1.6] text-muted">
                  Proof accepted — now it pays like everyone else, from a treasury its guardian
                  can pause and claw back. Accountability grants no discount.
                </p>
              </>
            )}
            {agent && agent.status === 403 && (
              <>
                <Verdict tone="capped" code="403" label="REFUSED — not on the record yet" />
                <p className="text-[12px] leading-[1.6] text-muted">
                  Our own agent, refused like anyone else: its wallet isn&apos;t registered in
                  AgentBook yet, and this seller makes no exceptions — not even for us. The moment
                  its human registers it, this panel flips to an invoice.
                </p>
              </>
            )}
            {agent && agent.status === 429 && (
              <>
                <Verdict tone="capped" code="429" label="RATE-CAPPED — budget spent" />
                <p className="text-[12px] leading-[1.6] text-muted">
                  One human, one budget — spinning up more agents changes nothing. This is the
                  sybil resistance, visible.
                </p>
              </>
            )}
            {agent && agent.status === 0 && (
              <p className="text-[12px] leading-[1.6] text-[#f3cd72]">{agent.error}</p>
            )}
          </ActorPanel>
        </div>

        {/* The point */}
        <div className="mt-10 rounded-2xl border hairline bg-paper-2/40 p-6 sm:p-7">
          <h2 className="text-[10.5px] uppercase tracking-[0.24em] text-muted-2">Why this matters</h2>
          <div className="mt-3 grid gap-4 text-[12.5px] leading-[1.65] text-muted sm:grid-cols-3">
            <p>
              <span className="text-ink">World proves someone answers for the agent.</span> A live
              AgentBook read on World Chain — no name, no document, only unique personhood.
            </p>
            <p>
              <span className="text-ink">Novi Corpus makes them answerable.</span> The agent pays
              from a governed treasury: spending caps, a legal body, a guardian with on-chain
              pause and clawback.
            </p>
            <p>
              <span className="text-ink">AgentBook can never revoke; we can.</span> Their registry
              is permanent by design. Liability that can actually be enforced — that&apos;s the
              part we add.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function ActorPanel({
  eyebrow,
  title,
  subtitle,
  leg,
  running,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  leg?: Leg;
  running: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border hairline bg-paper-2/40 p-6 backdrop-blur-sm">
      <div className="text-[10.5px] uppercase tracking-[0.24em] text-muted-2">{eyebrow}</div>
      <h2 className="text-[19px] font-medium tracking-[-0.01em] text-ink">{title}</h2>
      <p className="text-[12px] text-muted-2">{subtitle}</p>
      <div className="mt-1 flex min-h-[120px] flex-col gap-3">
        {running && !leg ? <p className="text-[12px] text-muted-2">Contacting the seller…</p> : children}
      </div>
    </section>
  );
}

function Verdict({
  tone,
  code,
  label,
}: {
  tone: "refused" | "cleared" | "capped";
  code: string;
  label: string;
}) {
  const tones = {
    refused: "border-[#ff5f57]/40 bg-[#ff5f57]/10 text-[#ff8a84]",
    cleared: "border-[#febc2e]/40 bg-[#febc2e]/10 text-[#f3cd72]",
    capped: "border-line-strong bg-paper-3/70 text-muted",
  } as const;
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <span className="font-mono text-[18px] font-medium tabular-nums">{code}</span>
      <span className="text-[12px] uppercase tracking-[0.12em]">{label}</span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-l hairline-strong pl-3">
      <span className="text-[10.5px] uppercase tracking-[0.2em] text-muted-2">{label}</span>
      <span className="font-mono text-[12px] text-ink">{value}</span>
    </div>
  );
}
