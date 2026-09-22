/**
 * A MINED TRANSACTION IS NOT A SUCCESSFUL ONE, AND ONE LINE IS WHAT SAYS SO.
 *
 * `publicClient.waitForTransactionReceipt({ hash })` resolves for a transaction that REVERTED:
 * viem hands back the receipt with `status: "reverted"` and throws nothing, which is correct —
 * the chain did answer. Every adapter in this directory awaited one and then returned the hash,
 * so "the node took the bytes" and "the call did what it said" were the same fact upstream. On
 * 2026-09-22 that difference was half a USDC of escrow booked as money that had left a wallet it
 * never left, and a job row that said `funded` about a job the contract still had at Open.
 *
 * So the wait and the check live together, in one place, and a caller cannot have the first
 * without the second. The thrower is passed in rather than fixed here because the sentence that
 * reaches a founder belongs to the step: `runJob` keys off the TYPE of a funding failure
 * (`errors.ts`), while the other sites only have to name themselves.
 *
 * ⚠ It stays OUTSIDE the send lock, like the wait it replaces (`senderLock.ts`): a lock held
 * across a receipt wait stops every other send from that key for as long as the chain takes.
 */
import type { Hex, PublicClient } from "viem";

export async function awaitSuccessfulReceipt(
  publicClient: PublicClient,
  txHash: Hex,
  reverted: (txHash: Hex) => Error,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw reverted(txHash);
}
