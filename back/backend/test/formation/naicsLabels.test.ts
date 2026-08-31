/**
 * The shipped industry labels (design §5) — a BUILD-TIME constant, and the properties the intake
 * relies on.
 */
import { expect, test } from "vitest";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { NAICS_LABELS, isKnownIndustryLabel } from "../../src/formation/naicsLabels";

test("the DEFAULT industry is one of the shipped labels", () => {
  // Every synthesized intake — the migration's, the A1 shim's — carries this label. If it were
  // not in the list, an edit-and-retry on a migrated company would be refused by our own door
  // for a value our own migration wrote.
  expect(NAICS_LABELS).toContain(DEFAULT_INDUSTRY);
  expect(isKnownIndustryLabel(DEFAULT_INDUSTRY)).toBe(true);
});

test("membership is exact after trim + NFC, and deliberately case-SENSITIVE", () => {
  expect(isKnownIndustryLabel(`  ${DEFAULT_INDUSTRY}  `)).toBe(true);
  // doola matches the label it published. Accepting a case variant here would store a string we
  // then send verbatim and doola then refuses.
  expect(isKnownIndustryLabel(DEFAULT_INDUSTRY.toUpperCase())).toBe(false);
  expect(isKnownIndustryLabel("Interpretive Dance")).toBe(false);
  expect(isKnownIndustryLabel("")).toBe(false);
});

test("the list has no blanks and no duplicates — the refresher's own guarantees", () => {
  expect(NAICS_LABELS.length).toBeGreaterThan(0);
  for (const l of NAICS_LABELS) expect(l).toBe(l.normalize("NFC").trim());
  expect(new Set(NAICS_LABELS).size).toBe(NAICS_LABELS.length);
});
