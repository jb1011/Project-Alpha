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
}

const DEFAULT_POLL_ATTEMPTS = 12;
const DEFAULT_POLL_DELAY_MS = 1_500;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const available = await d.available();
  if (amount > available) throw new Error(`top-up ${amount} exceeds available ${available}`);
  const fundHash = await d.fundOperator(d.treasury, amount);
  await awaitOperatorFunded(
    d.operatorUsdcBalance,
    amount,
    opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS,
    opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS,
    opts.sleep ?? defaultSleep,
  );
  const forwardHash = await d.operatorTransferUsdc(d.usdc, d.pocketAddress, amount);
  const depositHash = await d.depositToGateway(formatUnits(amount, 6));
  return [fundHash, forwardHash, depositHash];
}
