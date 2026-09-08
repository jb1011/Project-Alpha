import { canonicalizeIntakeText } from "./intake";
import { NAICS_LABELS } from "./naicsLabelsData";

/**
 * The doola INDUSTRY LABELS a company may be filed under (design §5) — everything ABOUT the list.
 *
 * The list itself is `naicsLabelsData.ts`, which `scripts/refresh-naics.mts` overwrites wholesale.
 * This file is hand-written and stable: the generator never touches it, so a fix made here is not
 * silently reverted the next time somebody refreshes the labels, and the refresh PR is a diff of
 * an array rather than a hundred lines of unchanged prose a reviewer has to re-read.
 *
 * Why a constant and not a lookup: `industry` is chosen at the very TOP of the create-company
 * funnel. A partner round trip there is a form that cannot render when doola is slow, plus a
 * cache with a TTL nobody specified and a staleness nobody can observe. The list is a federal
 * reference table that changes about as often as NAICS itself does, so it belongs in the build.
 *
 * ── STATE OF THE LIST (2026-09-07) ─────────────────────────────────────────────────────────
 *
 * doola's FULL reference table, 821 labels, pulled from the live sandbox
 * (`GET /references/naics-codes`) by `scripts/refresh-naics.mts` on 2026-09-07. Before that
 * refresh the array held the single label verified by hand in A1 ("Software development", live
 * sandbox 2026-08-21, NAICS 541511), because a list of plausible-looking labels is worse than a
 * short true one: an unverified label passes our validation, reaches doola, and comes back
 * `rejected`, which burns an attempt on a company a human then has to look at.
 *
 * Every label in the array is therefore a value doola itself published, not a guess and not a
 * documentation example — the OpenAPI document's `industry` sample ("Custom Computer Programming
 * Services", the official NAICS 541511 title) is in the array only if doola's own table has it.
 *
 * A3's industry picker reads the list from `GET /formation/rules`, which serves this array
 * verbatim. That is a separate route rather than a field on `/config` deliberately: `/config` is
 * unauthenticated, fetched by every page in the interface, and cached for the life of the tab —
 * 821 labels on it would be ~20 KB paid for by the landing page to serve one form.
 */

export { NAICS_LABELS };

/** O(1) membership, built once, over the canonical form the check compares against. */
const LABEL_SET = new Set(NAICS_LABELS.map((l) => canonicalizeIntakeText(l)));

/**
 * Is this one of the shipped labels?
 *
 * EXACT, after `canonicalizeIntakeText` — the SAME canonicalization the intake applies before
 * storing, called rather than re-spelled, so "accepted at the door" and "stored" cannot disagree.
 * Deliberately case-SENSITIVE: doola matches the label it published, and a case-folded accept
 * here would store a string we then send verbatim and doola then refuses.
 */
export function isKnownIndustryLabel(label: string): boolean {
  return LABEL_SET.has(canonicalizeIntakeText(label));
}

/**
 * The labels as a human-readable list, CAPPED.
 *
 * Two surfaces name them — the REST refusal (which is REST's only discovery surface for the one
 * enumerated field) and the MCP tool description (which is an agent's) — and both have the same
 * problem the day the refresher runs: this list is a federal reference table, and a few hundred
 * labels is an error message nobody reads and a tool description that crowds out the rest of the
 * tool. Eight and a count, in one place, so the two surfaces cannot cap differently.
 */
export const LABEL_LIST_CAP = 8;

export function describeIndustryLabels(labels: readonly string[] = NAICS_LABELS): string {
  const shown = labels.slice(0, LABEL_LIST_CAP);
  const rest = labels.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, …and ${rest} more` : "");
}
