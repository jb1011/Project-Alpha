import { sign, verify } from "hono/jwt";
import { getAddress } from "viem";
import { AuthError } from "./siwe";

/** Mint an HS256 JWT whose subject is the EIP-55 checksummed tenant address.
 *
 * Both the JWT `exp` claim and the returned `expiresAt` are derived from the
 * injected `now` parameter so that the token's expiry and the metadata value
 * are always identical.
 */
export async function signSession(
  address: string,
  secret: string,
  ttlSec: number,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + ttlSec;
  const token = await sign({ sub: getAddress(address), exp: expiresAt }, secret, "HS256");
  return { token, expiresAt };
}

/** Verify a session JWT; returns the EIP-55 checksummed tenantId.
 * Throws AuthError on invalid/expired token.
 */
export async function verifySession(
  token: string,
  secret: string,
): Promise<{ tenantId: `0x${string}` }> {
  let payload: { sub?: unknown };
  try {
    payload = (await verify(token, secret, "HS256")) as { sub?: unknown };
  } catch {
    throw new AuthError("invalid or expired session");
  }
  if (typeof payload.sub !== "string" || !payload.sub.startsWith("0x")) {
    throw new AuthError("invalid session subject");
  }
  return { tenantId: getAddress(payload.sub) as `0x${string}` };
}
