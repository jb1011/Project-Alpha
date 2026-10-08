import { type Address, type Hex, getAddress, isAddress } from "viem";

/**
 * THE INPUT RULES OF THE LEGAL-BODY TABLES, written once: what a value handed to the legal-body
 * repository or to the statement log must be, and the one spelling each is stored in. The two
 * tables are read together by these values (the agent ids the statement log records for a wallet
 * are looked up by agent id and deployment in `legal_bodies`), so each rule has a single copy: two
 * copies could drift apart, and one table would then store a spelling the other never finds.
 *
 * A value that breaks a rule throws a `LegalBodyInputError`, before anything is written.
 */

/**
 * A value handed to the repository that no row may hold: a hash that is not one, a time in the
 * wrong unit, a chain id of zero. It is a bug in the caller, never the outcome of a race, so it is
 * thrown, before anything is written, rather than answered.
 */
export class LegalBodyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalBodyInputError";
  }
}

/** A JS number that is an exact integer in [min, max]: not a string, a bigint, NaN or a fraction. */
export function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * An address in the one form rows store it: checksummed, so a lookup matches whatever casing the
 * caller holds. Null when the value is not an address at all, which no row can hold.
 */
export function checksummed(value: string): Address | null {
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

/** The address in the form rows store it, or a `LegalBodyInputError` naming the field. */
export function requireAddress(field: string, value: unknown): Address {
  const address = typeof value === "string" ? checksummed(value) : null;
  if (address === null) throw new LegalBodyInputError(`${field} must be a 0x address`);
  return address;
}

const HASH_32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * A 32-byte hash in the one spelling rows store it: lower-case, so a stored hash compares as text
 * with the same hash read from anywhere else. Null when the value is not a 32-byte hash at all.
 */
export function lowerHash(value: unknown): Hex | null {
  return typeof value === "string" && HASH_32.test(value) ? (value.toLowerCase() as Hex) : null;
}

export function requireHash(field: string, value: unknown): Hex {
  const hash = lowerHash(value);
  if (hash === null)
    throw new LegalBodyInputError(`${field} must be 0x and 64 hex digits (a 32-byte hash)`);
  return hash;
}

/** The largest time the seconds columns hold. A time in milliseconds is past it for centuries. */
export const MAX_UNIX_SECONDS = 99_999_999_999;

/** A time in unix SECONDS, the unit of a block timestamp. */
export function requireSeconds(field: string, value: unknown): number {
  if (!isIntegerWithin(value, 1, MAX_UNIX_SECONDS))
    throw new LegalBodyInputError(
      `${field} must be a whole number of unix seconds (1 to ${MAX_UNIX_SECONDS}), got ${String(value)}`,
    );
  return value;
}

/** The most rows one call of a public finder returns. */
const MAX_PUBLIC_LIMIT = 100;

/** A public finder's row count for LIMIT: a whole number from 1 to `MAX_PUBLIC_LIMIT`. */
export function requirePublicLimit(value: unknown): number {
  if (!isIntegerWithin(value, 1, MAX_PUBLIC_LIMIT))
    throw new LegalBodyInputError(
      `limit must be a whole number from 1 to ${MAX_PUBLIC_LIMIT}, got ${String(value)}`,
    );
  return value;
}

/** The deployment as rows store it: the factory checksummed, so a lookup matches any casing. */
export function requireDeployment(d: unknown): { chain_id: number; factory: Address } {
  const { chainId, factory } = (d ?? {}) as { chainId?: unknown; factory?: unknown };
  if (!isIntegerWithin(chainId, 1, Number.MAX_SAFE_INTEGER))
    throw new LegalBodyInputError(
      `a deployment's chainId must be a positive whole number, got ${String(chainId)}`,
    );
  return { chain_id: chainId, factory: requireAddress("a deployment's factory", factory) };
}

const UINT256_MAX = 2n ** 256n - 1n;

/**
 * An agentId in the one spelling rows store it: a uint256 in decimal without leading zeros.
 *
 * The two agentId indexes compare `agent_id` as TEXT, so "042" and "42" would be two agents to
 * them, and the same identity could hold two orders on their way, or two linked bodies. Null when
 * the value is not a uint256 in decimal at all.
 */
export function canonicalAgentId(value: string): string | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const n = BigInt(value);
  return n <= UINT256_MAX ? n.toString() : null;
}
