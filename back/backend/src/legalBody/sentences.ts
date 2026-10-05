import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "../errors";

/**
 * One fixed sentence for every code the legal-body flow answers.
 *
 * A refusal of this flow carries a code and a sentence written here, never text that came from
 * somewhere else: not a node's error, not a contract's revert string, not a value the caller sent.
 * So nothing a chain or a client says can reach a response by way of an error message, and the
 * same code always reads the same.
 */
export const LEGAL_BODY_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  not_found: "Nothing with this id belongs to you.",
  legal_text_not_approved:
    "This deployment does not take legal-body orders yet: the wording of the operating agreement is not approved for use with a real company.",
  company_not_eligible:
    "This company cannot stand behind a legal body: it must be a company you declared, not abandoned, whose latest check by the operator passed.",
  legal_body_cap:
    "You already hold as many open legal-body orders as you may at once: finish or abandon one before you order another.",
  legal_body_orders:
    "You have placed as many legal-body orders in the last 24 hours as you may: try again later.",
  order_closed: "This order's state does not allow this action, and nothing was changed.",
  other_deployment:
    "This order was made under another legal-body factory or chain: it can be read here, and nothing else.",
  chain_unavailable:
    "The chain could not be read just now, and nothing was changed: try again in a moment.",
  rate_limited: "Too many requests: wait a few seconds and try again.",
  payload_too_large: "The request body is too large: a legal-body door reads at most 8 KiB.",
  agreement_unreadable:
    "This order's stored agreement no longer reads back as the agreement it was frozen with, so it is not served.",
  internal_error: "Something went wrong on our side: try again in a moment.",
  order_expired:
    "This order can no longer be linked: a draft can be linked for 24 hours after it was placed. Place a new order.",
  order_revoked: "This order was revoked by the operator, and can no longer be linked.",
  agreement_outdated:
    "This order's agreement was written on a version of the operating agreement this deployment no longer serves: place a new order.",
  invalid_agent_id:
    "The agentId must be the identity's ERC-8004 id as a decimal string: digits only, no leading zero, below 2^256.",
  invalid_link_ttl:
    "The ttlSeconds, when given, must be a whole number of seconds from 600 to 85800.",
  identity_not_found: "No ERC-8004 identity with this agentId exists on this chain.",
  malformed_link:
    "The link message is not the one served: it must have exactly its five fields, each in the form it was served in.",
  malformed_signature:
    "The signature must be 0x followed by whole bytes of hex, at most 2,048 bytes.",
  guardian_mismatch:
    "The link names another guardian: the guardian must be your own signed-in wallet.",
  agreement_mismatch: "The link carries another agreement hash than this order's frozen agreement.",
  delay_mismatch: "The link carries another amendment delay than this order's.",
  deadline_out_of_window:
    "The link's deadline has passed, is too close to use, or is further ahead than the factory accepts: ask for a new link message.",
  unsupported_signer:
    "The identity owner's signature is in a form the factory does not accept: sign the link message with the owner's own key or with its deployed smart account.",
  bad_signature: "The signature is not the identity owner's signature of this link message.",
  already_created:
    "A legal body was already created from this exact link: ask for a new link message.",
  gas_too_high:
    "Creating this legal body would take more gas than the platform allows, and nothing was sent.",
  create_would_revert:
    "The factory would refuse to create a legal body from this link, and nothing was sent.",
  agent_in_flight:
    "Another order for this identity, signed by its current owner, is on its way: it settles within seconds, or lapses at its deadline.",
  legal_body_attempts:
    "You have started as many legal-body creations in the last 24 hours as you may: try again later.",
  busy: "This deployment has created as many legal bodies in the last 24 hours as it may: try again later.",
  link_already_used:
    "Another order already holds the legal body this link would create: ask for a new link message.",
  order_lapsed:
    "This order has lapsed: it was closed without a legal body, and it can no longer be linked. Place a new order to start again.",
});

/** The fixed sentence of `code`. A code with no sentence is a bug in the caller, and throws. */
export function sentenceFor(code: string): string {
  const sentence = Object.hasOwn(LEGAL_BODY_SENTENCES, code)
    ? LEGAL_BODY_SENTENCES[code]
    : undefined;
  if (sentence === undefined)
    throw new Error(`no fixed sentence for the legal-body code "${code}"`);
  return sentence;
}

/**
 * The refusal for `code`: an `ApiError` with the code's fixed sentence. A code with no sentence is
 * a bug in the caller and throws, so a refusal never goes out without its sentence.
 */
export function refusal(
  code: string,
  status: ContentfulStatusCode,
  details?: Record<string, string>,
): ApiError {
  return new ApiError(code, status, sentenceFor(code), details);
}
