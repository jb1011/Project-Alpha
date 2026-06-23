import type { Config } from "../../config/env";
import { LocalKeySigner, type OperatorSigner } from "./signer";
import { TurnkeySigner } from "./turnkeySigner";

/**
 * Build the operator signer from config. Production path: a Turnkey enclave key (non-custodial) when
 * TURNKEY_* is configured. Local fallback: LocalKeySigner from OPERATOR_PRIVATE_KEY (testnet/dev only).
 * Turnkey is preferred so the agent's bound wallet is never a raw key on the app server.
 */
export async function buildOperatorSigner(cfg: Config): Promise<OperatorSigner> {
  if (cfg.turnkey) {
    return TurnkeySigner.forKey(cfg.turnkey, cfg.turnkey.signWith);
  }
  if (cfg.operatorPrivateKey) {
    return new LocalKeySigner(cfg.operatorPrivateKey);
  }
  throw new Error(
    "No operator signer configured: set TURNKEY_* (preferred) or OPERATOR_PRIVATE_KEY.",
  );
}
