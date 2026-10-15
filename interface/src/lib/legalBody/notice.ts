import { CHECK_REASON_SENTENCES, LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyNotice } from "@/lib/legalBody/flow";

/**
 * What a notice of the derivation says, and the way out it offers.
 *
 * `new_order` starts a new order on the same company; `new_company` a new declaration; `none`
 * offers nothing, because the step itself is the way on (pick another identity, wait for the body
 * or the check) or because there is nothing to start again.
 */

export type NoticeWayOut = "new_order" | "new_company" | "none";

export type NoticeSentence = { title: string; body: string; wayOut: NoticeWayOut };

const N = LEGAL_BODY_COPY.notices;

/** The newer order's line, when the server names it. */
function newerOrder(by: string | null): string {
  return by ? ` ${fillCopy(N.newerOrder, { by })}` : "";
}

export function noticeSentence(
  n: LegalBodyNotice,
  environment: "sandbox" | "production",
): NoticeSentence {
  switch (n.kind) {
    case "expired":
      return { ...N.expired, wayOut: "new_order" };
    case "lapsed":
      return {
        title: N.lapsed.title,
        body: N.lapsed.reasons[n.reason ?? "unknown"],
        wayOut: "new_order",
      };
    case "superseded":
      return { title: N.superseded.title, body: N.superseded.body + newerOrder(n.by), wayOut: "new_order" };
    case "replaced":
      return { title: N.replaced.title, body: N.replaced.body + newerOrder(n.by), wayOut: "new_order" };
    case "abandoned":
      return { ...N.abandoned, wayOut: "new_order" };
    case "order_revoked":
      return { ...N.order_revoked, wayOut: "new_order" };
    case "other_deployment":
      return { ...N.other_deployment, wayOut: "new_order" };
    case "company_failed": {
      const reason = n.reasonCode ? CHECK_REASON_SENTENCES[n.reasonCode] : N.company_failed.noReason;
      const wayBack =
        environment === "sandbox" ? N.company_failed.wayBackSandbox : N.company_failed.wayBackProduction;
      return { title: N.company_failed.title, body: `${reason} ${wayBack}`, wayOut: "new_company" };
    }
    case "company_revoked":
      return { ...N.company_revoked, wayOut: "new_company" };
    case "company_awaiting_check":
      return {
        title: N.company_awaiting_check.title,
        body: N.company_awaiting_check[environment],
        wayOut: "none",
      };
    case "company_abandoned":
      return { ...N.company_abandoned, wayOut: "new_company" };
    case "creating":
      return { ...N.creating, wayOut: "none" };
    case "winding_down":
      return { ...N.winding_down, wayOut: "none" };
    case "dissolved":
      return { ...N.dissolved, wayOut: "none" };
    case "broken_reason_unknown":
      return { ...N.broken_reason_unknown, wayOut: "none" };
    case "identity_taken":
      return {
        title: N.identity_taken.title,
        body: fillCopy(N.identity_taken.body, { agentId: n.agentId }),
        wayOut: "none",
      };
  }
}

/** A closed phase's notice; a closed phase with none (a state this build does not know) offers
 *  nothing. */
export function closedSentence(
  n: LegalBodyNotice | undefined,
  environment: "sandbox" | "production",
): NoticeSentence {
  if (n) return noticeSentence(n, environment);
  return {
    title: LEGAL_BODY_COPY.closed.unknownTitle,
    body: LEGAL_BODY_COPY.closed.unknownBody,
    wayOut: "none",
  };
}
