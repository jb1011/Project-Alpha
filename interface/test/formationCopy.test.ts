/**
 * THE FORMATION COPY, served-or-fallback (design §7).
 *
 * `/config.formationCopy` is the authority — every sentence in it makes a claim about what the
 * backend does, and copy in a bundle drifts from the code that keeps it. What was wrong was the
 * absence case, answered three different ways, and one of the three took a FIELD away:
 *
 *  - the SSN input was gated on `copy?.ssn`, so a deployment whose `/config` predates
 *    `formationCopy` rendered a production create form with no SSN box at all — silently filing
 *    every US person under the slow EIN route they were never offered a choice about;
 *  - a parked filing rendered a bare fallback heading with neither explanatory sentence;
 *  - the dashboard card carried a fourth hand-written paraphrase of the same three parks.
 */
import { expect, test } from "vitest";
import {
  FALLBACK_FORMATION_COPY,
  formationCopyOf,
  parkSummary,
  type FormationCopy,
  type ParkKey,
} from "@/lib/formation/copy";
import type { PublicConfig } from "@/lib/api/types";

const PARKS: ParkKey[] = ["awaitingIntakeEdit", "awaitingPartyEdit", "awaitingSsnDecision"];

/** A `/config` from a backend that predates `formationCopy` — every field absent. */
const bare: PublicConfig = { walletProviderDefault: "circle", circleCustodyAvailable: true };

test("A3: a config with NO formationCopy still yields an SSN label, help and retention line", () => {
  // The field is rendered on the ENVIRONMENT, and it renders with these words. A form that hides
  // the fast-EIN route because a sentence has not arrived is not degrading gracefully.
  const copy = formationCopyOf(bare);
  expect(copy.ssn.label).toBeTruthy();
  expect(copy.ssn.help).toBeTruthy();
  expect(copy.ssn.retention).toBeTruthy();
  // …and the retention line still makes the promise the backend actually keeps.
  expect(copy.ssn.retention).toMatch(/7 days/);
});

test("A3: a config with NO formationCopy still yields all three park titles AND sentences", () => {
  const copy = formationCopyOf(bare);
  for (const key of PARKS) {
    expect(copy.park[key].title, key).toBeTruthy();
    expect(copy.park[key].what, key).toBeTruthy();
    expect(copy.park[key].youCan, key).toBeTruthy();
  }
  // The three are DIFFERENT sentences: they have three different exits, and pointing somebody at
  // the wrong form is worse than saying nothing.
  const titles = PARKS.map((k) => copy.park[k].title);
  expect(new Set(titles).size).toBe(3);
});

test("A3: an undefined config (nothing fetched yet) falls back rather than throwing", () => {
  expect(formationCopyOf(undefined)).toEqual(FALLBACK_FORMATION_COPY);
  expect(formationCopyOf(bare).reuseDisclosure).toBe(FALLBACK_FORMATION_COPY.reuseDisclosure);
});

test("A3: SERVED copy wins, field by field — the backend is the authority on its own claims", () => {
  const served: FormationCopy = {
    ...FALLBACK_FORMATION_COPY,
    ssn: { label: "SSN (served)", help: "served help", retention: "served retention" },
  };
  const copy = formationCopyOf({ ...bare, formationCopy: served });
  expect(copy.ssn.label).toBe("SSN (served)");
  // …and a field the served object did not carry falls back rather than dragging the rest down
  // with it: a backend shipping one sentence before another must not look as if it shipped none.
  const partial = { ...served, park: undefined } as unknown as FormationCopy;
  const merged = formationCopyOf({ ...bare, formationCopy: partial });
  expect(merged.ssn.label).toBe("SSN (served)");
  expect(merged.park.awaitingPartyEdit.title).toBe(
    FALLBACK_FORMATION_COPY.park.awaitingPartyEdit.title,
  );
});

test("A3: the dashboard's one-liner is DERIVED from the same table, not a fourth paraphrase", () => {
  const copy = formationCopyOf(bare);
  for (const key of PARKS) expect(parkSummary(copy, key)).toBe(copy.park[key].title);
});
