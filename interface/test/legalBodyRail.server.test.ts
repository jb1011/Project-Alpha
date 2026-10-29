/**
 * The rail, rendered as the server renders it: the onboarding wizard's, which the legal-body flow
 * shares, and the flow's own.
 *
 * The wizard's rail is pinned byte for byte as it rendered before the rail took a word for its
 * current step, so the shared component never changes the wizard. The flow's rail says "In
 * progress" under the current step everywhere but on the done page, where the last step is ticked
 * and nothing is in progress.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LegalBodyRail } from "@/components/legalBody/LegalBodyRail";
import { Stepper } from "@/components/onboarding/Stepper";
import { visiblePhases } from "@/components/onboarding/types";
import type { LegalBodyConfig } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { railCurrentOf, railDoneOf, visibleLegalBodyPhases } from "@/lib/legalBody/phases";

/** The wizard's rail on its custody step, three steps done, as it rendered before the change. */
const WIZARD_CUSTODY_RAIL =
  "<nav aria-label=\"Onboarding progress\"><div class=\"mb-5 text-[11px] uppercase tracking-[0.2em] text-muted-2\">Create your agent</div><ol class=\"flex flex-col gap-1\">" +
  "<li class=\"relative\"><button type=\"button\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-paper-2/70\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors border-accent/50 bg-accent text-paper\"><svg viewBox=\"0 0 16 16\" fill=\"none\" class=\"h-3.5 w-3.5\" aria-hidden=\"true\"><path d=\"M3.5 8.5l3 3 6-7\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></path></svg></span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-muted\">Wallet &amp; passkey</span></span></button></li>" +
  "<li class=\"relative\"><button type=\"button\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-paper-2/70\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors border-accent/50 bg-accent text-paper\"><svg viewBox=\"0 0 16 16\" fill=\"none\" class=\"h-3.5 w-3.5\" aria-hidden=\"true\"><path d=\"M3.5 8.5l3 3 6-7\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></path></svg></span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-muted\">Accountable human</span></span></button></li>" +
  "<li class=\"relative\"><button type=\"button\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-paper-2/70\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors border-accent/50 bg-accent text-paper\"><svg viewBox=\"0 0 16 16\" fill=\"none\" class=\"h-3.5 w-3.5\" aria-hidden=\"true\"><path d=\"M3.5 8.5l3 3 6-7\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></path></svg></span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-muted\">Legal body</span></span></button></li>" +
  "<li class=\"relative\"><button type=\"button\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors border-accent bg-accent/15 text-accent-soft\">4</span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-ink\">Key custody</span><span class=\"mt-0.5 text-[10.5px] uppercase tracking-[0.14em] text-accent-soft/80\">In progress</span></span></button></li>" +
  "<li class=\"relative\"><button type=\"button\" disabled=\"\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors cursor-default\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors hairline-strong bg-paper text-muted-2\">5</span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-muted-2\">Define agent</span></span></button></li>" +
  "<li class=\"relative\"><button type=\"button\" disabled=\"\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors cursor-default\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors hairline-strong bg-paper text-muted-2\">6</span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-muted-2\">Operating agreement</span></span></button></li>" +
  "<li class=\"relative\"><button type=\"button\" disabled=\"\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors cursor-default\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors hairline-strong bg-paper text-muted-2\">7</span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-muted-2\">Deploy on-chain</span></span></button></li>" +
  "<li class=\"relative\"><button type=\"button\" disabled=\"\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors cursor-default\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors hairline-strong bg-paper text-muted-2\">8</span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-muted-2\">Fund treasury</span></span></button></li>" +
  "<li class=\"relative\"><button type=\"button\" disabled=\"\" class=\"group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors cursor-default\"><span class=\"relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors hairline-strong bg-paper text-muted-2\">9</span><span class=\"flex flex-col\"><span class=\"text-[13px] leading-tight transition-colors text-muted-2\">Live</span></span></button></li>" +
  "</ol><div class=\"mt-7 rounded-xl hairline bg-paper-2/40 px-3.5 py-3 text-[11.5px] leading-[1.5] text-muted-2\"><span class=\"text-muted\">Guardian controlled.</span> SIWE sign-in, passkey ceremony, and one guardian transaction per allowlist address. Treasury funding needs no user signature.</div></nav>";

const wizardRail = (extra: Record<string, unknown> = {}) =>
  renderToString(
    createElement(Stepper, {
      phases: visiblePhases(true),
      current: "custody",
      done: { welcome: true, guardian: true, "legal-body": true },
      onJump: () => {},
      ...extra,
    }),
  );

const config: Extract<LegalBodyConfig, { available: true }> = {
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: 5042002,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  factory: "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456",
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
};

/** The flow's rail for a thread on `phase`, as the shell renders it. */
function flowRail(phase: "identity" | "done"): string {
  const phases = visibleLegalBodyPhases(config);
  const derivation = { phase };
  return renderToString(
    createElement(LegalBodyRail, {
      phases,
      current: railCurrentOf("flow", derivation),
      done: railDoneOf(phases, "flow", derivation),
      onJump: () => {},
    }),
  );
}

/** The labels of the rail's steps that show a tick, in order. */
function ticked(m: string): string[] {
  return [...m.matchAll(/<li[\s\S]*?<\/li>/g)]
    .filter(([li]) => li.includes("<svg"))
    .map(([li]) =>
      li
        .replace(/<[^>]*>/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, " ")
        .trim(),
    );
}

describe("the wizard's rail", () => {
  test("renders byte for byte as before", () => {
    expect(wizardRail()).toBe(WIZARD_CUSTODY_RAIL);
  });

  test("its current step still reads In progress, once", () => {
    expect(wizardRail().split("In progress").length - 1).toBe(1);
  });
});

describe("the flow's rail", () => {
  test("on a step in progress: In progress under it, in the flow's words", () => {
    const m = flowRail("identity");
    expect(m.split(LEGAL_BODY_COPY.rail.inProgress).length - 1).toBe(1);
    expect(m).toContain(LEGAL_BODY_COPY.rail.heading);
    expect(m).toContain(LEGAL_BODY_COPY.rail.footer);
  });

  test("on the done page: Done is ticked, and nothing reads In progress", () => {
    const m = flowRail("done");
    expect(m).not.toContain("In progress");
    expect(m).toContain(LEGAL_BODY_COPY.rail.labels.done);
    const labels = visibleLegalBodyPhases(config).map((p) => p.label);
    expect(ticked(m)).toEqual(labels);
  });

  test("before the done page, Done is not ticked", () => {
    expect(ticked(flowRail("identity"))).not.toContain(LEGAL_BODY_COPY.rail.labels.done);
  });
});
