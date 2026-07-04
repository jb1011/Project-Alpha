// backend/src/payments/funding.ts
import { formatUnits } from "viem";
import type { Address, Hex } from "../types";

export interface FundingDeps {
  treasury: Address;
  usdc: Address;
  pocketAddress: Address;
  available: () => Promise<bigint>; // treasury.available() — the cap layer
  fundOperator: (treasury: Address, amount: bigint) => Promise<Hex>; // enclave-sent
  operatorUsdcBalance: () => Promise<bigint>; // operator EOA's USDC balance — confirms fundOperator propagated
  operatorTransferUsdc: (usdc: Address, to: Address, amount: bigint) => Promise<Hex>; // enclave-sent
  depositToGateway: (amountUsdc: string) => Promise<Hex>; // pocket-signed (free)
}

/** Tuning for the read-after-write balance poll between the fund and forward legs (overridable in tests). */
export interface TopUpOptions {
  pollAttempts?: number; // how many times to read the operator balance before giving up
  pollDelayMs?: number; // wait between reads
  sleep?: (ms: number) => Promise<void>; // injectable so tests don't spend real wall-clock
  /** When true, the operator already holds the fundOperator credit (a retry completing a partial
   *  bridge) — skip fundOperator + the cap check + awaitOperatorFunded so the treasury isn't
   *  double-pulled. Returns [forward, deposit] (2 hashes) instead of [fundOperator, forward, deposit]. */
  skipFundOperator?: boolean;
}

const DEFAULT_POLL_ATTEMPTS = 12;
const DEFAULT_POLL_DELAY_MS = 1_500;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry-safety guard: true when the operator already holds the fundOperator credit (a re-run
 *  completing a partial bridge), so the treasury must NOT be pulled again. `operatorBalance` and
 *  `seedTargetAtomic` are 6-dec atomic USDC; the seed lands the operator at exactly seedTargetAtomic,
 *  and a landed credit pushes it to ~seedTargetAtomic + amount (minus small gas). The amount/2 margin
 *  separates the two while tolerating gas — but note it FALSE-NEGATIVES (re-pulls) for tiny amounts
 *  where gas erodes more than amount/2 (roughly amount < ~2x forward gas); acceptable per the design's
 *  documented partial-state limitation, and it over-funds only the agent's own float within cap. */
export function shouldSkipFundOperator(
  operatorBalance: bigint,
  seedTargetAtomic: bigint,
  amount: bigint,
): boolean {
  return operatorBalance >= seedTargetAtomic + amount / 2n;
}

/** Retry `fn` on a transient read-after-write revert (a lagging RPC eth_call seeing stale balance).
 *  Retry is scoped to insufficient-balance reverts ONLY — those mean the tx moved no funds (a
 *  pre-write simulate revert, or a no-op on-chain revert), so a retry cannot double-spend. A tx that
 *  actually transferred never produces this message; a lost-receipt/timeout is a different error and
 *  is rethrown (not retried). */
export async function retryOnStaleBalance<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void> },
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /exceeds balance|insufficient|transfer amount exceeds/i.test(msg);
      if (!transient || i === opts.attempts - 1) throw e;
      await opts.sleep(opts.delayMs);
    }
  }
  throw last ?? new Error("retryOnStaleBalance: attempts must be >= 1");
}

/**
 * Poll the operator's USDC balance until it reflects at least `min`. After `fundOperator`'s receipt is
 * mined the funds are on-chain, but the node that serves `operatorTransferUsdc`'s simulate (eth_call) can
 * still be a block or two behind — forwarding immediately reverts "transfer amount exceeds balance". This
 * closes that read-after-write gap, and fails loudly rather than firing a doomed forward if it never catches up.
 */
async function awaitOperatorFunded(
  read: () => Promise<bigint>,
  min: bigint,
  attempts: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let last = 0n;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (last >= min) return;
    if (i < attempts - 1) await sleep(delayMs);
  }
  throw new Error(
    `operator USDC balance ${last} did not reach ${min} after ${attempts} reads — fundOperator may not have propagated`,
  );
}

/**
 * Move a bounded float treasury -> operator -> pocket -> Gateway, refusing anything over the cap.
 * The enclave signs only `fundOperator` + the forward (O(top-ups)); the pocket signs the deposit (free).
 */
export async function topUpPocket(
  d: FundingDeps,
  amount: bigint,
  opts: TopUpOptions = {},
): Promise<Hex[]> {
  if (amount <= 0n) throw new Error("top-up amount must be positive");
  const attempts = opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const delayMs = opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const bridge: Hex[] = [];
  if (!opts.skipFundOperator) {
    const available = await d.available();
    if (amount > available) throw new Error(`top-up ${amount} exceeds available ${available}`);
    const fundHash = await d.fundOperator(d.treasury, amount);
    await awaitOperatorFunded(d.operatorUsdcBalance, amount, attempts, delayMs, sleep);
    bridge.push(fundHash);
  }
  const forwardHash = await retryOnStaleBalance(
    () => d.operatorTransferUsdc(d.usdc, d.pocketAddress, amount),
    { attempts, delayMs, sleep },
  );
  const depositHash = await retryOnStaleBalance(() => d.depositToGateway(formatUnits(amount, 6)), {
    attempts,
    delayMs,
    sleep,
  });
  bridge.push(forwardHash, depositHash);
  return bridge;
}
