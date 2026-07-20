import { PocketGateway } from "../adapters/x402/gateway";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import type { Config } from "../config/env";
import type { Address, EntityRecord, Hex } from "../types";

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

/** The pocket master seed is required to derive a per-agent pocket. */
function requirePocketMasterSeed(cfg: Pick<Config, "pocketMasterSeed">): Hex {
  if (!cfg.pocketMasterSeed) throw new Error("set POCKET_MASTER_SEED to run payments");
  return cfg.pocketMasterSeed;
}

/** The narrowed reader surface `buildReadExposure` needs — satisfied by both `ArcAdapter` and
 *  `entityPayment.ts`'s `TreasuryReader`. */
export interface ExposureBalanceReader {
  usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint>;
}

/**
 * Build a per-entity `readStandingExposure` closure: derives the pocket key from
 * `cfg.pocketMasterSeed` + the entity's idempotency key, constructs a throwaway `PocketGateway`,
 * and sums operator EOA + pocket EOA + Gateway via `readStandingExposure` above. Shared wiring for
 * `entityPayment.status()` (`payments/entityPayment.ts`) and `GET /entities/:id/treasury`
 * (`api/routes/treasury.ts`) so both compute standing exposure identically — do not duplicate this
 * closure elsewhere.
 */
export function buildReadExposure(
  cfg: Pick<Config, "pocketMasterSeed" | "rpcUrl" | "usdc">,
  reader: ExposureBalanceReader,
): (entity: EntityRecord) => Promise<StandingExposure> {
  return (entity: EntityRecord) => {
    const pocketKey = derivePocketKey(requirePocketMasterSeed(cfg), entity.idempotencyKey);
    const gateway = new PocketGateway({ pocketPrivateKey: pocketKey, rpcUrl: cfg.rpcUrl });
    return readStandingExposure({
      usdcBalanceOf: (owner) =>
        reader.usdcBalanceOf(entity.treasuryConfig?.usdc ?? cfg.usdc, owner),
      gatewayAvailable: () => gateway.getAvailable(),
      operator: entity.operator as Address,
      pocket: gateway.address,
    });
  };
}
