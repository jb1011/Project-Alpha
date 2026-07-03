import { buildOperatorWalletClientForEntity } from "../adapters/turnkey/operatorWallet";
import { fundPocket, requireVaultOperator } from "../agent/liveRunner";
import type { Config } from "../config/env";
import type { Address, EntityRecord } from "../types";

/** Explicitly top up an entity's per-agent pocket Gateway float (treasury -> operator -> pocket ->
 *  Gateway). Returns the on-chain tx hashes. Injectable seam so the MCP tool / REST route can be
 *  tested without touching Turnkey or the chain. */
export type PocketFundingFn = (entity: EntityRecord, amountAtomic: bigint) => Promise<string[]>;

/** Real composition: reuses the same funding leg as the standalone liveRunner (fundPocket +
 *  requireVaultOperator), just entered from a per-request entity record instead of the live demo's
 *  single resolved treasury. */
export function buildPocketFunding(cfg: Config): PocketFundingFn {
  return async (entity, amount) => {
    if (!entity.treasury) throw new Error("treasury not ready");
    const vault = requireVaultOperator(entity.treasury, entity);
    const operatorWallet = await buildOperatorWalletClientForEntity(cfg, vault);
    return fundPocket(
      cfg,
      entity.treasury as Address,
      amount,
      operatorWallet,
      entity.idempotencyKey,
    );
  };
}
