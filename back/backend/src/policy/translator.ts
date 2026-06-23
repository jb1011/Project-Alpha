import type { Address, TreasuryConfig } from "../types";
import type { AgentSpec } from "./agentSpec";
import { parseDuration, usdToUnits } from "./units";

/** On-chain bounds duplicated from the contracts so we fail fast OFF-chain with clear messages. */
const MIN_AMENDMENT_DELAY = 3_600n; // LegalManager.MIN_AMENDMENT_DELAY (1h); also AgentTreasury.MIN_POLICY_DELAY
const MAX_POLICY_PERIOD = 31_536_000n; // AgentTreasury.MAX_POLICY_PERIOD (365d)

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

export interface TranslateResult {
  manager: Address;
  guardian: Address;
  /** Present only if pinned in the spec; otherwise filled by the Turnkey step in the saga. */
  operator?: Address;
  amendmentDelay: bigint;
  treasury: TreasuryConfig;
  legal: { ein: string; formationDate: number };
}

function isoToUnix(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms))
    throw new TranslationError(`legal.formationDate is not a valid date: "${iso}"`);
  return Math.floor(ms / 1000);
}

/**
 * PURE law→code translation: an agent spec + the platform USDC default → the precise
 * on-chain parameter tuple (amendmentDelay, TreasuryConfig, roles, legal stub).
 * No I/O, no clock, no chain reads — fully deterministic and unit-tested.
 */
export function translate(spec: AgentSpec, defaults: { usdc: Address }): TranslateResult {
  const amendmentDelay = parseDuration(spec.governance.amendmentDelay);
  if (amendmentDelay < MIN_AMENDMENT_DELAY) {
    throw new TranslationError(`governance.amendmentDelay must be >= 1h (got ${amendmentDelay}s)`);
  }

  const period = parseDuration(spec.treasury.spendingPeriod);
  if (period === 0n) throw new TranslationError("treasury.spendingPeriod must be > 0");
  if (period > MAX_POLICY_PERIOD) {
    throw new TranslationError(`treasury.spendingPeriod must be <= 365d (got ${period}s)`);
  }

  const cap = usdToUnits(spec.treasury.spendingCapUsdc);
  const usdc = (spec.treasury.usdc ?? defaults.usdc) as Address;
  const payoutAddress = spec.treasury.payoutAddress as Address;
  const manager = spec.roles.manager as Address;
  const guardian = spec.roles.guardian as Address;
  const operator = spec.roles.operator as Address | undefined;

  // Role distinctness the contract enforces (RolesMustDiffer + payout != operator).
  if (manager.toLowerCase() === guardian.toLowerCase()) {
    throw new TranslationError("roles.manager and roles.guardian must be distinct");
  }
  if (operator) {
    const lc = operator.toLowerCase();
    if (lc === manager.toLowerCase() || lc === guardian.toLowerCase()) {
      throw new TranslationError("roles.operator must be distinct from manager and guardian");
    }
    if (lc === payoutAddress.toLowerCase()) {
      throw new TranslationError(
        "treasury.payoutAddress must not equal the operator (safe-sink rule)",
      );
    }
  }

  const ein = spec.legal.ein ?? "STUB-NOT-FILED";
  const formationDate = spec.legal.formationDate ? isoToUnix(spec.legal.formationDate) : 0;

  return {
    manager,
    guardian,
    operator,
    amendmentDelay,
    treasury: {
      usdc,
      payoutAddress,
      cap,
      period,
      allowlistEnabled: spec.treasury.allowlistEnabled,
    },
    legal: { ein, formationDate },
  };
}

/**
 * Late check used by the saga once the operator address is known (Turnkey step): re-validate the
 * operator-dependent distinctness rules. Throws TranslationError on violation.
 */
export function assertOperatorDistinct(r: TranslateResult, operator: Address): void {
  const lc = operator.toLowerCase();
  if (lc === r.manager.toLowerCase() || lc === r.guardian.toLowerCase()) {
    throw new TranslationError("operator must be distinct from manager and guardian");
  }
  if (lc === r.treasury.payoutAddress.toLowerCase()) {
    throw new TranslationError(
      "treasury.payoutAddress must not equal the operator (safe-sink rule)",
    );
  }
}
