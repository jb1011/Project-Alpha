"use client";

import { formationEnvironmentOf } from "@/lib/api/formationEnvironment";
import { isKnownCompanyState, type CompanyState } from "@/lib/api/types";
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
 * Rendered by the reuse picker, the Companies list and the Companies detail page, so that the
 * three cannot describe the same row differently.
 */
export function CompanyStatePill({
  state,
  environment,
}: {
  state: CompanyState | string;
  environment: string;
}) {
  const env = formationEnvironmentOf(environment);
  const known = isKnownCompanyState(state);
  const label = known ? STATE_LABEL[state] : "Unrecognised state";

  // Amber covers sandbox, unknown environments and unknown states — everything that is not a
  // confirmed real filing in a word this build understands.
  if (env !== "production" || !known)
    return (
      <AmberPill>
        {env === "sandbox" ? `${label} (demo)` : label}
        {env === "unknown" || env === "loading" ? " · environment not reported" : ""}
      </AmberPill>
    );

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border hairline-strong bg-paper-3/60 px-3 py-1 text-[11.5px]",
        state === "failed" || state === "abandoned" ? "text-[#ff8a84]" : "text-muted-2",
        state === "filed" || state === "complete" ? "text-emerald-300" : "",
      )}
    >
      {label}
    </span>
  );
}

/**
 * The eight words, in the owner's language.
 *
 * Deliberately NOT the backend's identifiers: `ready` means "paid for, not filed yet", which is a
 * sentence, and `none` never appears at all because the backend already turned it into `ready`.
 */
const STATE_LABEL: Record<CompanyState, string> = {
  draft: "Draft",
  paying: "Awaiting payment",
  ready: "Ready to file",
  in_progress: "Filing in progress",
  filed: "Filed",
  complete: "Filed · EIN issued",
  failed: "Filing failed",
  abandoned: "Abandoned",
};
