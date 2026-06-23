import { getAddress, recoverMessageAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";
import type { NonceStore } from "./nonceStore";

/** Auth failure carrying the HTTP status apiOnError (Task 5) maps it to. */
export class AuthError extends Error {
  readonly code = "unauthorized";
  readonly status = 401;
}

export interface VerifySiweArgs {
  message: string;
  signature: `0x${string}`;
  nonceStore: NonceStore;
  domain: string;
  chainId: number;
  now: number;
}

/**
 * Validate a SIWE (EIP-4361) login: check domain/chainId/expiry, recover the signer from the
 * signature, then burn the nonce (single-use). Returns the checksummed signer address.
 */
export async function verifySiwe(a: VerifySiweArgs): Promise<`0x${string}`> {
  const fields = parseSiweMessage(a.message);
  if (!fields.address || !fields.nonce) throw new AuthError("malformed SIWE message");
  if (fields.domain !== a.domain) throw new AuthError(`bad domain: ${fields.domain}`);
  if (fields.chainId !== undefined && fields.chainId !== a.chainId)
    throw new AuthError(`bad chainId: ${fields.chainId}`);
  if (fields.expirationTime && fields.expirationTime.getTime() <= a.now)
    throw new AuthError("message expired");

  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({ message: a.message, signature: a.signature });
  } catch {
    throw new AuthError("invalid signature");
  }
  if (getAddress(recovered) !== getAddress(fields.address))
    throw new AuthError("signature does not match address");

  // Burn the nonce last: a valid, unexpired, previously-issued nonce is required.
  if (!a.nonceStore.consume(fields.nonce, a.now)) throw new AuthError("unknown or expired nonce");

  return getAddress(fields.address);
}
