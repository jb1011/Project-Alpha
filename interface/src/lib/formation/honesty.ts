import {
  formationEnvironmentOf,
  isKnownEnvironment,
  type FormationEnvironment,
} from "@/lib/api/formationEnvironment";
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

/**
 * The legal-body step's HEADING, and the one word in it that is a claim.
 *
 * "(demo filing)" is an assertion about what will actually happen, and once a company has been
 * picked or created it is an assertion about THAT COMPANY — whose `environment` is stamped at
 * creation and immutable after. The header derived it from `/config` instead, so a user attaching
 * an agent to a company they had minted in sandbox, on a box since re-pointed at production, read
 * a heading that said nothing about a demo over a filing that is one. (And the reverse, which is
 * the worse direction: "demo filing" over a real Wyoming LLC.)
 *
 * Before anything is picked, the deployment's own answer IS the right one: the next action is to
 * create a company, and a new company takes the deployment's pin.
 *
 * A pure function because the interface runner is not a component runner, and because this is a
 * sentence that makes a legal claim — the kind that has to be assertable.
 */
export function legalBodyTitle(input: {
  environment: FormationEnvironment;
  /** A company is already picked or created — the header describes IT, not the deployment. */
  attached: boolean;
  /** Which branch the picker is on, when nothing is attached yet. */
  mode: "attach" | "create";
}): string {
  if (input.attached)
    return input.environment === "sandbox" ? "Legal body (demo filing)" : "Legal body";
  // Neither claim while the environment is unknown — the neutral state owns the screen.
  if (!isKnownEnvironment(input.environment)) return "Legal body";
  if (input.environment === "sandbox") return "Legal body (demo filing)";
  return input.mode === "attach"
    ? "Which company is this agent filed under?"
    : "Create the company this agent is filed under";
}

/**
 * The eight company words, in the OWNER's language.
 *
 * Deliberately not the backend's identifiers: `ready` means "paid for, not filed yet", which is a
 * sentence, and `none` never appears at all because the backend already turned it into `ready`.
 */
export const COMPANY_STATE_LABEL: Record<CompanyState, string> = {
  draft: "Draft",
  paying: "Awaiting payment",
  ready: "Ready to file",
  in_progress: "Filing in progress",
  filed: "Filed",
  complete: "Filed · EIN issued",
  failed: "Filing failed",
  abandoned: "Abandoned",
};

/**
 * THE COMPANY PILL, decided once — tone and words together (§2/§7).
 *
 * `CompanyStatePill` spelled the colour rule inline as `env !== "production" || !known`, which is
 * `companyTone` with the failed arm dropped and the vocabulary re-derived, and `CompanyDetail`
 * spelled a THIRD version as `environment !== "production"` — which collapses "we don't know"
 * into "demo", the wrong direction and the one this whole module exists to prevent. So the
 * decision is here, the components render it, and this is what the tests can reach.
 *
 * `state` and `environment` are `string` on purpose: they arrive from a backend that deploys
 * independently, and a word from a newer one must produce a labelled amber pill rather than a
 * blank badge or a type error.
 */
export function companyPill(
  state: CompanyState | string,
  environment: string,
): { tone: FilingTone; environment: FormationEnvironment; label: string; note: string } {
  const env = formationEnvironmentOf(environment);
  const tone = companyTone(env, state);
  const label = isKnownCompanyState(state) ? COMPANY_STATE_LABEL[state] : "Unrecognised state";
  return {
    tone,
    // The NORMALISED environment, returned rather than re-derived by each caller: the surfaces
    // that need "is this a demo?" separately from "may I claim anything?" would otherwise each
    // call `formationEnvironmentOf` again, which is the second spelling this function replaces.
    environment: env,
    // The demo word follows the ENVIRONMENT and the colour follows the TONE, because they answer
    // different questions: "is this a real register?" and "may this build claim anything?".
    label: env === "sandbox" ? `${label} (demo)` : label,
    // …and an environment nobody reported says so, rather than borrowing either wording.
    note: env === "unknown" || env === "loading" ? " · environment not reported" : "",
  };
}
