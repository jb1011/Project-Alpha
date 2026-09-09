import { type Hex as ViemHex, hashDomain } from "viem";
import type { PublicClient } from "viem";
import type { TransferAuthorizationDomain } from "../../payments/transferAuthorization";
import type { Address, Hex } from "../../types";

/**
 * The USDC TOKEN itself — Arc's predeploy is Circle's FiatTokenV2_2 (design 2026-08-26 §6).
 *
 * Formation payments use the token's own EIP-3009, not Circle's Gateway batching scheme: no
 * Gateway deposit, no facilitator, no Circle service in the path. That means three things this
 * module owns: the token's EIP-712 DOMAIN (read and PINNED, never hardcoded), the
 * `transferWithAuthorization` the executor submits, and the two functions that make resume and
 * cancellation possible — `authorizationState` and `cancelAuthorization`.
 */

/**
 * The FiatTokenV2_2 fragments we call. Hand-written rather than generated: the token is a
 * PREDEPLOY, not one of our contracts, so it has no build artifact in this repo.
 *
 * ⚠ `transferWithAuthorization` and `cancelAuthorization` are OVERLOADED on FiatTokenV2_2 — a
 * `(v, r, s)` form and, since v2.2, a `bytes signature` form. Only the `bytes` form is declared
 * here, deliberately: with both present viem would need an explicit overload selection at every
 * call site, and the `bytes` form is the one a browser wallet's signature drops straight into.
 */
export const FIAT_TOKEN_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/**
 * The EIP-712 type of `CancelAuthorization` — the guardian's fast path out of a stuck payment
 * (§6.4 rule 3).
 *
 * The platform CANNOT cancel unilaterally: the token requires a signature from the AUTHORIZER,
 * which is the guardian. That is a property of the design rather than an inconvenience — an
 * authorization is the guardian's promise, and only they can withdraw it. Our executor merely
 * submits what they signed.
 */
export const CANCEL_AUTHORIZATION_TYPES = {
  CancelAuthorization: [
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Read the token's EIP-712 domain and PIN it against the token's own `DOMAIN_SEPARATOR()`.
 *
 * Why not just hardcode `{ name: "USD Coin", version: "2" }`? Because those two strings are the
 * difference between a signature that settles and one that reverts, they are per-deployment
 * facts about somebody else's contract, and getting them wrong is INVISIBLE until a guardian has
 * signed: the wizard would show a wallet prompt, the guardian would approve it, our local
 * verification would pass (we would be verifying against the same wrong domain we asked them to
 * sign), and the executor's transaction would revert `FiatTokenV2: invalid signature` on-chain —
 * after the quote, after the wallet interaction, and with no way to tell the guardian why.
 *
 * So the two strings are READ, and then CHECKED: `hashDomain` over what we read must equal the
 * `DOMAIN_SEPARATOR()` the token itself reports. If it does not, something about this token is
 * not what this code believes (a different EIP-712 layout, a proxy pointing somewhere else, a
 * salt), and the honest response is to refuse rather than to quote a price for a signature we
 * cannot make settle.
 */
export async function readUsdcDomain(
  client: PublicClient,
  usdc: Address,
  chainId: number,
): Promise<TransferAuthorizationDomain> {
  const contract = { address: usdc, abi: FIAT_TOKEN_ABI } as const;
  const [name, version, onChainSeparator] = await Promise.all([
    client.readContract({ ...contract, functionName: "name" }),
    client.readContract({ ...contract, functionName: "version" }),
    client.readContract({ ...contract, functionName: "DOMAIN_SEPARATOR" }),
  ]);
  const domain = { name, version, chainId, verifyingContract: usdc };
  const computed = hashDomain({
    // `chainId` as a bigint HERE only: viem's `hashDomain` types it that way, while everything
    // downstream (viem's own `signTypedData`/`verifyTypedData`, wagmi, the wire) takes a number.
    // Converting at the one call site keeps the number out of the domain object we hand around.
    domain: { ...domain, chainId: BigInt(chainId) },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
  if (computed.toLowerCase() !== (onChainSeparator as ViemHex).toLowerCase())
    throw new Error(
      `USDC domain pin failed for ${usdc} on chain ${chainId}: the token reports DOMAIN_SEPARATOR ${onChainSeparator}, but name="${name}" / version="${version}" hash to ${computed}. Refusing to quote a payment whose signature could not settle.`,
    );
  return domain;
}

/** Has this (authorizer, nonce) pair already been used or cancelled? `false` means "NOT YET
 *  USED" — never "dead" — which is precisely why §6.4 refuses to expire a row on it alone. */
export async function readAuthorizationState(
  client: PublicClient,
  usdc: Address,
  authorizer: Address,
  nonce: Hex,
): Promise<boolean> {
  return (await client.readContract({
    address: usdc,
    abi: FIAT_TOKEN_ABI,
    functionName: "authorizationState",
    args: [authorizer, nonce],
  })) as boolean;
}
