// backend/src/payments/funding.ts
import { formatUnits } from "viem";
import type { Address, Hex } from "../types";

export interface FundingDeps {
  treasury: Address;
  usdc: Address;
  pocketAddress: Address;
  available: () => Promise<bigint>; // treasury.available() — the cap layer
  fundOperator: (treasury: Address, amount: bigint) => Promise<Hex>; // enclave-sent
  operatorTransferUsdc: (usdc: Address, to: Address, amount: bigint) => Promise<Hex>; // enclave-sent
  depositToGateway: (amountUsdc: string) => Promise<unknown>; // pocket-signed (free)
}

/**
 * Move a bounded float treasury -> operator -> pocket -> Gateway, refusing anything over the cap.
 * The enclave signs only `fundOperator` + the forward (O(top-ups)); the pocket signs the deposit (free).
 */
export async function topUpPocket(d: FundingDeps, amount: bigint): Promise<void> {
  if (amount <= 0n) throw new Error("top-up amount must be positive");
  const available = await d.available();
  if (amount > available) throw new Error(`top-up ${amount} exceeds available ${available}`);
  await d.fundOperator(d.treasury, amount);
  await d.operatorTransferUsdc(d.usdc, d.pocketAddress, amount);
  await d.depositToGateway(formatUnits(amount, 6));
}
