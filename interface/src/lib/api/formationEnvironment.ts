import type { PublicConfig } from "./types";

/**
 * WHICH FILING ENVIRONMENT THIS IS — four states, and two of them are "we don't know" (§2, the
 * honesty invariant).
 *
 * Every surface that says "demo, nothing is filed" or "the company legally exists" is answering
 * this one question, and every one of them used to answer it with its own two-valued predicate:
 * `publicConfig?.formationEnvironment !== "production"`. Two values cannot carry three facts, and
 * the value that got lost was the important one — a `/config` that had not answered yet, or had
 * failed, collapsed into "sandbox". So:
 *
 *   - A founder on a PRODUCTION deployment whose `/config` was still in flight (a cold cache, a
 *     slow box) read "Demo formation (sandbox) — nothing is filed with the State of Wyoming" and
 *     confirmed a real filing believing nothing real would happen.
 *   - The same founder, if `/config` had FAILED, was additionally offered the "Use the demo
 *     identity" button and a "Skip — no legal filing" affordance on a deployment that requires
 *     neither.
 *
 * Both directions are the same bug: an unknown answer rendered as a confident one. The fix is a
 * vocabulary that can say "unknown", plus the rule that unknown renders NEUTRAL — no demo wording,
 * no real-filing wording, and every consequential action disabled until the answer arrives.
 *
 * "loading" and "unknown" are kept apart because they differ for the USER, not for the logic: one
 * is a spinner that will resolve itself, the other is a retry button. Both are neutral.
 */
export type FormationEnvironment = "loading" | "unknown" | "sandbox" | "production";

/** True only for an answer we actually have. The gate every consequential action sits behind. */
export function isKnownEnvironment(
  environment: FormationEnvironment,
): environment is "sandbox" | "production" {
  return environment === "sandbox" || environment === "production";
}

/**
 * Normalise ONE reported environment value into the vocabulary.
 *
 * Anything that is not literally "sandbox" or "production" is `unknown` — including `null`,
 * `undefined`, and a value from a backend newer than this build. Deliberately not a default of
 * "sandbox": guessing "sandbox" is how a real filing gets labelled a demo, which is the failure
 * this whole module exists to prevent.
 */
export function formationEnvironmentOf(
  value: string | null | undefined,
): FormationEnvironment {
  if (value === "sandbox") return "sandbox";
  if (value === "production") return "production";
  return "unknown";
}

/**
 * The deployment's environment, from the state of the `GET /config` query.
 *
 * FAIL-SAFE by construction: an error is `unknown`, an absent field is `unknown`, and only data in
 * hand can produce a confident answer. The `isError` check comes first because a query that failed
 * may still be holding stale data from a previous success, and a stale answer is not one to make
 * a filing claim on.
 */
export function deriveFormationEnvironment(query: {
  data: PublicConfig | undefined;
  isError: boolean;
}): FormationEnvironment {
  if (query.isError) return "unknown";
  if (!query.data) return "loading";
  return formationEnvironmentOf(query.data.formationEnvironment);
}
