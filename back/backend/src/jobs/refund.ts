/**
 * GETTING A DEAD JOB'S ESCROW BACK — and never sending a transaction on a guess.
 *
 * #145 made a funding that did not happen a recorded failure. This is the other half: a funding
 * that DID happen, followed by a step that failed. The row ends `failed`, which is true about the
 * saga and silent about the money — the budget is in the contract's escrow, and until now nothing
 * we shipped could retrieve it.
 *
 * The contract offers two ways out, and each is gated on facts only the chain has:
 *   `reject(jobId, reason, "")` — the CLIENT may reject an Open job, and THE JOB'S OWN EVALUATOR
 *      (pinned at creation, not whichever evaluator key we hold today) a Funded or Submitted one.
 *      Either refunds the client; the job ends Rejected.
 *   `claimRefund(jobId)`       — ANYONE may expire a Funded or Submitted job once `expiredAt` has
 *      passed. The refund goes to the client whoever sends it; the job ends Expired.
 *
 * ⚠ THE CHAIN IS READ FIRST, ALWAYS. Our row cannot answer "where is the money": the same escrow
 * may have been completed, rejected or expired by somebody else since we gave up on it, and every
 * one of those makes a different call the only correct one — or makes every call wrong. So the
 * decision comes from `getJob`, and a transaction is only ever sent for a job the contract itself
 * says is Funded or Submitted.
 *
 * ⚠ IT THROWS NOTHING FOR A REFUND THAT FAILED. A reverted or unconfirmed refund is reported as
 * an outcome instead, because its callers need different things from it: the saga is already
 * carrying the error that killed the job and must not lose it, the boot reconcile wants to walk
 * on to the next row, and the tool wants to print what happened. The escrow stays recorded as
 * `escrowed`, so the next boot tries again.
 */

import { type Address, type Hex, keccak256, stringToBytes } from "viem";
import type { JobAdapter } from "../adapters/arc/jobAdapter";
import { ChainTxRevertedError, ChainTxUnconfirmedError } from "../errors";
import { publicErrorMessage } from "../workflow/publicError";
import type { JobRepository } from "./jobRepository";
import type { EscrowState } from "./types";

/** The on-chain job status, as `IERC8183Job.sol` numbers it. */
export const JobStatusOnChain = {
  open: 0,
  funded: 1,
  submitted: 2,
  completed: 3,
  rejected: 4,
  expired: 5,
} as const;

/**
 * The `bytes32 reason` every refund of ours carries.
 *
 * It travels as calldata on a public chain, so it is permanent and readable by anyone: a fixed
 * hash of a fixed string, naming WHY without naming the job, the tenant or anything about them.
 */
export const SAGA_FAILED_REASON: Hex = keccak256(stringToBytes("novi:saga-failed"));

/** Which of the two calls a refund was made with — the trail says so, not just that it happened. */
export type RefundVia = "reject" | "claimRefund";

export type RecoverOutcome =
  /** The chain has nothing escrowed for this job (Open, or no such job). */
  | { outcome: "nothing-escrowed" }
  /** The provider was paid. The escrow was released, not lost. */
  | { outcome: "released" }
  /** Already back with the client, by somebody else's transaction. */
  | { outcome: "refunded-elsewhere" }
  /** We sent it back, and the receipt says it landed. */
  | { outcome: "refunded"; via: RefundVia; txHash: Hex }
  /** Still escrowed: no evaluator to reject with, and the expiry has not arrived. */
  | { outcome: "waiting-expiry"; expiredAt: bigint }
  /** Our refund failed — mined and rolled back, or refused before it was ever sent (no hash
   *  then). The money is still in the escrow either way. */
  | { outcome: "refund-failed"; via: RefundVia; txHash: Hex | null }
  /** Our refund was sent and we could not confirm it. It may still land. */
  | { outcome: "refund-unconfirmed"; via: RefundVia; txHash: Hex }
  /** A status this interface does not know. Nothing is sent and nothing is written. */
  | { outcome: "unknown-status"; status: number };

/**
 * The outcome as JSON, for the surfaces that print it (the MCP tool, the CLI).
 *
 * `expiredAt` is a bigint and `JSON.stringify` throws on one — a TypeError at the exact moment an
 * operator is asking where their money is. Rendered as a decimal string, like every other
 * unsigned integer this API serves (`budgetAmount`).
 */
export function outcomeJson(o: RecoverOutcome): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
  );
}

