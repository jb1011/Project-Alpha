export interface PolicyInput {
  /** The payee, in whatever form its rail names one: an EVM address on Arc, a `0.0.x` account id
   *  on Hedera. This gate never parses it — it only ever hands it to `isAllowed`, which the
   *  caller has already resolved — so a `string` is the honest type and the widening changes no
   *  behaviour on the Arc path. */
  payee?: string;
  amount: bigint; // USDC base units (6 decimals)
  available: bigint; // treasury.available() at check time
  paused: boolean;
  allowlistEnabled: boolean;
  isAllowed: boolean; // payee ∈ allowlist (consulted only when allowlistEnabled)
  runningPending: bigint; // sum of ledger entries authorized-but-not-yet-settled this window
  perTxCap?: bigint; // optional per-transaction cap (off-chain; on-chain per-period cap is the hard guardrail)
  threshold?: bigint; // §14.1 hybrid: amount > threshold requires an allowlisted payee; undefined = rule off
  legalActive: boolean; // LegalManager status() === 0 at check time; mirrors on-chain _requireSpendable
}

export type PolicyReason =
  | "zero-amount"
  | "paused"
  | "legal-not-active"
  | "not-allowlisted"
  | "over-threshold-needs-allowlist"
  | "over-tx-cap"
  | "over-cap";
export type PolicyDecision = { ok: true } | { ok: false; reason: PolicyReason };

/** Deterministic, side-effect-free. The single source of truth for "may the agent pay this?". */
export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  if (i.amount <= 0n) return { ok: false, reason: "zero-amount" };
  if (i.paused) return { ok: false, reason: "paused" };
  if (!i.legalActive) return { ok: false, reason: "legal-not-active" };
  if (i.allowlistEnabled && !i.isAllowed) return { ok: false, reason: "not-allowlisted" };
  if (i.threshold !== undefined && i.amount > i.threshold && !i.isAllowed)
    return { ok: false, reason: "over-threshold-needs-allowlist" };
  if (i.perTxCap !== undefined && i.amount > i.perTxCap)
    return { ok: false, reason: "over-tx-cap" };
  if (i.runningPending + i.amount > i.available) return { ok: false, reason: "over-cap" };
  return { ok: true };
}
