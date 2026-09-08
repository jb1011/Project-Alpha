"use client";

import type { CompanyState } from "@/lib/api/types";
import { companyPill, mayRenderConfirmed } from "@/lib/formation/honesty";
import { AmberPill, cx } from "@/components/onboarding/primitives";

/**
 * ONE company's state, as a badge — and the honesty invariant applied to it (§2/§7).
 *
 * The rule is the `FormationCard` rule, restated for the eight-word vocabulary: **green is a
 * claim that a real company exists in a real register, and it requires an explicit
 * `production`.** A sandbox company is amber. A company whose environment this build cannot read
 * is amber too — the one thing worse than calling a real filing a demo is calling an unverifiable
 * one real. And a STATE this build has never heard of (a value from a newer backend) is amber
 * with its own wording, never a blank badge.
 *
 * ⚠ The DECISION is `companyPill`, not this file. This component spelled the colour rule inline
 * as `env !== "production" || !known` — which is `companyTone` with the failed arm dropped and
 * the vocabulary re-derived — while `CompanyDetail` spelled a third version that collapsed
 * "unknown" into "demo". Three spellings of one invariant is three chances for one of them to
 * render green over a sandbox company; this one renders what the shared function decided.
 */
export function CompanyStatePill({
  state,
  environment,
}: {
  state: CompanyState | string;
  environment: string;
}) {
  const { tone, label, note } = companyPill(state, environment);

  // RED first, and independent of the environment: a filing that failed says so whether it was a
  // demo or not. Dressing it as amber-but-fine would hide the one state that needs a human, and a
  // sandbox failure is still a failure of the thing being demonstrated.
  if (tone === "failed")
    return (
      <span className={cx(PILL, "text-[#ff8a84]")}>
        {label}
        {note}
      </span>
    );

  // Amber covers sandbox, unknown environments and unknown states — everything that is not a
  // confirmed real filing in a word this build understands.
  if (!mayRenderConfirmed(tone))
    return (
      <AmberPill>
        {label}
        {note}
      </AmberPill>
    );

  return (
    <span
      className={cx(PILL, state === "filed" || state === "complete" ? "text-emerald-300" : "text-muted-2")}
    >
      {label}
    </span>
  );
}

const PILL =
  "inline-flex items-center gap-1.5 rounded-full border hairline-strong bg-paper-3/60 px-3 py-1 text-[11.5px]";
