import { getAddress, verifyTypedData } from "viem";
import { CANCEL_AUTHORIZATION_TYPES } from "../adapters/arc/usdcToken";
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
  type FormationExecutorDeps,
  authorizationUsed,
  broadcastAndConfirm,
  signCancelTx,
  signSettleTx,
} from "../payments/formationSettle";
import { verifyTransferAuthorization } from "../payments/transferAuthorization";
import type { CompanyRecord, CompanyRepository } from "../persistence/companyRepository";
import type { FormationPaymentRecord } from "../persistence/formationPaymentRepository";
import type { Address, Hex } from "../types";

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
  payment: FormationPaymentConfig;
  executor: FormationExecutorDeps;
  /** The company status move and the payment status move commit together. */
  transaction: <T>(fn: () => T) => T;
  now?: () => number;
}

export type SettleResult =
  | { ok: true; status: "settled"; txHash: Hex }
  /** Broadcast, outcome not yet observed. The row stays `settling` and the sweeper owns it. */
  | { ok: true; status: "pending"; txHash: Hex }
  | { ok: false; reason: string };

const nowMs = (deps: FormationPaymentDeps) => (deps.now ?? Date.now)();
const nowSec = (deps: FormationPaymentDeps) => Math.floor(nowMs(deps) / 1000);

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
  if (row.validBefore <= nowSec(deps))
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

  const authorization = {
    from: guardian,
    to: deps.payment.revenueAddress,
    value: row.amountUsdc.toString(),
    validAfter: "0",
    validBefore: String(row.validBefore),
    nonce: row.nonce,
  };
  const verdict = await verifyTransferAuthorization({
    authorization,
    signature: body.signature,
    domain: deps.payment.domain,
    payTo: deps.payment.revenueAddress,
    // THE STORED amount, never `deps.payment.feeAtomic`: a fee change between quote and settle
    // must not re-price a signature already given (§6.3).
    value: row.amountUsdc,
    mode: "exact",
    now: () => nowMs(deps),
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const signed = await signSettleTx(
    deps.executor,
    {
      from: guardian,
      to: deps.payment.revenueAddress,
      value: row.amountUsdc,
      validAfter: 0n,
      validBefore: BigInt(row.validBefore),
      nonce: row.nonce,
    },
    body.signature,
  );

  // PERSIST BEFORE BROADCAST. A crash after this line is recoverable — the sweeper re-broadcasts
  // these exact bytes. A crash before it has sent nothing.
  if (!deps.payment.payments.markSettling(row.paymentId, { payerAddress: from, ...signed }))
    return {
      ok: false,
      reason:
        "this payment is already being settled — wait for it to finish rather than signing again",
    };
  opsLog("formation_payment_settling", {
    companyId: company.companyId,
    paymentId: row.paymentId,
    amountUsdc: row.amountUsdc.toString(),
    txHash: signed.txHash,
  });

  return finishSettle(deps, company, row, await broadcastAndConfirm(deps.executor, signed));
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
  outcome: Awaited<ReturnType<typeof broadcastAndConfirm>>,
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
  return { ok: true, status: "pending", txHash: row.txHash ?? ("0x" as Hex) };
}

/**
 * RESUME a `settling` row whose outcome we never saw (§6.4) — the sweeper's per-row work.
 *
 * Three rules, in this order and for these reasons:
 *
 *  1. ask the CHAIN first. `authorizationState(from, nonce) === true` means the nonce is spent:
 *     either our transfer landed or the guardian cancelled it. Either way the row is over, and
 *     re-broadcasting would be a wasted transaction against a nonce the token has already
 *     retired;
 *  2. otherwise RE-BROADCAST the persisted bytes. Never re-quote — the guardian's signature is
 *     still live, and asking for a second one while the first can still be mined is the double
 *     charge this whole leg exists to prevent;
 *  3. only when `now > validBefore` AND the state still reads false is the authorization
 *     genuinely dead. Then, and only then, `expired`.
 */
export async function resumeSettlingPayment(
  deps: FormationPaymentDeps,
  company: CompanyRecord,
  row: FormationPaymentRecord,
): Promise<"settled" | "expired" | "failed" | "pending"> {
  const guardian = row.payerAddress ?? guardianOf(company);
  const used = await authorizationUsed(deps.executor, guardian, row.nonce);
  if (used) {
    // The nonce is spent. The receipt we hold a hash for is the evidence of WHICH way, and
    // `broadcastAndConfirm` re-reads it (the send is a no-op for an already-mined transaction).
    if (row.rawTx) {
      const outcome = await broadcastAndConfirm(deps.executor, {
        rawTx: row.rawTx,
        txHash: row.txHash as Hex,
      });
      const result = finishSettle(deps, company, row, outcome);
      if (result.ok && result.status === "settled") return "settled";
      if (!result.ok) return "failed";
    }
    // Spent, but not by a transaction we can produce a receipt for — the guardian cancelled it.
    // The authorization is dead, so the row is `expired` and a re-quote is the way forward.
    return expire(deps, company, row, "cancelled-on-chain") ? "expired" : "pending";
  }

  if (row.validBefore <= nowSec(deps))
    // Past its window AND never used: this authorization can no longer settle, whoever holds it.
    return expire(deps, company, row, "window-closed") ? "expired" : "pending";

  if (!row.rawTx) {
    // A `settling` row with no bytes should be impossible — `markSettling` writes them in the
    // same statement that sets the status. If it ever happens, waiting is still the safe
    // behaviour: the guardian's authorization may have been broadcast by something we cannot see.
    opsLog("formation_payment_pending", {
      level: "warn",
      companyId: company.companyId,
      paymentId: row.paymentId,
      reason: "settling row with no persisted raw transaction",
    });
    return "pending";
  }

  deps.payment.payments.bumpAttempt(row.paymentId);
  const outcome = await broadcastAndConfirm(deps.executor, {
    rawTx: row.rawTx,
    txHash: row.txHash as Hex,
  });
  const result = finishSettle(deps, company, row, outcome);
  if (result.ok && result.status === "settled") return "settled";
  if (!result.ok) return "failed";
  return "pending";
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

  const signed = await signCancelTx(deps.executor, guardian, row.nonce, body.signature);
  const outcome = await broadcastAndConfirm(deps.executor, signed);
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
