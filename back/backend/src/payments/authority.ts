import type { Address } from "../types";
import type { PaymentLedger } from "./ledger";
import { evaluatePolicy } from "./policyGate";

/** On-chain treasury state, read fresh at authorization time (governs the off-chain decision). */
export interface TreasuryState {
  available: bigint;
  paused: boolean;
  allowlistEnabled: boolean;
  isAllowed: boolean;
  legalActive: boolean;
}

export interface AuthorizeRequest {
  payee: Address;
  amount: bigint;
  resource: string;
  asset: Address;
  network: string;
  maxTimeoutSeconds: number;
}

export interface AuthorityDeps {
  ledger: PaymentLedger;
  /** The owning entity's idempotencyKey — scopes runningPending/recordAuthorized so one entity's
   *  pending spend never counts against another's cap. */
  entityKey: string;
  readTreasury: (payee: Address) => Promise<TreasuryState>;
  signX402: (req: AuthorizeRequest) => Promise<{ header: string; ledgerRef: string }>;
  perTxCap?: bigint; // optional per-transaction cap (off-chain enforcement)
  threshold?: bigint; // §14.1 hybrid: amount > threshold requires an allowlisted payee; forwarded to evaluatePolicy
}

export type AuthorizeResult =
  | { ok: true; header: string; ledgerId: number }
  | { ok: false; reason: string };

/**
 * The single chokepoint: read on-chain treasury state, evaluate policy, then — and only then —
 * record the pending spend and sign the x402 authorization. The agent holds no key and never reaches
 * the signer except through this gate, so it structurally cannot overspend. If signing fails after the
 * ledger entry is written, the entry is marked failed so it stops counting against the cap.
 */
export async function authorizePayment(
  d: AuthorityDeps,
  req: AuthorizeRequest,
): Promise<AuthorizeResult> {
  const t = await d.readTreasury(req.payee);
  const decision = evaluatePolicy({
    payee: req.payee,
    amount: req.amount,
    available: t.available,
    paused: t.paused,
    allowlistEnabled: t.allowlistEnabled,
    isAllowed: t.isAllowed,
    legalActive: t.legalActive,
    runningPending: d.ledger.runningPending(d.entityKey),
    perTxCap: d.perTxCap,
    threshold: d.threshold,
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };

  const id = d.ledger.recordAuthorized(d.entityKey, req.payee, req.amount);
  try {
    const signed = await d.signX402(req);
    return { ok: true, header: signed.header, ledgerId: id };
  } catch (e) {
    d.ledger.markFailed(id);
    throw e;
  }
}
