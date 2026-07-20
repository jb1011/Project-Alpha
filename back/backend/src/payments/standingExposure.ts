import type { Address } from "../types";

export interface StandingExposure {
  operatorEoa: bigint; // operator hot EOA USDC (in-transit fundOperator credits + job residue + gas seed)
  pocketEoa: bigint; // pocket EOA USDC (pre-deposit + gas seed + un-swept residual)
  gateway: bigint; // pocket's Gateway balance (un-withdrawable standing float), conservative floor
  total: bigint; // operatorEoa + pocketEoa + gateway
}

export interface StandingExposureDeps {
  usdcBalanceOf: (owner: Address) => Promise<bigint>; // atomic USDC balance of an EOA
  gatewayAvailable: () => Promise<number>; // PocketGateway.getAvailable() — decimal USDC
  operator: Address;
  pocket: Address;
}

/** Total un-clawback-able standing exposure for one agent's pocket, atomic USDC (6 decimals). */
export async function readStandingExposure(d: StandingExposureDeps): Promise<StandingExposure> {
  const [operatorEoa, pocketEoa, gwDecimal] = await Promise.all([
    d.usdcBalanceOf(d.operator),
    d.usdcBalanceOf(d.pocket),
    d.gatewayAvailable(),
  ]);
  const gateway = BigInt(Math.floor(gwDecimal * 1e6)); // conservative floor, mirrors entityPayment.ts
  return { operatorEoa, pocketEoa, gateway, total: operatorEoa + pocketEoa + gateway };
}
