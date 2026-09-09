import { encodePacked, getAddress } from "viem";

/**
 * `abi.encodePacked(address, uint256)`, 52 bytes.
 *
 * Must byte-equal the backend's `buildSignal` (`back/backend/src/adapters/worldid/agentBookRegistrar.ts`)
 * because design v3 D8 forbids the backend from being the sole author of what a guardian signs:
 * the dialog recomputes this from the session's address and nonce and refuses to show a QR for a
 * signal it did not derive itself.
 *
 * The 52-byte PACKED form is the only correct one. The padded 64-byte `encodeAbiParameters` form
 * type-checks, encodes, and reverts on-chain AFTER the guardian has done the work (design v3 §4.1).
 */
export function buildSignal(address: string, nonce: string): `0x${string}` {
  return encodePacked(["address", "uint256"], [getAddress(address), BigInt(nonce)]);
}

/**
 * Does the session's `signal` match what these bytes actually commit to?
 *
 * Returns false rather than throwing on malformed input: a server that sends an address `viem`
 * refuses to checksum, or a non-numeric nonce, is exactly the case this check exists to catch, and
 * the caller's answer is the same either way — do not proceed.
 *
 * Hex case is not semantic, so the comparison is case-insensitive; the bytes are not.
 */
export function signalMatches(address: string, nonce: string, claimed: string): boolean {
  try {
    return buildSignal(address, nonce).toLowerCase() === claimed.toLowerCase();
  } catch {
    return false;
  }
}
