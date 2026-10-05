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
});

/**
 * The refusal for `code`: an `ApiError` with the code's fixed sentence. A code with no sentence is
 * a bug in the caller and throws, so a refusal never goes out without its sentence.
 */
export function refusal(
  code: string,
  status: ContentfulStatusCode,
  details?: Record<string, string>,
): ApiError {
  const sentence = Object.hasOwn(LEGAL_BODY_SENTENCES, code)
    ? LEGAL_BODY_SENTENCES[code]
    : undefined;
  if (sentence === undefined)
    throw new Error(`no fixed sentence for the legal-body code "${code}"`);
  return new ApiError(code, status, sentence, details);
}
