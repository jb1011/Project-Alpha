import type { FormationPaymentView, PaymentTypedData, PublicConfig } from "@/lib/api/types";

/**
 * FORMATION-PAYMENT PRESENTATION, as pure functions (design §6.8).
 *
 * The wizard step and the Companies page render the same payment, and every question they ask of
 * it — "may this be signed?", "what does this say?", "what may the guardian do next?" — has one
 * answer here rather than two in two components. That is the `honesty.ts` precedent applied to
 * money: a picker and a detail page disagreeing about a filing is a bug; disagreeing about
 * whether a guardian still owes 399 USDC is a bug that takes money.
 */

/**
 * THE FEE SENTENCE.
 *
 * Both halves come from `/config`, never from the bundle: the fee a screen names has to be the
 * fee the backend would quote, and a number compiled into the browser build drifts from it
 * silently. When we do not know the price we do not name one — "included during the beta" is
 * still true and complete without it.
 */
export function feeSentence(config: Pick<PublicConfig, "formationPaymentRequired" | "formationFeeUsdc"> | undefined): string {
  const fee = config?.formationFeeUsdc;
  if (config?.formationPaymentRequired === true)
    return fee == null ? "Formation fee" : `$${fee} USDC, one time`;
  return fee == null
    ? "Formation is included during the beta."
    : `Formation is included during the beta, normally $${fee}.`;
}

/**
 * The breakdown line (§6.8).
 *
 * The Wyoming state fee is OUTSIDE the filing partner's pack and is NOT added at checkout — the
 * quoted price already covers it. Saying so is the difference between a price a person can check
 * and a number they have to trust, and it is the one part of the fee a reader can verify against
 * Wyoming's own published schedule.
 */
export const FEE_BREAKDOWN = "Includes the $100 Wyoming state filing fee — nothing is added at checkout.";

/** Atomic USDC (6 decimals) as a human amount. Exact for the whole-dollar fees we quote. */
export function formatAtomicUsdc(atomic: string): string {
  const n = Number(atomic) / 1_000_000;
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
}

/**
 * WHAT THE GUARDIAN MAY DO NEXT — one function, so the wizard and the Companies page cannot offer
 * different buttons for the same row.
 *
 *  - `sign`    a live quote, inside its window;
 *  - `wait`    a broadcast whose outcome is not yet known. **No sign button exists in this
 *              state**, and that is the whole point: signing again while a transfer may still be
 *              mined is how a guardian is charged twice;
 *  - `cancel`  the same state, once it has been stuck long enough that waiting is not an answer.
 *              A cancel is a second signature, and it retires the authorization on-chain;
 *  - `requote` a terminal-but-unpaid row: expired, or a transfer that reverted;
 *  - `done`    settled or refunded — nothing is owed.
 */
export type PaymentAction = "sign" | "wait" | "cancel" | "requote" | "done" | "unknown";

/** How long a `settling` row must sit before the cancel button appears. Long enough that an
 *  ordinary confirmation is not interrupted; short enough that nobody watches a spinner. */
export const STUCK_AFTER_MS = 90_000;

export function paymentAction(
  payment: FormationPaymentView | undefined,
  opts: { nowMs: number; settlingSinceMs?: number },
): PaymentAction {
  if (!payment) return "unknown";
  switch (payment.status) {
    case "quoted":
      // The QUOTE is the authority, not the status: the backend withholds it past `validBefore`
      // even before the sweeper has moved the row, because the clock is the truth and the status
      // is only when somebody last looked.
      return payment.quote ? "sign" : "requote";
    case "settling":
      return opts.settlingSinceMs !== undefined &&
        opts.nowMs - opts.settlingSinceMs > STUCK_AFTER_MS
        ? "cancel"
        : "wait";
    case "expired":
    case "failed":
      return "requote";
    case "settled":
    case "refunded":
      return "done";
    default:
      // A status from a newer backend. `unknown` renders as "we cannot read this" rather than as
      // anything actionable — the honesty rule the formation status union already follows.
      return "unknown";
  }
}

/** One sentence per state, in the register of somebody who is owed an explanation and not a log
 *  line. Kept beside `paymentAction` so a state can never gain a button without gaining words. */
export function paymentExplanation(payment: FormationPaymentView | undefined): string {
  switch (payment?.status) {
    case "quoted":
      return payment.quote
        ? "Your wallet will ask you to authorize this exact transfer. Nothing moves until you approve it."
        : "This quote's window has closed. Request a new one — nothing was charged.";
    case "settling":
      return "Your authorization has been submitted and we are waiting for it to confirm. Do not sign again: the transfer may still complete, and a second signature could charge you twice.";
    case "settled":
      return "Paid. Your company can now be filed.";
    case "expired":
      return "This quote expired before it was used. Nothing was charged. Request a new one when you are ready.";
    case "failed":
      return "The transfer did not go through — most often because the wallet did not hold enough USDC. Nothing was charged. Request a new quote and try again.";
    case "refunded":
      return "This payment was refunded.";
    default:
      return "";
  }
}

/**
 * The typed data, in the shape wagmi's `useSignTypedData` takes.
 *
 * A translation and NOT a construction: every field comes from the server's object, and the only
 * work is turning the three decimal strings into bigints, which is what viem's encoder wants.
 * Building the message here instead would be a second place to get the domain, the type list or
 * the field ORDER wrong, and each of those yields a signature that reverts after approval.
 */
export function toWagmiTypedData(td: PaymentTypedData) {
  return {
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: {
      from: td.message.from,
      to: td.message.to,
      value: BigInt(td.message.value),
      validAfter: BigInt(td.message.validAfter),
      validBefore: BigInt(td.message.validBefore),
      nonce: td.message.nonce,
    },
  } as const;
}

/**
 * The `CancelAuthorization` message, built HERE because there is no quote to carry it.
 *
 * The one place this package constructs typed data rather than relaying it, and it is safe to do
 * so for a reason worth stating: a wrong cancel message produces a signature the token REJECTS,
 * so the failure mode is a reverted cancellation and a payment that stays stuck — never a
 * transfer of the guardian's money. The domain is still the server's, taken off the quote or the
 * settled payment, never assembled from constants here.
 */
export function cancelTypedData(
  domain: PaymentTypedData["domain"],
  authorizer: `0x${string}`,
  nonce: `0x${string}`,
) {
  return {
    domain,
    types: {
      CancelAuthorization: [
        { name: "authorizer", type: "address" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "CancelAuthorization",
    message: { authorizer, nonce },
  } as const;
}
