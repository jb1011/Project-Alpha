import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import type { Hex } from "viem";
import type { NewCompanyCheck } from "../persistence/companyCheckRepository";
import { wyomingDate } from "../util/wyomingCalendar";

/**
 * THE AUTOMATIC CHECK OF A SANDBOX DECLARATION. A sandbox deployment has nobody on duty to check a
 * declaration, so the declaration door writes the passed check itself, inside the declaration's own
 * transaction: the company is orderable from its first read. The check examines nothing, and every
 * field says so: the operator is SANDBOX_AUTOMATIC_OPERATOR, the registry status and the registered
 * agent read `sandbox`, the control evidence is of kind `other`, and both evidence hashes are the
 * hash of one fixed sentence, never of a document. Its formation date is the Wyoming day the check
 * is written (the declaration's day, or a reinstatement's), so the filing facts count the first
 * annual report from that day.
 *
 * No column says "automatic": the operator's name is the one marker, and it means something only on
 * a sandbox deployment. On production that name proves nothing.
 */

export const SANDBOX_AUTOMATIC_OPERATOR = "sandbox-automatic";
export const SANDBOX_AUTOMATIC_SENTINEL =
  "Novi Corpus sandbox: this check was written automatically and examined no evidence.";
/** sha256 of the sentinel's UTF-8 bytes, `0x` + 64 lower-case hex digits. */
export const SANDBOX_AUTOMATIC_SENTINEL_SHA256: Hex = `0x${createHash("sha256")
  .update(SANDBOX_AUTOMATIC_SENTINEL, "utf8")
  .digest("hex")}`;
export const SANDBOX_REGISTRY_STATUS = "sandbox";
export const SANDBOX_REGISTERED_AGENT = "sandbox";

/** True only on a sandbox deployment: the operator name is the one marker, so on production it
 *  proves nothing. */
export function isAutomaticSandboxCheck(
  check: { operator: string } | undefined,
  environment: "sandbox" | "production",
): boolean {
  return environment === "sandbox" && check?.operator === SANDBOX_AUTOMATIC_OPERATOR;
}

/** The row the declaration writes: a pass whose every field says it examined nothing. */
export function automaticSandboxCheck(p: {
  companyId: string;
  /** The declared name, as normalised by the door. */
  companyName: string;
  /** The declared number. */
  filingNumber: string;
  /** Unix seconds. */
  checkedAt: number;
  osUser: string;
}): NewCompanyCheck {
  return {
    companyId: p.companyId,
    result: "passed",
    operator: SANDBOX_AUTOMATIC_OPERATOR,
    operatorOsUser: p.osUser,
    checkedAt: p.checkedAt,
    registryName: p.companyName,
    registryFilingId: p.filingNumber,
    registryStatus: SANDBOX_REGISTRY_STATUS,
    formationDate: wyomingDate(p.checkedAt),
    registeredAgent: SANDBOX_REGISTERED_AGENT,
    existenceEvidenceSha256: SANDBOX_AUTOMATIC_SENTINEL_SHA256,
    controlEvidenceSha256: SANDBOX_AUTOMATIC_SENTINEL_SHA256,
    controlEvidenceKind: "other",
    reasonCode: null,
    reason: null,
  };
}

/**
 * The OS user of the running process: `userInfo().username`, else `USER` or `LOGNAME`, else "api".
 * Recorded on the automatic check as the operator's command records its own. Unlike that command,
 * the API process never refuses for want of it: an empty value counts as none, and the last word
 * is fixed.
 */
export function processOsUser(): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    // No passwd entry for this uid (a container's arbitrary uid): the environment, then "api".
  }
  return process.env.USER || process.env.LOGNAME || "api";
}
