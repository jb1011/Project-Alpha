import { describe, expect, test } from "vitest";
import { LANDING, ONBOARDING_STEP_COUNT } from "@/components/landing/copy";

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

const sentences = stringsOf(LANDING);

describe("landing copy", () => {
  test("matches the onboarding step count", () => {
    expect(LANDING.steps).toHaveLength(ONBOARDING_STEP_COUNT);
  });

  test("no sentence carries a dash", () => {
    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(/[\u2012\u2013\u2014-]/);
    }
  });

  test("does not present this deployment as a real filing", () => {
    const joined = sentences.join("\n");
    expect(joined).toContain("nothing here is a filing");
    expect(joined).toContain("Real filings are not on yet");
    expect(joined).toContain("test money");
  });
});
