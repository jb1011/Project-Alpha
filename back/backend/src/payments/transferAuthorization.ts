import { getAddress, verifyTypedData } from "viem";
import type { PublicClient, TypedDataDomain } from "viem";
import type { Address, Hex } from "../types";

/**
 * EIP-3009 `TransferWithAuthorization` verification — ONE implementation, two rails
 * (design 2026-08-26 §6.3).
 *
 * It was extracted from `seller.ts`, which had the only copy of the recovery core, and which
 * verified against Circle's Gateway BATCHING domain with an amount FLOOR. Formation payments
 * (§6) need the same four checks against the USDC TOKEN's own domain with an amount that must
 * match EXACTLY, and a second copy of "did this person really authorize this transfer?" is a
 * second place for the recipient check to be forgotten. So the checks live here and the two rails
 * differ only in the two things that genuinely differ: the domain, and the amount mode.
 *
 * Nothing in this module touches a chain, a database or a config: it is a pure function of an
 * authorization, a signature and what the caller expected. That is what makes it callable from a
 * request handler BEFORE anything is persisted or broadcast, which is the whole point — a
 * signature we cannot verify locally must never reach an executor.
 */

/** The EIP-3009 authorization, on the wire (strings, as both rails carry it). */
export interface TransferAuthorization {
  from: Address;
  to: Address;
  /** Atomic USDC (6 decimals), as a decimal string. */
  value: string;
  /** Unix SECONDS. */
  validAfter: string;
  validBefore: string;
  /** 32 bytes, hex. */
  nonce: Hex;
}

/** The EIP-712 domain the signature was given under. NEVER hardcoded by a caller for the token
 *  rail: `usdcDomain()` reads `name()`/`version()` from the contract and pins them against its own
 *  `DOMAIN_SEPARATOR()`. */
export interface TransferAuthorizationDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/**
 * How the signed `value` is compared with what the caller expected.
 *
 *  - `floor`  — the x402 seller's rule: a buyer may over-pay, so `value >= expected` passes. It
 *               is the right rule for a paywall, where the price is the seller's minimum.
 *  - `exact`  — the formation rule: `value === expected`, where `expected` is the STORED quote.
 *               A quote is a price we named, and accepting anything else means either charging a
 *               guardian more than we quoted or filing an LLC for less than it costs.
 */
export type AuthorizationAmountMode = "exact" | "floor";

export interface VerifyTransferAuthorizationInput {
  authorization: TransferAuthorization;
  signature: Hex;
  domain: TransferAuthorizationDomain;
  /** Who the money must go to. The revenue address for formation; the payout for x402. */
  payTo: Address;
  /** Atomic USDC the caller expects, compared per `mode`. */
  value: bigint;
  mode: AuthorizationAmountMode;
  /**
   * A public client, when the caller has one (B1 gate A6).
   *
   * With it, the signature is checked through viem's CLIENT-BOUND `verifyTypedData`, which falls
   * back to an on-chain ERC-1271 `isValidSignature` call (and understands ERC-6492 wrappers for
   * an account that is not deployed yet). Without it, the check is the offline ECDSA recovery.
   *
   * The difference is not academic: the TOKEN verifies EIP-3009 signatures the same way, so a
   * smart-account guardian — a Safe, a Circle SCA, a 4337 wallet — produces a signature the token
   * would accept and our offline recovery would not. We would refuse a valid payment and tell the
   * guardian their own wallet is wrong. The x402 rail passes no client and keeps the offline path,
   * which is what it has always done.
   */
  client?: PublicClient;
  /** Epoch MILLISECONDS. Injectable so the time checks are testable without faking the clock. */
  now?: () => number;
}

export type VerifyTransferAuthorizationResult =
  | { ok: true; nonce: Hex }
  | { ok: false; reason: string };

/**
 * The EIP-712 type the token (and Circle's batching scheme) both use for
 * `TransferWithAuthorization`. Declared here rather than imported from `x402/types` so this module
 * has no dependency on the x402 package at all — the formation rail must not carry one.
 *
 * ⚠ `EIP712Domain` is deliberately ABSENT. viem's `verifyTypedData` derives the domain type from
 * the `domain` object itself and REJECTS an explicit `EIP712Domain` member in `types`. The
 * opposite trap bites on the SIGNING side, where Turnkey needs it injected — see
 * `adapters/x402/pocket.ts#asBatchEvmSigner`. Signing and verifying want different shapes, which
 * is exactly why neither side should be reading the other's constant.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Verify an authorization LOCALLY, before anything is persisted or broadcast.
 *
 * Five checks, in an order chosen so the cheapest refusals come first and the expensive elliptic
 * curve recovery runs only for an authorization that would otherwise be acceptable:
 *
 *  1. recipient — the money goes where the caller said, never where the signer said;
 *  2. amount — per `mode`;
 *  3. `validAfter <= now` — an authorization that is not yet valid would revert on-chain, and a
 *     "signature verified" answer for one is a promise the executor cannot keep;
 *  4. `validBefore > now` — expired;
 *  5. the signature recovers `from`.
 *
 * The refusal `reason` strings are stable and are surfaced to callers (the x402 402 body, the
 * formation settle route's 400): they name what is wrong without echoing the authorization.
 */
