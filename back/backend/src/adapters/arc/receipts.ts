/**
 * A MINED TRANSACTION IS NOT A SUCCESSFUL ONE, AND A SILENT ONE IS NEITHER.
 *
 * `publicClient.waitForTransactionReceipt({ hash })` resolves for a transaction that REVERTED:
 * viem hands back the receipt with `status: "reverted"` and throws nothing, which is correct —
 * the chain did answer. Every adapter in this directory awaited one and then returned the hash,
 * so "the node took the bytes" and "the call did what it said" were the same fact upstream. On
 * 2026-09-22 that difference was half a USDC of escrow booked as money that had left a wallet it
 * never left, and a job row that said `funded` about a job the contract still had at Open.
 *
 * So the wait and the check live together, in one place, and a caller cannot have the first
 * without the second. The throwers are passed in rather than fixed here because the sentence that
 * reaches a founder belongs to the step: `runJob` keys off the TYPE of a funding failure
 * (`errors.ts`), while the other sites only have to name themselves.
 *
 * ⚠ THE WAIT IS BOUNDED, and that is not a detail. `approveAndFund` holds one lock per job client
 * key across BOTH of its waits — that is what makes approve-then-fund a unit at all
 * (`jobAdapter.ts`) — so an unbounded wait is not one slow job, it is every job in the process
 * queued behind one transaction the mempool never mined. viem's own default is 180 s PER WAIT, so
 * the pair could park the key for six minutes.
 *
 * ⚠ AND A TIMEOUT IS NOT A REVERT. They are opposite claims — "it did nothing" versus "it may be
 * doing it right now" — and only viem's own give-up means the second one. Anything else that
 * throws here is a transport failure with no verdict about the chain in it at all, and it goes
 * back to the caller untouched rather than being dressed up as either.
 *
 * ⚠ It stays OUTSIDE the send lock, like the wait it replaces (`senderLock.ts`): a lock held
 * across a receipt wait stops every other send from that key for as long as the chain takes.
 */
import { type Hex, type PublicClient, WaitForTransactionReceiptTimeoutError } from "viem";

/**
 * How long a receipt may take before we stop waiting and say so.
 *
 * Arc's finality is sub-second, so a minute of silence is not slowness: it is a transaction the
 * mempool dropped, an endpoint that has stopped answering, or a reorg. Long enough that a
 * congested block never trips it, short enough that the allowance unit above cannot be parked.
 */
export const RECEIPT_TIMEOUT_MS = 60_000;

/** The two sentences a caller needs: one for a receipt that reverted, one for no receipt at all. */
export interface ReceiptOutcome {
  reverted: (txHash: Hex) => Error;
  unconfirmed: (txHash: Hex) => Error;
}

export async function awaitSuccessfulReceipt(
  publicClient: PublicClient,
  txHash: Hex,
  outcome: ReceiptOutcome,
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): Promise<void> {
  let receipt: { status: string };
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs });
  } catch (e) {
    // ONLY viem's own give-up. Every other failure here is about the connection, not the
    // transaction, and claiming either outcome for it would be an invention.
    if (e instanceof WaitForTransactionReceiptTimeoutError) throw outcome.unconfirmed(txHash);
    throw e;
  }
  if (receipt.status !== "success") throw outcome.reverted(txHash);
}
