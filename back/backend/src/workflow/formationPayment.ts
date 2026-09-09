import { getAddress, verifyTypedData } from "viem";
import { CANCEL_AUTHORIZATION_TYPES, resolveAuthorizationOutcome } from "../adapters/arc/usdcToken";
import {
  FORMATION_PRODUCT,
  type FormationPaymentConfig,
  type FormationQuote,
  guardianOf,
  insertQuote,
  quoteOf,
} from "../formation/payment";
import { opsLog } from "../observability/opsLog";
import {
  type BroadcastOutcome,
  type FormationExecutorDeps,
  authorizationUsed,
  chainTimeSec,
  submitCancelAuthorization,
  submitTransferWithAuthorization,
} from "../payments/formationSettle";
import { verifyTransferAuthorization } from "../payments/transferAuthorization";
import type { CompanyRecord, CompanyRepository } from "../persistence/companyRepository";
import type { EntityRepository } from "../persistence/entityRepository";
import type { FormationPaymentRecord } from "../persistence/formationPaymentRepository";
import type { Address, Hex } from "../types";
import { recordCompanyEvent } from "./formationStep";

/**
 * SETTLING a formation payment (design 2026-08-26 §6.3/§6.4).
 *
 * One module, three entry points, and the sweeper's resume leg calls the same code the route
 * does — because "what happened to this payment?" must have ONE answer. Two implementations of
 * that question is how a row ends up `failed` in one place and re-broadcast in another.
 *
 * ── THE RULE THAT SHAPES EVERYTHING ───────────────────────────────────────────────────────────
 *
 * An outcome we did not observe is UNKNOWN, and unknown is not failure. A signed authorization is
 * public and self-authorizing until `validBefore`: it can still be mined by anyone holding the
 * bytes, minutes after our RPC gave up. So a timeout leaves the row `settling` and the guardian
 * uncharged-for-a-second-time, where a `failed` would offer a re-quote and could charge them
 * twice when the first transfer lands.
 */

export interface FormationPaymentDeps {
  companies: CompanyRepository;
  /** The entity store, for the AUDIT TRAIL of a company-level event (§3's fan-out rule). Optional
   *  only so fixtures that never reach a terminal transition can omit it; every composition root
   *  wires it, because a duplicate charge has to be visible where an owner looks. */
  entities?: EntityRepository;
  payment: FormationPaymentConfig;
  executor: FormationExecutorDeps;
  /** The company status move and the payment status move commit together. */
  transaction: <T>(fn: () => T) => T;
  now?: () => number;
}

export type SettleResult =
  | { ok: true; status: "settled"; txHash: Hex }
  /** Broadcast, outcome not yet observed. The row stays `settling` and the sweeper owns it.
   *  `txHash` is the attempt we are waiting on, and is absent only if the compose itself never
   *  produced one. */
  | { ok: true; status: "pending"; txHash?: Hex }
  | { ok: false; reason: string };

const nowMs = (deps: FormationPaymentDeps) => (deps.now ?? Date.now)();
const nowSec = (deps: FormationPaymentDeps) => Math.floor(nowMs(deps) / 1000);

/**
 * How far past `validBefore` the CHAIN's clock must be before an authorization is called dead
 * (gate A4).
 *
 * Block timestamps are a miner's declaration rather than a wall clock, and nodes disagree about
 * the head by a block or two. Two minutes is far more than that on a sub-second chain, and the
 * cost of the margin is a payment that stays re-quotable two minutes later than it could have
 * been — against the cost of being early, which is telling a guardian their quote is dead while
 * a transfer they signed is still mineable.
 */
export const FINALITY_MARGIN_S = 120;