export async function verifyTransferAuthorization(
  input: VerifyTransferAuthorizationInput,
): Promise<VerifyTransferAuthorizationResult> {
  const a = input.authorization;
  const nowSec = BigInt(Math.floor((input.now ?? Date.now)() / 1000));

  let to: Address;
  let payTo: Address;
  let from: Address;
  try {
    to = getAddress(a.to) as Address;
    payTo = getAddress(input.payTo) as Address;
    from = getAddress(a.from) as Address;
  } catch {
    // A malformed address is not a signature failure and must not be reported as one: the caller
    // sent something that is not an authorization at all.
    return { ok: false, reason: "malformed-address" };
  }
  if (to !== payTo) return { ok: false, reason: "wrong recipient" };

  let value: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(a.value);
    validAfter = BigInt(a.validAfter);
    validBefore = BigInt(a.validBefore);
  } catch {
    return { ok: false, reason: "malformed-authorization" };
  }
  if (input.mode === "exact" ? value !== input.value : value < input.value)
    return { ok: false, reason: input.mode === "exact" ? "wrong amount" : "underpriced" };
  if (validAfter > nowSec) return { ok: false, reason: "not-yet-valid" };
  if (validBefore <= nowSec) return { ok: false, reason: "expired" };

  const verdict = await verifySignature({
    client: input.client,
    address: from,
    domain: {
      name: input.domain.name,
      version: input.domain.version,
      chainId: input.domain.chainId,
      verifyingContract: getAddress(input.domain.verifyingContract),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from, to, value, validAfter, validBefore, nonce: a.nonce },
    signature: input.signature,
  });
  if (!verdict.ok) return verdict;
  return { ok: true, nonce: a.nonce };
}

/** A 65-byte ECDSA signature: r, s and v. Anything else is a contract account's own encoding. */
const ECDSA_SIGNATURE_BYTES = 65;

export interface VerifySignatureInput {
  client?: PublicClient;
  address: Address;
  domain: TypedDataDomain;
  // biome-ignore lint/suspicious/noExplicitAny: the two call sites pass two different const shapes
  types: any;
  primaryType: string;
  message: Record<string, unknown>;
  signature: Hex;
}

/**
 * "Would the TOKEN accept this signature?" — asked in the way the token asks it (B1 gate A6).
 *
 * One helper for the transfer authorization and for `CancelAuthorization`, because both are
 * EIP-712 messages the same guardian signs and the same contract verifies, and two spellings of
 * "verify" is how the cancel path ends up refusing a wallet the settle path accepts.
 *
 * ⚠ THE `unsupported-signer` REASON. A signature that is not 65 bytes, from an address with NO
 * CODE, cannot be verified by anyone: it is not ECDSA, and there is no contract to ask. Calling
 * that `bad-signature` tells a guardian their wallet produced a wrong signature, when what
 * actually happened is that we cannot check this KIND of signature — most often a smart account
 * whose deployment we cannot see, or a wallet returning an ERC-6492 wrapper we could not unwrap.
 * The distinction is the difference between "you did something wrong" and "we cannot serve this
 * wallet", and only one of those is true.
 */
export async function verifySignature(
  input: VerifySignatureInput,
): Promise<{ ok: true } | { ok: false; reason: "bad-signature" | "unsupported-signer" }> {
  const args = {
    address: input.address,
    domain: input.domain,
    types: input.types,
    primaryType: input.primaryType,
    message: input.message,
    signature: input.signature,
  };
  let valid = false;
  try {
    // The CLIENT-bound action where we have one: it does the ECDSA recovery first and falls back
    // to an on-chain ERC-1271 call, which is exactly what the token does.
    valid = input.client
      ? // biome-ignore lint/suspicious/noExplicitAny: viem's typed-data generics over a runtime shape
        await input.client.verifyTypedData(args as any)
      : // biome-ignore lint/suspicious/noExplicitAny: as above
        await verifyTypedData(args as any);
  } catch {
    valid = false;
  }
  if (valid) return { ok: true };

  // Not an ECDSA signature? Then WHY it failed depends on whether there was anything that could
  // have checked it. With code at the address, the ERC-1271 call above was made and said no —
  // that IS a bad signature. With no code, nothing could have checked it at all.
  //
  // ⚠ The claim needs a CLIENT to make it. Without one (the x402 rail) we cannot know whether the
  // signer has code, and guessing would change that rail's long-standing refusal for every
  // malformed signature it sees. No client ⇒ the answer it has always given.
  const bytes = (input.signature.length - 2) / 2;
  if (bytes !== ECDSA_SIGNATURE_BYTES && input.client) {
    let hasCode = false;
    try {
      const code = await input.client.getCode({ address: input.address });
      hasCode = code !== undefined && code !== "0x";
    } catch {
      // The read failed, so we still have not verified anything and still cannot blame the
      // signature. "We cannot check this here" is the honest sentence either way.
      hasCode = false;
    }
    if (!hasCode) return { ok: false, reason: "unsupported-signer" };
  }
  return { ok: false, reason: "bad-signature" };
}
