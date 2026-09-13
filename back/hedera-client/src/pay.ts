import type { SettleResponse } from "@x402/core/types";
/**
 * The paying fetch: x402 with the legal body's policy check wired in ahead of signing.
 *
 * This is where D2 is enforced. The Novi Corpus server cannot block a payment it does not
 * sign, so the refusal happens HERE: `check_policy` runs inside `onBeforePaymentCreation`,
 * and a deny aborts before `createPartiallySignedTransferTransaction` is ever called. The
 * abort surfaces from `wrapFetchWithPayment` as a thrown
 * `Failed to create payment payload: Payment creation aborted: policy denied: <reason>`,
 * never as a 402; the command layer catches it, prints `policy denied: <reason>` and exits 2.
 *
 * A refused settlement (a 402 whose `PAYMENT-RESPONSE` carries `success: false`) is NOT
 * reported: nothing reached the ledger, so nothing is recorded.
 */
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { ClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { NoviClient } from "./novi.js";

/** How many times `report_payment` is asked while the mirror node answers `pending` (D16). */
export const REPORT_TRIES = 3;
/** How long to wait between those tries. The server itself already waits up to 10 seconds. */
export const REPORT_INTERVAL_MS = 4_000;

/** What the pre-flight hook saw, kept so the report describes the same payment. */
type PaidRequirements = { payee: string; amountUsdc: string; network: string };

/**
 * Builds a `fetch` that pays x402 invoices on `hedera:*` from the customer's own key.
 *
 * @param o - Signer, MCP client, entity and an optional fetch to wrap
 * @param o.signer - The customer's Hedera signer; the only thing that touches a key
 * @param o.novi - The three Novi Corpus tools
 * @param o.entityId - The legal body whose policy is checked and whose ledger records the payment
 * @param o.fetchImpl - The fetch to wrap; defaults to the global one
 * @returns A fetch that settles a 402 and reports the result
 */
export function payFetchFor(o: {
  signer: ClientHederaSigner;
  novi: NoviClient;
  entityId: string;
  fetchImpl?: typeof fetch;
}) {
  // The requirements the hook approved, read back after settlement so the report describes
  // the payment that was actually authorized rather than anything the server echoed. One
  // slot, so one returned fetch is single-flight by construction: build a fetch per resource
  // rather than sharing one across concurrent requests.
  let approved: PaidRequirements | undefined;

  const client = new x402Client().register("hedera:*", new ExactHederaScheme(o.signer));
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    const args = {
      id: o.entityId,
      payee: r.payTo,
      amountUsdc: r.amount,
      network: r.network,
    };
    const verdict = await o.novi.checkPolicy(args);
    if (!verdict.ok) return { abort: true as const, reason: `policy denied: ${verdict.reason}` };
    approved = { payee: args.payee, amountUsdc: args.amountUsdc, network: args.network };
  });

  const paid = wrapFetchWithPayment(o.fetchImpl ?? fetch, client);
  // `RequestInfo` is not a global in this package's lib set; take the wrapped fetch's own
  // parameter types so the signature cannot drift from what it delegates to.
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const res = await paid(input, init);
    const hdr = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    if (!hdr) return res;
    // A settlement header with no approval behind it did not pass through the policy hook on this
    // call: either this fetch was reused and the last payment's approval has already been spent,
    // or the server volunteered the header on a request that paid nothing. Reporting it would
    // write the PREVIOUS payment's payee and amount against this transaction id, so it is skipped
    // — loudly, because a payment that really settled and went unreported is worth investigating.
    if (!approved) {
      console.error(
        "PAYMENT-RESPONSE arrived with no approved payment behind it; not reporting it",
      );
      return res;
    }

    let settle: SettleResponse | undefined;
    try {
      settle = decodePaymentResponseHeader(hdr);
    } catch (e) {
      // A header we cannot read is not evidence that nothing was paid. `decodePaymentResponseHeader`
      // throws on anything that is not base64 JSON, and a throw here would abandon a payment that
      // may well have settled, leaving it out of the ledger with no second chance. So: say so on
      // stderr, salvage the transaction id if any of the header survives, and report anyway. An id
      // we could not salvage reaches the server as an empty string, which it cannot find on the
      // mirror node and answers `pending` for, writing no row. That is the safe direction.
      console.error(
        `PAYMENT-RESPONSE did not decode (${(e as Error).message}); reporting the payment anyway`,
      );
    }
    // A settlement the facilitator itself reports as refused never reached the ledger, so it
    // is not reported (design Component 7). Only an explicit `success: false` is that. A
    // header that is missing the field, or that did not decode at all, is UNREADABLE rather
    // than refused, and unreadable is reported: the alternative is losing a real payment from
    // the ledger with no second chance.
    if (settle?.success === false) {
      // Spent all the same. The hook ran for THIS response, and the slot holds one approval: left
      // set, a refusal would hand the next header that skips the hook this payment's payee and
      // amount. Refused and reported are different outcomes; both consume the approval.
      approved = undefined;
      return res;
    }

    const decoded = typeof settle?.transaction === "string" ? settle.transaction : "";
    const transaction = decoded || salvageTransactionId(hdr);
    if (settle && (typeof settle.success !== "boolean" || !decoded))
      console.error("PAYMENT-RESPONSE was not a usable settlement; reporting the payment anyway");
    await reportUntilSettled(o.novi, o.entityId, transaction, approved);
    // The approval is SPENT. One slot serves one payment, so leaving it set would let the next
    // response that carries a `PAYMENT-RESPONSE` without passing through the hook be reported
    // with this payment's payee and amount.
    approved = undefined;
    return res;
  };
}

/**
 * Digs a transaction id out of a `PAYMENT-RESPONSE` the strict decoder refused.
 *
 * Best effort by design: it exists only so a real settlement is reported with its real id
 * rather than with nothing. Anything it cannot read becomes an empty string.
 *
 * @param header - The raw header value
 * @returns The transaction id, or an empty string
 */
export function salvageTransactionId(header: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const tx = (parsed as { transaction?: unknown })?.transaction;
    return typeof tx === "string" ? tx : "";
  } catch {
    return "";
  }
}

/**
 * Reports a settlement to the legal body, polling while the mirror node has not indexed it.
 *
 * `pending` is not a failure: the server answers it when the mirror node has not seen the
 * transaction yet, and writes no row. The transaction id is the identity, so a late duplicate
 * is the same payment once (the partial unique index, not the idempotency key, governs).
 *
 * @param novi - The three Novi Corpus tools
 * @param entityId - The legal body recording the payment
 * @param transactionId - The Hedera transaction id, which is also the idempotency key
 * @param req - What the policy hook approved
 * @returns The last answer the server gave
 */
export async function reportUntilSettled(
  novi: NoviClient,
  entityId: string,
  transactionId: string,
  req: PaidRequirements,
) {
  const args = {
    id: entityId,
    payee: req.payee,
    amountUsdc: req.amountUsdc,
    network: "hedera:testnet",
    transactionId,
    idempotencyKey: transactionId,
  };
  let answer = await novi.reportPayment(args);
  for (let i = 1; i < REPORT_TRIES && answer.status === "pending"; i++) {
    await new Promise((r) => setTimeout(r, REPORT_INTERVAL_MS));
    answer = await novi.reportPayment(args);
  }
  return answer;
}
