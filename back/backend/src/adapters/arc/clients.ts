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

/** The platform/manager account (Factory owner + setAgentWallet caller). */
export function managerAccount(cfg: Config): PrivateKeyAccount {
  return privateKeyToAccount(cfg.platformPrivateKey);
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
