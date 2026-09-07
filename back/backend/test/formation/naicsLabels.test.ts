/**
 * The shipped industry labels (design §5) — a BUILD-TIME constant, and the properties the intake
 * relies on.
 */
import { expect, test } from "vitest";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import {
  LABEL_LIST_CAP,
  NAICS_LABELS,
  describeIndustryLabels,
  isKnownIndustryLabel,
} from "../../src/formation/naicsLabels";

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

test("the label list is rendered CAPPED, by one function both surfaces use", () => {
  // Today's list is one label and the cap does nothing. The day `refresh-naics.mts` runs against
  // a real sandbox key it becomes a few hundred federal labels, and there are two surfaces that
  // name them: the REST refusal (REST's only discovery surface for this field) and MCP's tool
  // description (an agent's). Uncapped, the second is a description that crowds out every other
  // tool in the client's context window, paid for on every request.
  expect(describeIndustryLabels()).toBe(NAICS_LABELS.join(", "));
  expect(describeIndustryLabels()).not.toContain("more");

  // The behaviour once the list IS long, asked of the renderer itself — the parameter exists so
  // this can be asserted today rather than discovered the morning after the refresher runs.
  const many = Array.from({ length: LABEL_LIST_CAP + 5 }, (_, i) => `Label ${i}`);
  const rendered = describeIndustryLabels(many);
  expect(rendered).toContain("Label 0");
  expect(rendered).toContain(`Label ${LABEL_LIST_CAP - 1}`);
  expect(rendered).not.toContain(`Label ${LABEL_LIST_CAP}`);
  expect(rendered).toContain("…and 5 more");
});
