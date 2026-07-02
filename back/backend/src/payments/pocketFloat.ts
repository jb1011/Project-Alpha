import type { Address, Hex } from "../types";

export interface SweepDeps {
  treasury: Address;
  usdc: Address;
  dust: bigint; // leave this much behind (gas reserve on Arc = USDC)
  pocketUsdcBalance: () => Promise<bigint>;
  transferToTreasury: (treasury: Address, amount: bigint) => Promise<Hex>; // pocket-signed ERC-20 transfer
}

/** Sweep the pocket EOA's residual USDC back to the treasury, keeping standing float ~zero.
 *  Gateway-held balance is NOT withdrawable via the current SDK wrapper — keep deposits JIT-minimal. */
export async function sweepPocketToTreasury(d: SweepDeps): Promise<Hex | null> {
  const bal = await d.pocketUsdcBalance();
  if (bal <= d.dust) return null;
  return d.transferToTreasury(d.treasury, bal - d.dust);
}