/**
 * Verify a guardian's signature LOCALLY, persist the signed transaction, and only then broadcast.
 *
 * The order is the design's, and every step of it is load-bearing:
 *
 *  1. the row must be LIVE and `quoted`. A `settling` row belongs to a broadcast the sweeper
 *     owns; accepting a second signature for it is the double charge;
 *  2. the clock, before anything expensive. A quote past `validBefore` cannot settle, and saying
 *     so here is kinder than a revert;
 *  3. `from` must be THE COMPANY'S GUARDIAN — the tenant that owns the row, which is the wallet
 *     SIWE minted the session over and the address the onboard door forces `roles.guardian` to.
 *     Not "the caller": the caller is already authenticated as that tenant, and this check is
 *     what stops a body naming somebody else's wallet as the payer;
 *  4. the five EIP-3009 checks, through the SHARED helper, against the STORED amount;
 *  5. sign, then CAS `quoted → settling` WITH the bytes, then broadcast. Signing before the CAS
 *     is deliberate: a signature that loses the CAS was never sent and costs nothing, whereas a
 *     CAS that won without bytes to persist would leave a `settling` row nothing could resume.
 */
export async function settleFormationPayment(
  deps: FormationPaymentDeps,
  company: CompanyRecord,
  body: { signature: Hex; from: Address },
): Promise<SettleResult> {
  const row = deps.payment.payments.findLive(company.companyId, FORMATION_PRODUCT);
  if (!row) return { ok: false, reason: "no live payment for this company" };
  if (row.status !== "quoted")
    return {
      ok: false,
      reason:
        "this payment is already being settled — wait for it to finish rather than signing again",
    };
  // THE QUOTE's clock, not the token's (gate A4). The authorization is still valid for another
  // grace period, and that grace exists so a signature given at the last second can be composed,
  // broadcast and mined — not so that a guardian can start a new settlement inside it.
  if (row.ttlAt <= nowSec(deps))
    return { ok: false, reason: "this quote has expired — request a new one" };

  const guardian = guardianOf(company);
  let from: Address;
  try {
    from = getAddress(body.from) as Address;
  } catch {
    return { ok: false, reason: "from is not an address" };
  }
  if (from.toLowerCase() !== guardian.toLowerCase())
    return {
      ok: false,
      reason: "the payment must be signed by this company's guardian wallet",
    };

  // Every field off the ROW, including the PAYEE (B1 gate A1): `deps.payment.revenueAddress` is
  // where a quote's payee came from at insert time, and reading it again here would let an
  // operator's Ledger rotation re-target a signature the guardian has already given.
  const authorization = {
    from: guardian,
    to: row.payTo,
    value: row.amountUsdc.toString(),
    validAfter: "0",
    validBefore: String(row.validBefore),
    nonce: row.nonce,
  };
  const verdict = await verifyTransferAuthorization({
    authorization,
    signature: body.signature,
    domain: deps.payment.domain,
    payTo: row.payTo,
    // THE STORED amount, never `deps.payment.feeAtomic`: a fee change between quote and settle
    // must not re-price a signature already given (§6.3).
    value: row.amountUsdc,
    mode: "exact",
    now: () => nowMs(deps),
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  // PERSIST THE AUTHORIZATION BEFORE ANY BROADCAST (B1 gate A1). The signature is the recovery
  // artifact: a crash after this line is resumable, because a fresh executor transaction can be
  // composed around it at any time before `validBefore`. A crash before it has sent nothing.
  if (
    !deps.payment.payments.markSettling(row.paymentId, {
      payerAddress: from,
      signature: body.signature,
    })
  )
    return {
      ok: false,
      reason:
        "this payment is already being settled — wait for it to finish rather than signing again",
    };
  opsLog("formation_payment_settling", {
    companyId: company.companyId,
    paymentId: row.paymentId,
    amountUsdc: row.amountUsdc.toString(),
  });

  const outcome = await broadcast(
    deps,
    row.paymentId,
    {
      from: guardian,
      to: row.payTo,
      value: row.amountUsdc,
      validAfter: 0n,
      validBefore: BigInt(row.validBefore),
      nonce: row.nonce,
    },
    body.signature,
    0,
  );
  return finishSettle(deps, company, row, outcome);
}

/**
 * One broadcast: compose fresh, record the hash we are waiting on, send, wait.
 *
 * `recordBroadcast` runs BETWEEN signing and sending (`onBroadcast`), which is the only placement
 * that survives a crash in the send itself — a hash written afterwards is missing from exactly
 * the failure that makes it worth having.
 */
async function broadcast(
  deps: FormationPaymentDeps,
  paymentId: string,
  auth: Parameters<typeof submitTransferWithAuthorization>[1],
  signature: Hex,
  bumps: number,
): Promise<BroadcastOutcome> {
  return submitTransferWithAuthorization(deps.executor, auth, signature, {
    bumps,
    onBroadcast: (txHash) => deps.payment.payments.recordBroadcast(paymentId, txHash),
  });
}

/**
 * Turn a broadcast outcome into rows — the ONE place a payment becomes terminal.
 *
 * Shared by the route and the sweeper, so "the receipt says success" means the same thing to
 * both: the payment is `settled` and the company is `ready`, IN ONE TRANSACTION. Two writes
 * would leave a paid company that cannot be filed (or a filed one nobody paid for) in the crash
 * window between them.
 */
function finishSettle(
  deps: FormationPaymentDeps,
  company: CompanyRecord,
  row: FormationPaymentRecord,
  outcome: BroadcastOutcome,
): SettleResult {
  if (outcome.kind === "settled") {
    deps.transaction(() => {
      deps.payment.payments.markSettled(row.paymentId, outcome.txHash);
      // `draft → ready`, a CAS like every other status move. It legitimately does nothing when
      // the company was already `ready` — a company can be paid for after an operator readied it,
      // and re-writing the status would be the drift, not the fix.
      deps.companies.setStatus(company.companyId, "draft", "ready");
    });
    opsLog("formation_payment_settled", {
      companyId: company.companyId,
      paymentId: row.paymentId,
      amountUsdc: row.amountUsdc.toString(),
      txHash: outcome.txHash,
      gasUsed: outcome.gasUsed.toString(),
    });
    // …and immediately: is this the SECOND time this company has paid? (gate A5)
    checkForDoublePayment(deps, company.companyId);
    return { ok: true, status: "settled", txHash: outcome.txHash };
  }
  if (outcome.kind === "reverted") {
    // A REVERT is an outcome we observed: the transfer did not happen and this authorization
    // cannot be made to happen (insufficient balance, or a nonce the token already knows). The
    // row is terminal, and the guardian may re-quote.
    deps.payment.payments.markFailed(row.paymentId);
    opsLog("formation_payment_failed", {
      level: "warn",
      companyId: company.companyId,
      paymentId: row.paymentId,
      txHash: outcome.txHash,
      reason: "reverted",
    });
    return { ok: false, reason: "the payment transaction reverted on-chain — request a new quote" };
  }
  // UNKNOWN. Left `settling` deliberately (§6.4 rule 1): the bytes are public and may still be
  // mined, and a re-quote here is how a guardian gets charged twice.
  opsLog("formation_payment_pending", {
    level: "warn",
    companyId: company.companyId,
    paymentId: row.paymentId,
    reason: outcome.reason,
  });
  // The hash comes off the OUTCOME, which is the attempt that just happened — never off `row`,
  // which was loaded before this broadcast and carries the previous attempt's hash (or none).
  return { ok: true, status: "pending", txHash: outcome.txHash };
}

/**
 * ADVANCE a live payment against the chain (§6.4, rebuilt by the B1 gate).
 *
 * ONE procedure for both live shapes, because they ask the same question of the same evidence: a
 * `settling` row is an authorization we broadcast and lost sight of, a `quoted` row is one that
 * may never have been signed at all, and in both cases "may this be written off?" is answered by
 * the token's logs, the token's `authorizationState` and the CHAIN's clock — never by ours. Two
 * procedures would be two chances for one of them to expire a payment the other would not.
 *
 * Three steps, in this order and for these reasons:
 *
 *  1. ASK THE TOKEN'S LOGS. `AuthorizationUsed` + a matching `Transfer` is a settlement whoever
 *     sent it; `AuthorizationCanceled` is a withdrawal. Both are terminal and both are facts
 *     about the CHAIN rather than about our bookkeeping;
 *  2. an UNKNOWN outcome is never a failure. A spent nonce with no visible log waits; a window
 *     that has closed with the nonce unused expires (and that is what frees the re-quote);
 *  3. otherwise re-submit the SAME authorization in a freshly composed transaction. Never
 *     re-quote — the guardian's signature is still live, and asking for a second one while the
 *     first can still be mined is the double charge this whole leg exists to prevent.
 */
export async function advancePaymentOnChain(
  deps: FormationPaymentDeps,
  company: CompanyRecord,
  row: FormationPaymentRecord,
): Promise<"settled" | "expired" | "failed" | "pending"> {
  const guardian = row.payerAddress ?? guardianOf(company);

  // ── 1. ASK THE TOKEN'S LOGS (B1 gate A3) ────────────────────────────────────────────────
  //
  // Not "read the receipt of the hash we broadcast". A signed authorization is public and
  // self-authorizing, so the transaction that settles it need not be ours — a relayer, another
  // process, or anyone holding the bytes can mine it, after which OUR transaction reverts with
  // `authorization is used` and a receipt-based reader concludes `failed` for a payment whose
  // money is at the revenue address. The logs name the authorizer and the nonce (both indexed)
  // and, with the matching Transfer, say the payee got the amount.
  const outcome = await resolveAuthorizationOutcome({
    client: deps.executor.publicClient,
    usdc: deps.executor.usdc,
    authorizer: guardian,
    nonce: row.nonce,
    payTo: row.payTo,
    value: row.amountUsdc,
    fromBlock: row.quotedBlock === null ? null : BigInt(row.quotedBlock),
  });
  if (outcome.kind === "settled") {
    const result = finishSettle(deps, company, row, {
      kind: "settled",
      txHash: outcome.txHash,
      // The chain knows what it cost; we only observed it. Reporting 0 here rather than
      // pretending is the honest shape, and nothing but an ops line reads it.
      gasUsed: 0n,
    });
    if (result.ok && result.status === "settled") return "settled";
    // The CAS was lost (something else moved the row first). Nothing to do.
    return "pending";
  }
  if (outcome.kind === "cancelled") {
    // An out-of-band cancellation — the guardian cancelled through some other client, or our own
    // cancel route confirmed and crashed before writing. The nonce is retired: nothing can ever
    // settle it, and expiring is what lets them re-quote.
    return expire(deps, company, row, "cancelled-on-chain") ? "expired" : "pending";
  }

  // ── 2. UNKNOWN. Never a failure — decide only whether to wait, expire or try again ────────
  //
  // A nonce the token reports as SPENT while the logs say nothing is the case where our window
  // missed it (a pruned endpoint, a lagging node). Re-broadcasting there would revert and be
  // read as a failure; expiring would invite a second payment for a company already paid for.
  // Waiting is the only move that cannot cost anyone money.
  if (await authorizationUsed(deps.executor, guardian, row.nonce)) {
    opsLog("formation_payment_pending", {
      level: "warn",
      companyId: company.companyId,
      paymentId: row.paymentId,
      reason: "nonce is spent but no AuthorizationUsed/Canceled log is visible — NOT expiring",
    });
    // An attempt is burned even here, so the backoff spaces the chain reads out rather than
    // asking the same unanswerable question every tick.
    if (row.status === "settling") deps.payment.payments.bumpAttempt(row.paymentId);
    return "pending";
  }

  // EXPIRY, ON THE CHAIN'S CLOCK AND WITH A MARGIN (gate A4). Three conditions, all of them
  // already established here: the logs say nothing (above), the nonce is unused (above), and the
  // block timestamp is past `validBefore` by more than a block-timestamp's worth of slack. The
  // server's own clock is never enough — the token enforces `validBefore` against the BLOCK, so a
  // fast box would expire an authorization the chain still considers live.
  const chainNow = await chainTimeSec(deps.executor);
  if (chainNow !== null && chainNow > row.validBefore + FINALITY_MARGIN_S)
    return expire(deps, company, row, "window-closed") ? "expired" : "pending";

  if (!row.signature) {
    // A `quoted` row has no signature and never had one — there is nothing to re-submit, and
    // waiting for its window to close is the whole of its life. A `settling` row without one
    // should be impossible (`markSettling` writes it in the same statement that sets the status);
    // if it ever happens, waiting is still the safe behaviour, because the guardian's
    // authorization may have been broadcast by something we cannot see.
    if (row.status === "settling") {
      opsLog("formation_payment_pending", {
        level: "warn",
        companyId: company.companyId,
        paymentId: row.paymentId,
        reason: "settling row with no persisted authorization signature",
      });
      deps.payment.payments.bumpAttempt(row.paymentId);
    }
    return "pending";
  }

  // ── 3. RE-BROADCAST — composed FRESH around the same signature (B1 gate A1) ───────────────
  //
  // The previous attempt's submitter nonce may have been consumed by something else entirely
  // while we were down; this one takes the current pending nonce and a bumped fee, so a stalled
  // settle is not stranded by a number that has nothing to do with the guardian.
  deps.payment.payments.bumpAttempt(row.paymentId);
  const broadcastOutcome = await broadcast(
    deps,
    row.paymentId,
    {
      from: guardian,
      to: row.payTo,
      value: row.amountUsdc,
      validAfter: 0n,
      validBefore: BigInt(row.validBefore),
      nonce: row.nonce,
    },
    row.signature,
    row.broadcastCount,
  );
  const result = finishSettle(deps, company, row, broadcastOutcome);
  if (result.ok && result.status === "settled") return "settled";
  if (!result.ok) return "failed";
  return "pending";
}

/**
 * ⚠ THE DETECTOR (B1 gate A5): has this company paid MORE THAN ONCE?
 *
 * Everything in this feature is built so that it cannot happen — one live row per company by a
 * unique index, a `quoted`-only CAS on the settle, a resume that never re-quotes, an expiry that
 * needs the chain's own evidence. All of which is an argument, and an argument is not a
 * measurement. This counts.
 *
 * It is deliberately loud: CRITICAL in the ops trail AND an entity event on every agent attached
 * to the company, because the person who needs to know is the one who was charged twice, and the
 * only acceptable way to find out is from us rather than from them. It changes nothing on its
 * own — a refund is a human decision made at a Ledger — and reversing money automatically on the
 * strength of a COUNT would be a worse bug than the one it is watching for.
 *
 * Called on every terminal transition (cheap: one indexed COUNT) and by an amortised sweep.
 */
export function checkForDoublePayment(
  deps: Pick<FormationPaymentDeps, "payment" | "entities">,
  companyId: string,
): boolean {
  const paid = deps.payment.payments.countPaid(companyId);
  if (paid <= 1) return false;
  opsLog("formation_payment_duplicate", {
    severity: "CRITICAL",
    level: "error",
    companyId,
    paidRows: paid,
    detail: "this company has more than one settled/refunded formation payment",
  });
  if (deps.entities)
    recordCompanyEvent(
      deps.entities,
      companyId,
      "formation_payment_duplicate",
      `${paid} paid formation payments exist for this company — a refund decision is needed`,
    );
  return true;
}

/** `quoted|settling → expired`, ops-logged. Returns whether THIS caller made the move. */
export function expire(
  deps: FormationPaymentDeps,
  company: CompanyRecord,
  row: FormationPaymentRecord,
  reason: string,
): boolean {
  const moved = deps.payment.payments.markExpired(row.paymentId, row.status);
  if (moved)
    opsLog("formation_payment_expired", {
      companyId: company.companyId,
      paymentId: row.paymentId,
      reason,
    });
  return moved;
}

/**
 * THE GUARDIAN CANCEL FAST PATH (§6.4 rule 3).
 *
 * Without it, a payment whose broadcast outcome we never saw sits `settling` until its window
 * closes — up to the whole quote TTL — and the guardian can do nothing but wait. With it they
 * sign a second, different message (`CancelAuthorization(authorizer, nonce)`), our executor
 * submits it, and the nonce is retired on-chain the moment it confirms.
 *
 * ⚠ The platform CANNOT do this alone, and that is the design rather than a limitation: the token
 * verifies the AUTHORIZER's signature. An authorization is the guardian's promise, and only they
 * withdraw it — we merely carry the letter.
 */
export async function cancelFormationPayment(
  deps: FormationPaymentDeps,
  company: CompanyRecord,
  body: { signature: Hex },
): Promise<{ ok: true; txHash: Hex } | { ok: false; reason: string }> {
  const row = deps.payment.payments.findLive(company.companyId, FORMATION_PRODUCT);
  if (!row) return { ok: false, reason: "no live payment for this company" };
  const guardian = row.payerAddress ?? guardianOf(company);

  // Verified LOCALLY first, exactly as the settle is: an invalid cancel would revert on-chain and
  // cost the platform gas for a message that was never the guardian's.
  let recovered: boolean;
  try {
    recovered = await verifyTypedData({
      address: guardian,
      domain: deps.payment.domain,
      types: CANCEL_AUTHORIZATION_TYPES,
      primaryType: "CancelAuthorization",
      message: { authorizer: guardian, nonce: row.nonce },
      signature: body.signature,
    });
  } catch {
    recovered = false;
  }
  if (!recovered)
    return {
      ok: false,
      reason: "the cancellation must be signed by this company's guardian wallet",
    };

  const outcome = await submitCancelAuthorization(
    deps.executor,
    guardian,
    row.nonce,
    body.signature,
  );
  if (outcome.kind !== "settled")
    return {
      ok: false,
      reason:
        outcome.kind === "reverted"
          ? "the cancellation reverted on-chain — the authorization may already have been used"
          : "the cancellation was submitted but has not confirmed yet — check again shortly",
    };

  // The nonce is retired on-chain, so the row is dead whatever it said a moment ago.
  expire(deps, company, row, "guardian-cancelled");
  return { ok: true, txHash: outcome.txHash };
}

/**
 * RE-QUOTE — deliberately its own step (§6.4).
 *
 * "Expire then re-quote" is two calls rather than one because the first is a claim about the
 * CHAIN (this authorization can never settle) and the second is a promise to the guardian (this
 * is what you owe now). Fusing them would let a UI re-quote its way out of a `settling` row whose
 * transfer was still in flight, which is the double charge in its most natural disguise.
 *
 * The live-rows unique index is the backstop: a new row is insertable only once the old one is
 * terminal, so even a caller that ignored this rule gets a constraint violation rather than two
 * live authorizations.
 */
export function requoteFormationPayment(
  deps: FormationPaymentDeps,
  company: CompanyRecord,
): { ok: true; quote: FormationQuote } | { ok: false; reason: string } {
  const live = deps.payment.payments.findLive(company.companyId, FORMATION_PRODUCT);
  if (live)
    return {
      ok: false,
      reason:
        live.status === "quoted"
          ? "this company already has a live quote"
          : "this payment is still settling — cancel it or wait for it to finish before re-quoting",
    };
  if (company.status !== "draft")
    return { ok: false, reason: "this company has nothing left to pay for" };

  const paymentId = insertQuote(deps.payment, company.companyId, nowMs(deps));
  const row = deps.payment.payments.find(paymentId);
  if (!row) return { ok: false, reason: "could not create a quote" };
  opsLog("formation_payment_quoted", {
    companyId: company.companyId,
    paymentId,
    product: row.product,
    amountUsdc: row.amountUsdc.toString(),
    validBefore: row.validBefore,
    requote: true,
  });
  return { ok: true, quote: quoteOf(row, guardianOf(company), deps.payment) };
}
