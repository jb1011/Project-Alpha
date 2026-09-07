/**
 * The doola INDUSTRY LABELS a company may be filed under — a BUILD-TIME constant (design §5).
 *
 * ⚠ GENERATED FILE. Refresh it with:
 *
 *     DOOLA_API_KEY=dk_test_… npx tsx scripts/refresh-naics.mts
 *
 * and commit the result. Do not hand-edit the array: the point of the script is that the list is
 * doola's, verbatim, and a hand-edited entry is a label we invented and a filing doola will
 * reject.
 *
 * Why a constant and not a lookup: `industry` is chosen at the very TOP of the create-company
 * funnel. A partner round trip there is a form that cannot render when doola is slow, plus a
 * cache with a TTL nobody specified and a staleness nobody can observe. The list is a federal
 * reference table that changes about as often as NAICS itself does, so it belongs in the build.
 *
 * ── STATE OF THIS FILE (2026-08-31) ────────────────────────────────────────────────────────
 *
 * It holds the ONE label that has actually been verified against doola's reference endpoint
 * (live sandbox 2026-08-21, maps to NAICS 541511) — because no sandbox key was available when
 * A2 was written, and a list of plausible-looking labels is worse than a short true one: an
 * unverified label passes our validation, reaches doola, and comes back `rejected`, which burns
 * an attempt on a company a human then has to look at.
 *
 * The OpenAPI document's example for `industry` is "Custom Computer Programming Services" (the
 * official NAICS 541511 title). It is deliberately NOT in the array: it is a documentation
 * example, not an observed value of the reference table, and the same code already answers to
 * "Software development".
 *
 * **Run the refresher before A3 ships the industry picker** — until then the picker has one
 * option, which is honest but not a product.
 */

/** Every label the create-company endpoint accepts, exactly as doola spells it. */
export const NAICS_LABELS: readonly string[] = ["Software development"];

/** O(1) membership, built once. The list is short today and long after a refresh. */
const LABEL_SET = new Set(NAICS_LABELS);

/**
 * Is this one of the shipped labels?
 *
 * EXACT, after a trim and an NFC normalize — the same canonicalization the intake applies before
 * storing, so "accepted at the door" and "stored" cannot disagree. Deliberately case-SENSITIVE:
 * doola matches the label it published, and a case-folded accept here would store a string we
 * then send verbatim and doola then refuses.
 */
export function isKnownIndustryLabel(label: string): boolean {
  return LABEL_SET.has(label.normalize("NFC").trim());
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
