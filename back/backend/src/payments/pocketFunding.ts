import { http, createPublicClient } from "viem";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import type { CircleWalletsApi } from "../adapters/circle/circleWallets";
import { buildOperatorWalletClientForEntity } from "../adapters/turnkey/operatorWallet";
import { readGatewayAvailableByAddress } from "../adapters/x402/gatewayRead";
import { arcBatchingConfig } from "../adapters/x402/pocket";
import { fundPocket, requireVaultOperator } from "../agent/liveRunner";
import { chainFor } from "../chains";
import type { Config } from "../config/env";
import type { SqliteBridgeLegRepository } from "../persistence/bridgeLegRepository";
import { usdToUnits } from "../policy/units";
import type { Address, EntityRecord } from "../types";
import { runCircleBridge } from "./circleBridge";
import { withKeyedLock } from "./keyedMutex";
import { providerOf, requireCircleWallets } from "./provider";
import { readStandingExposure } from "./standingExposure";

/** Explicitly top up an entity's per-agent pocket Gateway float. Returns the on-chain tx hashes.
 *  Injectable seam so the MCP tool / REST route can be tested without touching custody providers
 *  or the chain. */
export type PocketFundingFn = (entity: EntityRecord, amountAtomic: bigint) => Promise<string[]>;

/** Tier-0: the circle-path funding bundle (absent on turnkey-only deployments). */
export interface CircleFundingDeps {
  api: CircleWalletsApi;
  legs: SqliteBridgeLegRepository;
}

/** Real composition, provider-dispatched (Tier-0 audit item 4):
 *  - `turnkey`: the existing enclave-signed bridge (gas seed + fundOperator + forward + deposit).
 *  - `circle`:  the persisted three-leg SCA bridge (fundOperator + approve + depositFor) via
 *    Circle contractExecution — no gas seed (Gas Station), no pocket hop, saga-resumable. */
export function buildPocketFunding(
  cfg: Config,
  outflows?: {
    record(path: "gas_seed" | "gas_sponsorship", amountAtomic: bigint, ref: string | null): void;
  },
  circle?: CircleFundingDeps,
): PocketFundingFn {
  return async (entity, amount) => {
    if (!entity.treasury) throw new Error("treasury not ready");

    if (providerOf(entity) === "circle") {
      if (!circle)
        throw new Error(
          `entity ${entity.idempotencyKey} is on the circle custody path but no Circle client is configured (CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET)`,
        );
      const wallets = requireCircleWallets(entity);
      const treasury = entity.treasury as Address;
      const usdc = (entity.treasuryConfig?.usdc ?? cfg.usdc) as Address;
      const pub = createPublicClient({
        chain: chainFor(cfg.chainId, cfg.rpcUrl),
        transport: http(cfg.rpcUrl),
      });
      const adapter = new ArcAdapter({
        publicClient: pub,
        managerWallet: undefined as never, // reads only — nothing here sends as the manager
        chainId: cfg.chainId,
        factory: (cfg.factoryAddress ?? "0x0") as Address,
        identityRegistry: cfg.identityRegistry,
      });
      // Same per-entity serialization as the turnkey path — funding and jobs share the key space.
      return withKeyedLock(entity.idempotencyKey, () =>
        runCircleBridge(
          {
            api: circle.api,
            legs: circle.legs,
            entityKey: entity.idempotencyKey,
            operatorWalletId: wallets.operatorWalletId,
            treasury,
            usdc,
            gatewayWallet: arcBatchingConfig.verifyingContract,
            pocketAddress: wallets.pocketAddress as Address,
            available: () => adapter.treasuryAvailable(treasury),
            standingExposure: () =>
              readStandingExposure({
                usdcBalanceOf: (owner) => adapter.usdcBalanceOf(usdc, owner),
                gatewayAvailable: () =>
                  readGatewayAvailableByAddress({
                    rpcUrl: cfg.rpcUrl,
                    depositor: wallets.pocketAddress,
                  }),
                operator: entity.operator as Address,
                pocket: wallets.pocketAddress as Address,
              }),
            ceiling: usdToUnits(cfg.maxPocketFloatUsdc),
            outflows,
          },
          amount,
        ),
      );
    }

    // Review finding L2: name the config gap up front — without this, a turnkey agent on a
    // circle-only deployment would die deep in wallet construction (or worse, risk a platform-key
    // fallback signing for the wrong entity).
    if (!cfg.pocketMasterSeed || !cfg.turnkey)
      throw new Error(
        `entity ${entity.idempotencyKey} is on the turnkey custody path but POCKET_MASTER_SEED/TURNKEY_* are not configured`,
      );
    const vault = requireVaultOperator(entity.treasury, entity);
    const operatorWallet = await buildOperatorWalletClientForEntity(cfg, vault);
    return fundPocket(
      cfg,
      entity.treasury as Address,
      amount,
      operatorWallet,
      entity.idempotencyKey,
      {
        outflows,
      },
    );
  };
}
