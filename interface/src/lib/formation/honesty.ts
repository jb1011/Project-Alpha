import type { FormationEnvironment } from "@/lib/api/formationEnvironment";
import {
  isKnownCompanyState,
  isKnownFormationStatus,
  type CompanyState,
  type FormationStatus,
} from "@/lib/api/types";

/**
 * THE HONESTY INVARIANT, as a function (design §2 — the guardian-waiver precedent).
 *
 * **Green is a CLAIM: that a real company exists in a real register.** It therefore requires an
 * explicit `production` environment AND a status this build can actually read. Everything else is
 * amber — a sandbox filing, an environment we could not verify, and a state from a backend newer
 * than this bundle — because the one thing worse than calling a real filing a demo is calling an
 * unverifiable one real.
 *
 * It lives here, in a plain module, for two reasons. It is asserted by
 * `test/formationHonesty.test.ts`, and the interface runner is deliberately not a component runner
 * — everything worth asserting is a pure function a component calls, which is the constraint that
 * keeps it testable. And there are now THREE surfaces making this decision (the agent dashboard's
 * `FormationCard`, the Companies list and detail's `CompanyStatePill`, and the reuse picker inside
 * it); three copies of an invariant is three chances for one of them to render green over a
 * sandbox company.
 */
export type FilingTone =
  /** A confirmed production filing in a state this build knows. The ONLY green. */
  | "confirmed"
  /** A confirmed sandbox filing: real behaviour, no legal effect. */
  | "demo"
  /** The environment or the state could not be read. Neither claim may be made. */
  | "unverified"
  /** Nothing was filed and the step that would have filed it is in error. */
  | "failed";

export function filingTone(
  environment: FormationEnvironment,
  status: FormationStatus | string,
): FilingTone {
  // `failed` first, and independent of the environment: a filing that failed says so whether it
  // was a demo or not, and dressing it as amber-but-fine would hide the one state that needs a
  // human. A sandbox failure is still a failure of the thing being demonstrated.
  if (status === "failed") return "failed";
  if (environment === "sandbox") return "demo";
  if (environment !== "production") return "unverified";
  // Production, but a word this build has never heard of. Green here would be a claim made on
  // behalf of a backend we cannot read.
  return isKnownFormationStatus(status) ? "confirmed" : "unverified";
}

/** The same decision for the eight-word COMPANY vocabulary — one definition, two vocabularies. */
export function companyTone(
  environment: FormationEnvironment,
  state: CompanyState | string,
): FilingTone {
  if (state === "failed" || state === "abandoned") return "failed";
  if (environment === "sandbox") return "demo";
  if (environment !== "production") return "unverified";
  return isKnownCompanyState(state) ? "confirmed" : "unverified";
}

/**
 * May this surface render the CONFIRMED colour?
 *
 * The predicate every card asks, spelled once so no surface can answer it with `environment !==
 * "sandbox"` — the two-valued test that collapsed "we don't know" into "it's real".
 */
export function mayRenderConfirmed(tone: FilingTone): boolean {
  return tone === "confirmed";
}
