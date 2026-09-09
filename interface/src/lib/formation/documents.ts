/**
 * How a legal document and a required-action CODE are RENDERED (design §7).
 *
 * All three of these lived twice — `humanDocType` and `formatBytes` in both `FormationCard` and
 * `CompanyDetail`, `requiredActionCopy` in the card while the company page printed the bare code
 * beside it. Two copies of a formatter is a cosmetic problem right up until they disagree, and
 * "the dashboard calls this file an Operating Agreement and the company page calls it
 * OperatingAgreement" is a disagreement about a legal document.
 *
 * They are pure string functions, which is exactly the constraint that lets this package assert
 * them without a component runner.
 */

/**
 * doola's `docType` in a human's words — DERIVED from the type, never echoed from the provider's
 * own `name` field, which is free text their operators write.
 */
export function humanDocType(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The two required-action codes the provider can raise, in plain language.
 *
 * The CODE is always shown beside the sentence: the sentence is ours and can go stale, and the
 * code is what an operator searches for. An unrecognised code renders as a generic line rather
 * than as a guess — the view deliberately never carries the provider's free-text reason, which
 * their operators write and which can name the responsible party.
 */
export function requiredActionCopy(code: string): string {
  switch (code) {
    case "FORMATION_NAME_OPTIONS_EXHAUSTED":
      return "Every company name you offered was rejected by the state. New name options are needed before this can file.";
    case "FORMATION_SIGNATURE_SS4_RESET":
      return "The SS-4 signature session expired. A replacement signature is needed; this closes itself once you complete it.";
    default:
      return "The filing agent is waiting on something before this can proceed:";
  }
}
