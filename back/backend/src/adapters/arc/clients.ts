import {
  http,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { chainFor } from "../../chains";
import type { Config } from "../../config/env";
import type { Address } from "../../types";

/** The platform signing account. Legacy: the on-chain manager (factory owner + setAgentWallet
 *  caller). Controller mode: the EXECUTOR only — it still signs and sends every platform tx, but
 *  the on-chain manager identity is the controller (see platformManagerAddress). */
export function managerAccount(cfg: Config): PrivateKeyAccount {
  return privateKeyToAccount(cfg.platformPrivateKey);
}

/**
 * The platform manager ADDRESS — decoupled from the signing KEY by the NoviController design (§5).
 *
 * This is the identity forced into `roles.manager` on both onboard doors, the address the factory
 * mints each agent's vaults + identity NFT to, and therefore the `owner` the operator's
 * `AgentWalletSet` signature must commit to. In controller mode it is the controller CONTRACT; with
 * no controller configured it is the signing key's address, exactly as before.
 */
export function platformManagerAddress(cfg: Config): Address {
  return cfg.controllerAddress ?? (managerAccount(cfg).address as Address);
}

export function publicClientFor(cfg: Config): PublicClient {
  return createPublicClient({
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl),
  });
}

export function managerWalletClient(cfg: Config): WalletClient {
  return createWalletClient({
    account: managerAccount(cfg),
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl),
  });
}