export interface RecoverEscrowDeps {
  jobs: JobRepository;
  /** Reads the chain and signs the refund — with the evaluator's key, or the client's. */
  job: JobAdapter;
  /** Current unix time in SECONDS, for the expiry comparison. Defaults to the wall clock. */
  now?: () => number;
}

/**
 * Decide what this job's escrow needs, do it, and write down what is true afterwards.
 *
 * By chain status:
 *   Open (0)              nothing escrowed        → `escrow_state = 'none'`,     no transaction
 *   Funded (1)            our key IS this job's   → `reject` as the evaluator
 *   Submitted (2)           evaluator?
 *                         else past `expiredAt`?  → `claimRefund` as the client
 *                         else                    → `escrow_state = 'escrowed'`, no transaction
 *   Completed (3)         paid to the provider    → `escrow_state = 'released'`, no transaction
 *   Rejected (4)          refunded by someone     → `escrow_state = 'refunded'`, refund hash NULL
 *   Expired (5)           refunded by someone     → `escrow_state = 'refunded'`, refund hash NULL
 */
export async function recoverEscrow(d: RecoverEscrowDeps, jobKey: string): Promise<RecoverOutcome> {
  const rec = d.jobs.findByKey(jobKey);
  if (!rec) throw new Error(`recoverEscrow: job ${jobKey} not found`);
  // A job that died before `createJob` has no on-chain record and therefore no escrow. Nothing
  // to read, nothing to send.
  if (!rec.jobId) return settle(d, jobKey, "none", null, { outcome: "nothing-escrowed" });

  const jobId = BigInt(rec.jobId);
  const chain = await d.job.escrowState(jobId);

  switch (chain.status) {
    case JobStatusOnChain.open:
      return settle(d, jobKey, "none", null, { outcome: "nothing-escrowed" });
    case JobStatusOnChain.completed:
      return settle(d, jobKey, "released", null, { outcome: "released" });
    case JobStatusOnChain.rejected:
    case JobStatusOnChain.expired:
      // Refunded — by somebody else, or by US on an earlier call (this tool is safe to call
      // twice, and the second call lands here). So the hash the row already carries is passed
      // through rather than overwritten: `refund_tx_hash = null` MEANS "somebody else did it" in
      // this module's vocabulary, and writing it over our own hash would make the row say
      // something false about a job whose money is home — with nothing left to correct it, since
      // a `refunded` row is out of `listEscrowedUnrefunded()` for good.
      return settle(d, jobKey, "refunded", rec.refundTxHash, { outcome: "refunded-elsewhere" });
    case JobStatusOnChain.funded:
    case JobStatusOnChain.submitted:
      return refund(d, jobKey, jobId, chain);
    default:
      // A status we do not model: refuse to act rather than send a transaction on a guess.
      return { outcome: "unknown-status", status: chain.status };
  }
}

/** The escrow IS in the contract. Which of the two calls, if either, may we make right now? */
async function refund(
  d: RecoverEscrowDeps,
  jobKey: string,
  jobId: bigint,
  chain: { expiredAt: bigint; evaluator: Address },
): Promise<RecoverOutcome> {
  // ⚠ THE RIGHT TO REJECT BELONGS TO THE JOB'S EVALUATOR, not to whoever holds an evaluator key.
  // The contract pins the evaluator at creation, so a job created before this key was configured
  // names the CLIENT (`jobs/composition.ts` falls back to it) — and a reject from any other
  // address reverts. Asking only "do we have a key" would therefore have sent a doomed
  // transaction on every boot, for ever, while the expiry path below sat unused.
  const evaluator = d.job.evaluatorWallet;
  const ours = evaluator?.account?.address;
  if (evaluator && ours && ours.toLowerCase() === chain.evaluator.toLowerCase())
    return send(d, jobKey, "reject", () => d.job.reject(jobId, SAGA_FAILED_REASON, evaluator));

  // Not our job to reject: the only way left is the permissionless expiry, once the deadline the
  // saga set has passed. Anyone may take it, and the money goes to the client either way.
  const nowSec = BigInt(d.now ? d.now() : Math.floor(Date.now() / 1000));
  if (nowSec > chain.expiredAt)
    return send(d, jobKey, "claimRefund", () => d.job.claimRefund(jobId));

  // Not yet. Record that the money is still in there, which is what puts this row in
  // `listEscrowedUnrefunded()` for the next boot to pick up.
  return settle(d, jobKey, "escrowed", null, {
    outcome: "waiting-expiry",
    expiredAt: chain.expiredAt,
  });
}

