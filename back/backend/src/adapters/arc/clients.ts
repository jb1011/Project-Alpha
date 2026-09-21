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
import type { Address, Hex } from "../../types";

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

/**
 * THE IN-LOCK RPC BUDGET (`senderLock.ts`).
 *
 * Two calls happen while the platform send lock is held — read the pending nonce, hand over the
 * signed bytes — and a lock is only as good as its worst case: every other platform send queues
 * behind whatever the slowest of those two does. viem's bare `http()` is 10 s per attempt with
 * three retries, and on a 429 it obeys an HTTP `Retry-After` header verbatim and without a cap, so
 * one throttling endpoint could hold the queue for minutes or longer.
 *
 * Short, and NO retries. Retrying is the wrong instinct here: a refused send already has a home to
 * fall into — the funding path records the signed bytes and re-broadcasts them, the others fail
 * with nothing sent — whereas a retry inside the lock is paid for by every send behind it. With a
 * zero retry budget viem also never sleeps on `Retry-After`.
 */
export const SEND_TIMEOUT_MS = 8_000;
export const SEND_RETRY_COUNT = 0;

/**
 * A client for the calls that happen INSIDE the send lock, and for nothing else.
 *
 * Same URL and chain as `publicClientFor`, a bounded transport. Ordinary reads keep the ordinary
 * client: they are allowed to retry, because nothing waits behind them.
 */
export function sendClientFor(cfg: Config): PublicClient {
  return createPublicClient({
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl, {
      timeout: SEND_TIMEOUT_MS,
      retryCount: SEND_RETRY_COUNT,
    }),
  });
}

export function managerWalletClient(cfg: Config): WalletClient {
  return walletClientForKey(cfg, cfg.platformPrivateKey);
}

/**
 * A wallet client for a SPECIFIC key on this chain — the same transport and chain as every other
 * client here, a different signer.
 *
 * It exists for the formation settle submitter (design §6.4, B1 gate A2): a dedicated EOA with
 * its own nonce space, its own USDC gas balance and no authority anywhere. `managerWalletClient`
 * is now one call of it, so there is one place that knows how a wallet client is built.
 */
export function walletClientForKey(cfg: Config, key: Hex): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl),
  });
}
