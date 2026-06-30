import type { Address } from "../types";

export interface PolicyInput {
  payee?: Address;
  amount: bigint; // USDC base units (6 decimals)
  available: bigint; // treasury.available() at check time
  paused: boolean;
  allowlistEnabled: boolean;
  isAllowed: boolean; // payee ∈ allowlist (consulted only when allowlistEnabled)
  runningPending: bigint; // sum of ledger entries authorized-but-not-yet-settled this window
  perTxCap?: bigint; // optional per-transaction cap (off-chain; on-chain per-period cap is the hard guardrail)
}

export type PolicyReason =
  | "zero-amount"
  | "paused"
  | "not-allowlisted"
  | "over-tx-cap"
  | "over-cap";
export type PolicyDecision = { ok: true } | { ok: false; reason: PolicyReason };

/** Deterministic, side-effect-free. The single source of truth for "may the agent pay this?". */
export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  if (i.amount <= 0n) return { ok: false, reason: "zero-amount" };
  if (i.paused) return { ok: false, reason: "paused" };
  if (i.allowlistEnabled && !i.isAllowed) return { ok: false, reason: "not-allowlisted" };
  if (i.perTxCap !== undefined && i.amount > i.perTxCap)
    return { ok: false, reason: "over-tx-cap" };
  if (i.runningPending + i.amount > i.available) return { ok: false, reason: "over-cap" };
  return { ok: true };
}
