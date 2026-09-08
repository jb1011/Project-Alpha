/**
 * How a legal document and a required-action code are RENDERED (design §7).
 *
 * All three of these lived twice — `humanDocType` and `formatBytes` in both the dashboard's
 * formation card and the company page, `requiredActionCopy` in the card while the company page
 * printed the bare code. Two copies of a formatter is cosmetic right up until they disagree, and
 * "the dashboard calls this an Operating Agreement and the company page calls it
 * OperatingAgreement" is a disagreement about a legal document.
 */
import { expect, test } from "vitest";
import { formatBytes, humanDocType, requiredActionCopy } from "@/lib/formation/documents";

test("a docType is split on case and on separators — never echoed from provider free text", () => {
  expect(humanDocType("OperatingAgreement")).toBe("Operating Agreement");
  expect(humanDocType("articles_of_organization")).toBe("articles of organization");
  expect(humanDocType("EIN-Letter")).toBe("EIN Letter");
  // A type this build has never seen renders as itself rather than as a guess.
  expect(humanDocType("SomethingNew2027")).toBe("Something New2027");
});

test("bytes read as bytes, KB and MB — and never as a bare number", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
});

test("both required-action codes have a sentence, and an unknown one does not get a guess", () => {
  expect(requiredActionCopy("FORMATION_NAME_OPTIONS_EXHAUSTED")).toMatch(/name options are needed/);
  expect(requiredActionCopy("FORMATION_SIGNATURE_SS4_RESET")).toMatch(/SS-4 signature/);
  // The code itself is always rendered beside this, so the fallback describes the SITUATION
  // rather than inventing a meaning for a code this build does not know.
  expect(requiredActionCopy("FORMATION_SOMETHING_NEW")).toMatch(/waiting on something/);
});