/** One refund send, and the three things its receipt can mean. */
async function send(
  d: RecoverEscrowDeps,
  jobKey: string,
  via: RefundVia,
  call: () => Promise<Hex>,
): Promise<RecoverOutcome> {
  try {
    const txHash = await call();
    d.jobs.recordEvent(jobKey, "refund", "refunded", txHash, JSON.stringify({ via }));
    // ⚠ THE OUTFLOW METER IS NOT REVERSED, and that is deliberate. `payments/outflowMeter.ts`
    // has no reversal API, and a refund therefore leaves the rolling brake believing the budget
    // left the platform wallet — which makes the brake MORE conservative than the truth for the
    // rest of its window. Being too careful with the platform's own money for an hour is an
    // acceptable price; inventing a credit entry in a ledger whose whole job is to be an upper
    // bound is not.
    return settle(d, jobKey, "refunded", txHash, { outcome: "refunded", via, txHash });
  } catch (e) {
    // A refund is a transaction like any other: mined-and-rolled-back is a receipt, not a
    // success. The state stays `escrowed` and the hash goes on the trail, so the row is still
    // in the set the next boot walks — and the hash is there for an operator to look up.
    if (e instanceof ChainTxRevertedError) {
      d.jobs.recordEvent(jobKey, "refund", "failed", e.txHash, JSON.stringify({ via }));
      return settle(d, jobKey, "escrowed", null, {
        outcome: "refund-failed",
        via,
        txHash: e.txHash,
      });
    }
    // Sent, and we cannot read what it did. A DIFFERENT fact, and the trail keeps them apart:
    // this one may still land, so the next attempt reads the chain before it decides anything.
    if (e instanceof ChainTxUnconfirmedError) {
      d.jobs.recordEvent(jobKey, "refund", "unconfirmed", e.txHash, JSON.stringify({ via }));
      return settle(d, jobKey, "escrowed", null, {
        outcome: "refund-unconfirmed",
        via,
        txHash: e.txHash,
      });
    }
    // A REVERT THAT ARRIVED BEFORE A TRANSACTION DID. On a real chain this is the ordinary shape:
    // `prepareTransactionRequest` estimates gas first, so a refund the contract would refuse
    // throws there — as a viem error, with no hash, and nothing of it reached the job's trail.
    // The escrow is still in the contract, so the row keeps saying so and the next boot retries;
    // the sentence is sanitised because `job_events.detail` is persisted and served
    // (`workflow/publicError.ts`).
    d.jobs.recordEvent(
      jobKey,
      "refund",
      "failed",
      null,
      JSON.stringify({ via, error: publicErrorMessage(e) }),
    );
    settle(d, jobKey, "escrowed", null, { outcome: "refund-failed", via, txHash: null });
    // Rethrown, unlike the two typed failures above: this is a failure nobody classified, and the
    // callers that swallow it (the saga, the boot walk) each keep their own record of it.
    throw e;
  }
}

/** The two states a job's escrow never comes back from: the money has left the contract. */
const SETTLED: EscrowState[] = ["refunded", "released"];

/**
 * Write the escrow's whereabouts onto the row, off a FRESH read — and NEVER BACKWARDS.
 *
 * Off a fresh read because the saga writes the same row on its way down (and the runner writes
 * `failed` after us), so a stale copy saved here would take a column of somebody else's work
 * with it.
 *
 * ⚠ MONOTONIC, which is the belt to the doors' braces. `refunded` and `released` are facts about
 * money that has LEFT the contract, and nothing that happens afterwards can make them untrue: a
 * second refund attempt that loses a race reads the chain a moment too early, decides `escrowed`,
 * and would otherwise overwrite the winner's `refunded` — leaving `get_job` reporting an escrow
 * still in the contract, and a null hash, for a job whose budget is already home. The same rule
 * covers the hash on its own: a non-null `refund_tx_hash` is the transaction that moved the
 * money, and null does not get to replace it.
 */
function settle(
  d: RecoverEscrowDeps,
  jobKey: string,
  escrowState: EscrowState,
  refundTxHash: Hex | null,
  outcome: RecoverOutcome,
): RecoverOutcome {
  const cur = d.jobs.findByKey(jobKey);
  if (!cur) return outcome;
  const settled = cur.escrowState !== null && SETTLED.includes(cur.escrowState);
  d.jobs.upsert({
    ...cur,
    escrowState: settled ? cur.escrowState : escrowState,
    refundTxHash: refundTxHash ?? cur.refundTxHash,
  });
  return outcome;
}
