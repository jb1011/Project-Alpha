/**
 * What the screen does next after a legal-body door's answer.
 *
 * Pure, and it never writes a sentence of its own: where a refusal is shown, it is shown with the
 * sentence the door served. The codes are matched by a `switch` and a list, never by indexing an
 * object, so a name every object inherits (`constructor`, `__proto__`) is not mistaken for one.
 */
import type { LegalBodyOrderView, LinkSubmitAnswer } from "@/lib/api/types";
import type { OwnerBranch } from "@/lib/legalBody/flow";

/**
 * - `agreement`: the order cannot be linked any more; back to the agreement, for a new order;
 * - `company`: the company cannot stand behind a body; back to the company step;
 * - `wait`: a limit was reached; the sentence says when to try again;
 * - `retry`: nothing was changed; the same click may be tried again;
 * - `new_message`: a link message with a new deadline is needed;
 * - `bug`: the browser built a request the door does not read;
 * - `pasted_not_hex`: what was pasted is not a signature the door reads;
 * - `identity`: no identity with this id; back to the identity step;
 * - `sentence`: the door's own sentence, shown as served.
 */
export type DoorRoute =
  | "agreement"
  | "company"
  | "wait"
  | "retry"
  | "new_message"
  | "bug"
  | "pasted_not_hex"
  | "identity"
  | "sentence";

/**
 * The route for a house error from the link door, by its code.
 *
 * `agent_in_flight` and `deadline_out_of_window` are not here: the link door answers them as its
 * flat 422, which reaches `linkSubmitOutcome`, never this function.
 */
export function linkDoorRoute(code: string, branch: OwnerBranch): DoorRoute {
  switch (code) {
    case "order_expired":
    case "order_closed":
    case "agreement_outdated":
    case "order_revoked":
    case "other_deployment":
      return "agreement";
    case "company_not_eligible":
      return "company";
    case "legal_body_attempts":
    case "rate_limited":
    case "busy":
      return "wait";
    case "chain_unavailable":
    case "internal_error":
    case "agreement_unreadable":
      return "retry";
    case "link_already_used":
      return "new_message";
    case "identity_not_found":
      return "identity";
    case "malformed_link":
    case "malformed_signature":
      // In the browser both fields come from the wallet and the served message: a refusal is ours.
      // On the paste branch the signature is what a person pasted.
      return branch === "browser" ? "bug" : "pasted_not_hex";
    default:
      return "sentence";
  }
}

export type LinkSubmitOutcome =
  | { next: "rederive"; order: LegalBodyOrderView }
  | { next: "refused"; order: LegalBodyOrderView; code: string; sentence: string; lapsed: boolean };

/**
 * The link door's answer without an error. A 200 or a 202 carries the order as it now stands, and
 * the screen derives its phase from it again. A 422 is the flat refusal: its code, its sentence as
 * served, and the order it carries, still `draft` when the refusal came before the reservation (so
 * signing again is the retry) and `lapsed` when it came after it.
 */
export function linkSubmitOutcome(answer: LinkSubmitAnswer): LinkSubmitOutcome {
  if (answer.status === 422) {
    const { code, message, order } = answer.body;
    return { next: "refused", order, code, sentence: message, lapsed: order.state === "lapsed" };
  }
  return { next: "rederive", order: answer.body };
}

/** The codes the gas seed door answers with. */
export const GAS_SEED_CODES = [
  "gas_seed_disabled",
  "gas_seed_used",
  "owner_pays_own_gas",
  "not_needed",
  "gas_seed_unconfirmed",
  "busy",
  "order_closed",
  "rate_limited",
] as const;

/** The answers after which asking again cannot change anything: the seed is not offered here, was
 *  already had, cannot reach this owner, is not needed, or counts as had. */
const FINAL_GAS_SEED_CODES: readonly string[] = [
  "gas_seed_disabled",
  "gas_seed_used",
  "owner_pays_own_gas",
  "not_needed",
  "gas_seed_unconfirmed",
];

/** Whether the gas seed door answers with `code` at all, and whether the button is offered again
 *  after it (`final`: it is not). An unknown code is not final: its sentence shows, and the person
 *  may ask again. */
export function gasSeedOutcome(code: string): { known: boolean; final: boolean } {
  return {
    known: (GAS_SEED_CODES as readonly string[]).includes(code),
    final: FINAL_GAS_SEED_CODES.includes(code),
  };
}
