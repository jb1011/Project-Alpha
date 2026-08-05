import type { EntityRecord } from "../types";

/**
 * Tier-0 custody-provider dispatch (spec 2026-08-03, audit item 4). Every surface that signs or
 * sends as the agent forks on this: `turnkey` (passkey-rooted sub-org EOA — the default, and the
 * only value legacy rows can have) vs `circle` (Novi-managed DevC SCA operator + EOA pocket).
 * The pocket is platform-custody on BOTH paths; only the OPERATOR carries the custody choice.
 */
export type WalletProvider = "turnkey" | "circle";

export function providerOf(entity: Pick<EntityRecord, "walletProvider">): WalletProvider {
  return entity.walletProvider === "circle" ? "circle" : "turnkey";
}

/** The circle-path wallet fields a signing/sending surface needs. Fail loudly and name the gap —
 *  a half-provisioned circle agent must never limp into a runtime signature failure. */
export function requireCircleWallets(entity: EntityRecord): {
  operatorWalletId: string;
  pocketWalletId: string;
  pocketAddress: string;
} {
  const { circleOperatorWalletId, circlePocketWalletId, pocketAddress } = entity;
  if (!circleOperatorWalletId || !circlePocketWalletId || !pocketAddress)
    throw new Error(
      `entity ${entity.idempotencyKey} is on the circle custody path but is missing ` +
        `circle wallet fields (operatorWalletId=${circleOperatorWalletId ?? "∅"}, ` +
        `pocketWalletId=${circlePocketWalletId ?? "∅"}, pocketAddress=${pocketAddress ?? "∅"})`,
    );
  return {
    operatorWalletId: circleOperatorWalletId,
    pocketWalletId: circlePocketWalletId,
    pocketAddress,
  };
}
