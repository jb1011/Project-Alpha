/**
 * The Hedera half of "may this agent pay?" — the SAME policy engine, fed different facts.
 *
 * `evaluatePolicy` (payments/policyGate.ts) stays the one definition of the rule on both rails;
 * all this module does is build its input from what Hedera can actually tell us. Three of those
 * facts differ from Arc in ways worth naming, because each one is a place where the obvious
 * answer would be wrong:
 *
 *  - **`available` is the FLOAT BALANCE, not a treasury allowance (D14).** On Hedera the agent
 *    holds its own USDC in a self-custodied account; there is no on-chain leash to read. The only
 *    honest ceiling is what the account actually holds, read from the mirror node.
 *  - **`runningPending` is 0 (D8).** The server never authorizes a Hedera payment and never
 *    signs one — the client does, and tells us afterwards. So there is no authorized-but-unsettled
 *    window for this rail to carry, and pretending there is one would double-count the agent's
 *    own spend against it.
 *  - **`isAllowed` is ALWAYS false (D15).** The allowlist is an Arc treasury contract's state,
 *    keyed by EVM address. A Hedera `0.0.x` account id is not in it and cannot be, so the two
 *    rules that consult it (`allowlistEnabled` and the hybrid threshold) fail CLOSED here. That
 *    is deliberate: an agent wanting to move more than the threshold on Hedera does it on Arc,
 *    where the guardian can actually allowlist the payee.
 *
 * Standing comes from the same two Arc reads as everywhere else (`readStanding`'s pair), because
 * a legal body suspended on Arc is suspended for its Hedera spending too — the legal body is one
 * thing with one status, whatever rail the money moves on. A read that THREW yields
 * `legalActive: false`: D8 says an unknown is never an allow.
 */

import type { HederaConfig } from "../config/env";
import type { PaymentLedger } from "../payments/ledger";
import type { LegalBodyChainReads } from "../payments/legalBody";
import type { PolicyInput } from "../payments/policyGate";
import type { Address, EntityRecord } from "../types";
import type { HederaMirror } from "./mirror";

/** The CAIP-2 id of the one Hedera network this rail serves. Written into `payments_ledger.network`
 *  and demanded of every tool argument, so a row's rail is never inferred from its shape. */
export const HEDERA_CAIP2 = "hedera:testnet";

/**
 * Everything the Hedera tools need, as ONE optional object on `ApiDeps` — present exactly when
 * `HEDERA_ENABLED` produced a whole `cfg.hedera` block, absent otherwise, and the three tools are
 * not registered at all without it.
 */
export interface HederaDeps {
  cfg: HederaConfig;
  mirror: HederaMirror;
  ledger: PaymentLedger;
  /** `cfg.spendAllowlistThreshold`, the SAME value `entityPayment.ts` forwards for Arc, copied in
   *  at the composition root so the two rails cannot drift to different hybrid thresholds. */
  spendAllowlistThreshold: bigint;
}

/** Build `evaluatePolicy`'s input for a Hedera payment. Reads the mirror node and the Arc chain. */
export async function hederaPolicyInput(args: {
  entity: EntityRecord;
  amount: bigint;
  payee: string;
  reads: LegalBodyChainReads;
  mirror: HederaMirror;
  usdcTokenId: string;
  perTxCap?: bigint;
  allowlistEnabled: boolean;
  threshold?: bigint;
}): Promise<PolicyInput> {
  const { entity, mirror, usdcTokenId } = args;
  const available = await mirror.tokenBalance(entity.hederaAccountId ?? "", usdcTokenId);
  // Both reads in ONE try, exactly as `readStanding` does them, so a partial answer is never
  // mixed with a failed one. A throw is not a "no" about the treasury — it is a "we do not
  // know", and the only safe projection of that onto a two-field shape is an inactive body.
  let legalActive = false;
  let paused = false;
  try {
    const [status, isPaused] = await Promise.all([
      args.reads.legalStatus(entity.proxy as Address),
      args.reads.treasuryPaused(entity.treasury as Address),
    ]);
    legalActive = status === 0;
    paused = isPaused;
  } catch {
    legalActive = false;
    paused = false;
  }
  return {
    payee: args.payee,
    amount: args.amount,
    available,
    paused,
    allowlistEnabled: args.allowlistEnabled,
    isAllowed: false,
    runningPending: 0n,
    perTxCap: args.perTxCap,
    threshold: args.threshold,
    legalActive,
  };
}
