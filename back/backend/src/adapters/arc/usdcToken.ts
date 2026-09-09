import { type Hex as ViemHex, hashDomain } from "viem";
import type { PublicClient } from "viem";
import { chunkRange, isRangeTooLargeError } from "../../monitor/scan";
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
/**
 * The three EVENTS that make an authorization's outcome READABLE (B1 gate A3).
 *
 * `authorizationState` answers "is this nonce spent?" and nothing else — and the two ways a nonce
 * is spent (our transfer landed / it was cancelled) are the two answers a payment needs to tell
 * apart. The token says which in its own logs, and BOTH parameters are indexed, so the question
 * is a topic filter rather than a scan.
 *
 * `Transfer` is here because `AuthorizationUsed` alone does not say the money went where WE said:
 * it names an authorizer and a nonce, not a recipient or an amount. Matching a
 * Transfer(authorizer → payTo, value) in the same transaction is what makes "settled" mean
 * "the revenue address has the fee".
 */
export const AUTHORIZATION_USED_EVENT = {
  type: "event",
  name: "AuthorizationUsed",
  inputs: [
    { name: "authorizer", type: "address", indexed: true },
    { name: "nonce", type: "bytes32", indexed: true },
  ],
} as const;

/** Spelled the American way BY THE CONTRACT (FiatTokenV2_2: `AuthorizationCanceled`). Copying the
 *  British spelling here would produce a topic hash that matches nothing, silently. */
export const AUTHORIZATION_CANCELED_EVENT = {
  type: "event",
  name: "AuthorizationCanceled",
  inputs: [
    { name: "authorizer", type: "address", indexed: true },
    { name: "nonce", type: "bytes32", indexed: true },
  ],
} as const;

export const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

