/**
 * Regenerate `src/formation/naicsLabelsData.ts` from doola's reference table (design §5).
 *
 *     DOOLA_API_KEY=dk_test_… npx tsx scripts/refresh-naics.mts
 *
 * The industry label is chosen at the very top of the create-company funnel, so the list ships as
 * a BUILD-TIME constant rather than a request-time lookup: no partner round trip in the form, no
 * cache with an unspecified TTL, no staleness nobody can observe. This script is the only thing
 * that writes that file, and `listNaicsCodes` exists on the client only for this script.
 *
 * It writes a DATA-ONLY module. The behaviour that reads the list — the membership check, the
 * capped renderer, the prose — is hand-written in `naicsLabels.ts`, which this never touches: a
 * generator that also emits behaviour silently reverts any fix to that behaviour the next time
 * somebody refreshes the labels, and buries the one line that changed in a hundred that did not.
 *
 * SANDBOX-GUARDED like every other probe in this directory. Not because a GET is dangerous — it
 * is the one reference call that costs nothing — but because a production key in a developer's
 * shell is the shape of the accident, and every script here refuses one for the same reason.
 * A production key CAN be used deliberately with `ALLOW_PRODUCTION_KEY=1`; the reference table
 * is documented as the same table in both environments, so there should never be a need.
 *
 * NOT a test: it needs a live key and it WRITES a source file, so it never runs in CI, and no
 * test in this repo makes a live doola call.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDoolaApi } from "../src/adapters/doola/doolaClient";
import { DOOLA_BASE_URLS } from "../src/config/env";
import { DEFAULT_INDUSTRY, canonicalizeIntakeText } from "../src/formation/intake";

const apiKey = process.env.DOOLA_API_KEY;
if (!apiKey) throw new Error("DOOLA_API_KEY is required (sandbox key: dk_test_…)");
if (!apiKey.startsWith("dk_test_") && process.env.ALLOW_PRODUCTION_KEY !== "1")
  throw new Error(
    "refusing to run with a non-sandbox key: set ALLOW_PRODUCTION_KEY=1 if that is deliberate (the reference table is the same in both environments)",
  );

const environment = apiKey.startsWith("dk_test_") ? "sandbox" : "production";
const api = buildDoolaApi({
  apiKey,
  baseUrl: process.env.DOOLA_BASE_URL ?? DOOLA_BASE_URLS[environment],
  environment,
});

/** The DATA file, and only the data file. `naicsLabels.ts` beside it is hand-written and is
 *  never touched by this script — see the header it emits for why. */
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../src/formation/naicsLabelsData.ts");

function render(labels: string[]): string {
  return `/**
 * ⚠ GENERATED FILE — DO NOT EDIT. Regenerate with:
 *
 *     DOOLA_API_KEY=dk_test_… npx tsx scripts/refresh-naics.mts
 *
 * DATA ONLY, deliberately. Everything that READS this list — the membership check, the capped
 * renderer, and the prose explaining why the list is a build-time constant at all — lives in the
 * hand-written \`naicsLabels.ts\` beside it, which imports this. Keeping them apart means a
 * refresh is a diff of the array and nothing else: a generator that also emits behaviour is a
 * generator that silently reverts a fix to that behaviour the next time somebody runs it, and the
 * reviewer of the refresh PR has to re-read a hundred lines of unchanged prose to notice.
 *
 * Generated ${new Date().toISOString().slice(0, 10)} from the ${environment} reference table: ${labels.length} label${labels.length === 1 ? "" : "s"}.
 */

/** Every label the create-company endpoint accepts, exactly as doola spells it. */
export const NAICS_LABELS: readonly string[] = ${JSON.stringify(labels, null, 2)};
`;
}

async function main() {
  const rows = await api.listNaicsCodes();
  // Labels only, de-duplicated (NAICS has one label per code but doola's table may repeat a
  // label across codes) and sorted, so a re-run with no upstream change is a no-op diff.
  const labels = [
    ...new Set(
      rows
        // The SAME canonicalization the intake applies, called rather than re-spelled: a label
        // generated in one normal form and compared in another is a label the door refuses for
        // a reason nobody can see.
        .map((r) => canonicalizeIntakeText(r.industry ?? ""))
        .filter((s): s is string => s.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b, "en"));

  if (labels.length === 0)
    throw new Error("doola returned no industry labels — refusing to write an empty list");
  // The default is what every synthesized intake (the migration, the A1 shim) already carries.
  // If doola stops publishing it, EVERY migrated company holds a label the door would now
  // refuse — a fact to discover here rather than at the first edit-and-retry.
  if (!labels.includes(DEFAULT_INDUSTRY))
    throw new Error(
      `doola's reference table no longer contains DEFAULT_INDUSTRY ("${DEFAULT_INDUSTRY}") — every synthesized intake carries it. Pick a new default in src/formation/intake.ts FIRST, then re-run.`,
    );

  writeFileSync(OUT, render(labels), "utf8");
  console.log(`wrote ${labels.length} label(s) to ${OUT}`);
  console.log("run `npm run lint -- --write` and commit the result");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
