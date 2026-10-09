import type { Hex } from "viem";
import type { AttestationState } from "./attestation";
import type { FilingFacts } from "./filings";

/**
 * A LEGAL BODY'S STANDING, as its public statement states it: a pure function of one block's chain
 * facts and the facts the deployment recorded, so nothing stores a standing that could drift from
 * what it was read from.
 *
 * `active` only when every fact behind it holds. Missing evidence never reads `inactive`: a company
 * not yet checked is `pending`, missing filing evidence is `unknown`. `inactive` needs a fact the
 * chain or an operator recorded: a status other than Active, a broken binding, a revocation.
 */

/** Every standing, in a fixed order: the one list {@link Standing} is read from, so a reader that
 *  checks a standing against it accepts every value the type allows. */
export const STANDINGS = ["pending", "active", "unknown", "inactive"] as const;
export type Standing = (typeof STANDINGS)[number];

/** Every binding state: the one list {@link PublicBindingState} is read from. */
export const PUBLIC_BINDING_STATES = ["linked", "broken"] as const;
/** Whether the agent's pointer, read on chain, names the body: `broken` covers a cleared pointer,
 *  one to another body, and a body the factory no longer returns. */
export type PublicBindingState = (typeof PUBLIC_BINDING_STATES)[number];

export type StandingReason =
  | "status_not_active"
  | "binding_broken"
  | "attestation_revoked"
  | "attestation_pending"
  | "agreement_mismatch"
  | "filing_unverified"
  | "filing_past_grace";

/**
 * The standing, from the first rule that matches:
 *  1. `inactive` when the body's status is not `active`, the binding is `broken`, or the
 *     attestation is `revoked`;
 *  2. `pending` when the attestation is `pending`;
 *  3. `unknown` when the agreement hash on chain is not the frozen one (compared in lower case),
 *     the filing status is `unverified`, or a report is past due beyond grace;
 *  4. `active` otherwise.
 *
 * `reasons` lists every condition that fails, matched or not, in the order of the rules above, so
 * a reader sees each thing that stands between the body and `active`.
 */
export function computeStanding(
  chain: {
    bindingState: PublicBindingState;
    status: "active" | "winding_down" | "dissolved";
    oaHashOnChain: Hex;
  },
  facts: {
    frozenOaHash: Hex;
    attestation: AttestationState;
    filing: Pick<FilingFacts, "filingStatus" | "beyondGrace">;
  },
): { standing: Standing; reasons: StandingReason[] } {
  const inactive: StandingReason[] = [];
  if (chain.status !== "active") inactive.push("status_not_active");
  if (chain.bindingState !== "linked") inactive.push("binding_broken");
  if (facts.attestation === "revoked") inactive.push("attestation_revoked");

  const pending: StandingReason[] = facts.attestation === "pending" ? ["attestation_pending"] : [];

  const unknown: StandingReason[] = [];
  if (chain.oaHashOnChain.toLowerCase() !== facts.frozenOaHash.toLowerCase())
    unknown.push("agreement_mismatch");
  if (facts.filing.filingStatus === "unverified") unknown.push("filing_unverified");
  if (facts.filing.beyondGrace) unknown.push("filing_past_grace");

  const standing: Standing =
    inactive.length > 0
      ? "inactive"
      : pending.length > 0
        ? "pending"
        : unknown.length > 0
          ? "unknown"
          : "active";
  return { standing, reasons: [...inactive, ...pending, ...unknown] };
}