export const FIAT_TOKEN_ABI = [
  AUTHORIZATION_USED_EVENT,
  AUTHORIZATION_CANCELED_EVENT,
  TRANSFER_EVENT,
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

/**
 * ── RESOLVING AN AUTHORIZATION FROM THE TOKEN'S OWN LOGS (B1 gate A3) ────────────────────────
 *
 * The question a stalled payment asks is "what happened to this authorization?", and for a long
 * time this code answered it with "read the receipt of the hash WE broadcast". That answer is
 * wrong in two directions at once:
 *
 *  - a THIRD PARTY (or a relayer, or a re-send from another process) can settle a signed
 *    authorization, because it is public and self-authorizing. Our own transaction then reverts
 *    with `FiatTokenV2: authorization is used`, and reading only our receipt concludes `failed`
 *    for a payment whose money is sitting at the revenue address;
 *  - an out-of-band `cancelAuthorization` leaves `authorizationState` true with no receipt of
 *    ours to read at all — the "spent but unreadable" dead end, where the row could only sit
 *    `settling` forever.
 *
 * The logs answer both, from the chain rather than from our bookkeeping.
 */

/**
 * Window sizes to try, largest first (the monitor's live lesson, restated for this reader).
 *
 * Arc RPCs reject an over-wide `eth_getLogs` with `-32012 requested range too large`, and the
 * ceiling DIFFERS PER ENDPOINT — the box's token'd RPC accepts 100,000 while the public one
 * served 5,000. So the scan walks down the ladder on a range rejection instead of failing, and
 * never asks for an unbounded range in the first place.
 */
export const LOG_WINDOW_LADDER = [90_000n, 20_000n, 5_000n, 1_000n] as const;

/** How far back to look when a payment row predates `quoted_block` (or the box never recorded
 *  one). A quote lives 30 minutes plus a settlement grace, and Arc blocks are sub-second, so this
 *  is days of slack — and it is a CAP, never an unbounded "from genesis". */
export const DEFAULT_RESOLVE_LOOKBACK = 250_000n;
/** The hard ceiling on any window, whatever a row claims. A corrupt or ancient `quoted_block`
 *  must not turn one payment's resolution into a full-chain scan. */
export const MAX_RESOLVE_LOOKBACK = 500_000n;

export type AuthorizationOutcome =
  /** The money moved: an `AuthorizationUsed` for this nonce AND a matching Transfer to the payee
   *  in the same transaction. `txHash` is the transaction that did it — ours or anyone's. */
  | { kind: "settled"; txHash: Hex; blockNumber: bigint }
  /** The authorizer cancelled it. The nonce is retired and nothing can ever settle it. */
  | { kind: "cancelled"; txHash: Hex }
  /** Nothing about this nonce is on-chain in the window we can see. NOT a failure. */
  | { kind: "unknown" };

export interface ResolveAuthorizationInput {
  client: PublicClient;
  usdc: Address;
  authorizer: Address;
  nonce: Hex;
  /** Where the money was supposed to go — the payee STORED on the row, never live config. */
  payTo: Address;
  /** The exact atomic amount the authorization committed to. */
  value: bigint;
  /** The chain head when the quote was issued. The window starts here (capped). */
  fromBlock?: bigint | null;
}

/**
 * What happened to (authorizer, nonce)?
 *
 * Both parameters are INDEXED on both events, so this is a two-topic filter over a bounded window
 * — not a scan of the token's traffic. A `settled` verdict additionally requires a
 * Transfer(authorizer → payTo, value) in the same transaction: `AuthorizationUsed` says a nonce
 * was consumed, and only the transfer says our revenue address is the one that has the fee.
 */
export async function resolveAuthorizationOutcome(
  input: ResolveAuthorizationInput,
): Promise<AuthorizationOutcome> {
  const latest = await input.client.getBlockNumber();
  const floor = latest > MAX_RESOLVE_LOOKBACK ? latest - MAX_RESOLVE_LOOKBACK : 0n;
  const hinted =
    input.fromBlock != null && input.fromBlock > 0n
      ? input.fromBlock
      : latest > DEFAULT_RESOLVE_LOOKBACK
        ? latest - DEFAULT_RESOLVE_LOOKBACK
        : 0n;
  const from = hinted > floor ? hinted : floor;

  const args = { authorizer: input.authorizer, nonce: input.nonce };
  // The CANCEL first: it is terminal and cheap, and a cancelled authorization can never have a
  // matching transfer, so finding one saves the second and third queries.
  const cancelled = await scanLogs(input.client, {
    address: input.usdc,
    event: AUTHORIZATION_CANCELED_EVENT,
    args,
    from,
    to: latest,
  });
  if (cancelled.length > 0)
    return { kind: "cancelled", txHash: cancelled[0]?.transactionHash as Hex };

  const used = await scanLogs(input.client, {
    address: input.usdc,
    event: AUTHORIZATION_USED_EVENT,
    args,
    from,
    to: latest,
  });
  const hit = used[0];
  if (!hit) return { kind: "unknown" };

  // The transfer that goes with it — read at the USED log's own block, which is one block rather
  // than a window, and filtered on both indexed parties.
  const block = hit.blockNumber as bigint;
  const transfers = await scanLogs(input.client, {
    address: input.usdc,
    event: TRANSFER_EVENT,
    args: { from: input.authorizer, to: input.payTo },
    from: block,
    to: block,
  });
  const paid = transfers.find(
    (t) =>
      t.transactionHash === hit.transactionHash &&
      ((t.args as { value?: bigint } | undefined)?.value ?? -1n) === input.value,
  );
  // A used nonce with NO matching transfer is not a settlement of OURS — it is an authorization
  // consumed some other way, and saying "settled" for it would credit a company nobody paid for.
  if (!paid) return { kind: "unknown" };
  return { kind: "settled", txHash: hit.transactionHash as Hex, blockNumber: block };
}

/** Chunked `getLogs` that walks DOWN the window ladder when an endpoint rejects the range. */
async function scanLogs(
  client: PublicClient,
  q: {
    address: Address;
    // biome-ignore lint/suspicious/noExplicitAny: three different const event shapes, one reader
    event: any;
    args: Record<string, unknown>;
    from: bigint;
    to: bigint;
  },
  // biome-ignore lint/suspicious/noExplicitAny: viem's log type is generic over the event
): Promise<any[]> {
  let lastRangeError: unknown;
  for (const size of LOG_WINDOW_LADDER) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: as above
      const out: any[] = [];
      for (const range of chunkRange(q.from, q.to, size))
        out.push(
          ...(await client.getLogs({
            address: q.address,
            event: q.event,
            args: q.args,
            fromBlock: range.from,
            toBlock: range.to,
          })),
        );
      return out;
    } catch (err) {
      // Only a RANGE rejection is worth retrying narrower. Anything else (an RPC that is down, a
      // malformed filter) must surface: the caller treats a throw as "unknown", which leaves the
      // payment where it is, and swallowing it here would hide a broken endpoint behind a verdict.
      if (!isRangeTooLargeError(err)) throw err;
      lastRangeError = err;
    }
  }
  throw lastRangeError ?? new Error("getLogs: exhausted the window ladder");
}
