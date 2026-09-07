/**
 * ⚠ GENERATED FILE — DO NOT EDIT. Regenerate with:
 *
 *     DOOLA_API_KEY=dk_test_… npx tsx scripts/refresh-naics.mts
 *
 * DATA ONLY, deliberately. Everything that READS this list — the membership check, the capped
 * renderer, and the prose explaining why the list is a build-time constant at all — lives in the
 * hand-written `naicsLabels.ts` beside it, which imports this. Keeping them apart means a
 * refresh is a diff of the array and nothing else: a generator that also emits behaviour is a
 * generator that silently reverts a fix to that behaviour the next time somebody runs it, and the
 * reviewer of the refresh PR has to re-read a hundred lines of unchanged prose to notice.
 *
 * Generated 2026-08-21 from the sandbox reference table: 1 label.
 */

/** Every label the create-company endpoint accepts, exactly as doola spells it. */
export const NAICS_LABELS: readonly string[] = ["Software development"];
