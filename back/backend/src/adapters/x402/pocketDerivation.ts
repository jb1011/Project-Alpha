import { concat, keccak256, toBytes } from "viem";
import type { Hex } from "../../types";

/**
 * Deterministically derive a per-agent pocket private key from one master seed + the entity key.
 * Per-agent isolation (distinct addresses, no commingling), no per-agent key storage. keccak256 output is
 * always 32 bytes and is a valid secp256k1 scalar with overwhelming probability.
 */
export function derivePocketKey(masterSeed: Hex, entityKey: string): Hex {
  return keccak256(concat([toBytes(masterSeed), toBytes(entityKey)]));
}
