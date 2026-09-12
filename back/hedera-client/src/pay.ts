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
    if (hdr) {
      const s = decodePaymentResponseHeader(hdr);
      if (s.success && s.transaction && approved) {
        await reportUntilSettled(o.novi, o.entityId, s, approved);
      }
    }
    return res;
  };
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
 * @param s - The decoded `PAYMENT-RESPONSE`
 * @param req - What the policy hook approved
 * @returns The last answer the server gave
 */
export async function reportUntilSettled(
  novi: NoviClient,
  entityId: string,
  s: SettleResponse,
  req: PaidRequirements,
) {
  const args = {
    id: entityId,
    payee: req.payee,
    amountUsdc: req.amountUsdc,
    network: "hedera:testnet",
    transactionId: s.transaction,
    idempotencyKey: s.transaction,
  };
  let answer = await novi.reportPayment(args);
  for (let i = 1; i < REPORT_TRIES && answer.status === "pending"; i++) {
    await new Promise((r) => setTimeout(r, REPORT_INTERVAL_MS));
    answer = await novi.reportPayment(args);
  }
  return answer;
}
