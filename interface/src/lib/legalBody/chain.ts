/**
 * The legal-body flow's chain layer: the pinned ABI fragments, the pointer encoder, the one
 * allowlist every wallet write request passes, the door that sends it, and the mint parse.
 *
 * Pin and assert, then send: nothing reaches a wallet unless it is one of the three calls below,
 * built for the selected order, on the chain and registry that `/config` names. Addresses come from
 * the API (`/config.legalBodies`, the order), never from this bundle. Never an approval, a
 * transfer or a value.
 */
import { encodeAbiParameters, encodeFunctionData, formatUnits } from "viem";
import type { Address, Hex, LegalBodyConfig, LegalBodyOrderView } from "@/lib/api/types";
import { sameAddress } from "./flow";

// ---------------------------------------------------------------------------------------------
// Pinned ABI fragments
// ---------------------------------------------------------------------------------------------

/** The ERC-8004 identity registry: the two `register` overloads, the metadata pair, the reads,
 *  and the ERC-721 `Transfer` a mint emits. The only writes are the three the allowlist names. */
export const identityRegistryAbi = [
  {
    type: "function",
    name: "register",
    inputs: [],
    outputs: [{ name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "register",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setMetadata",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "key", type: "string" },
      { name: "value", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getMetadata",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
  },
  {
    // Reverts for an id that was never minted: read the revert as "no identity with this id".
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAgentWallet",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
    anonymous: false,
  },
] as const;

/** The legal-body factory: the three reads the pointer step needs. */
export const legalBodyFactoryAbi = [
  {
    type: "function",
    name: "encodePointer",
    inputs: [{ name: "legalBody", type: "address" }],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "linkedLegalBody",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "identityOwnerAtCreation",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
/** The metadata key the factory reads the pointer under. */
export const POINTER_KEY = "legalBody";
/** The pointer format the factory writes and reads. */
export const POINTER_VERSION = 1;
/** Arc's native unit (USDC as gas) has 18 decimals on chain. */
export const NATIVE_DECIMALS = 18;

// ---------------------------------------------------------------------------------------------
// The pointer
// ---------------------------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ZERO_WORD = /^0x0{64}$/;
/** An address in a 32-byte topic: twelve zero bytes, then the twenty of the address. */
const ADDRESS_WORD = /^0x0{24}([0-9a-fA-F]{40})$/;
/** A uint256 as the API serves it: decimal, no sign, no leading zero, at most 78 digits. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

/** `abi.encode(uint8 1, uint256 chainId, address body)`: exactly 96 bytes. The body's casing
 *  does not matter: addresses are compared in lower case everywhere in this flow. */
export function encodePointer(chainId: number, body: Address): Hex {
  return encodeAbiParameters(
    [{ type: "uint8" }, { type: "uint256" }, { type: "address" }],
    [POINTER_VERSION, BigInt(chainId), body.toLowerCase() as Address],
  );
}

/** The local encoding must equal what the factory's `encodePointer(body)` returned: a mismatch
 *  is a stop, not a send. */
export function pointerMatchesFactory(local: Hex, fromFactory: Hex): boolean {
  return local.toLowerCase() === fromFactory.toLowerCase();
}

/** A native amount in wei, as an amount of USDC, with Arc's 18 decimals. */
export function formatNative(wei: bigint): string {
  return formatUnits(wei, NATIVE_DECIMALS);
}

/** What signs for an address: a plain key (no code), a key delegated under EIP-7702 (23 bytes,
 *  `0xef0100` and the delegate's address), or a contract. */
export type WalletKind = "key" | "delegated" | "contract";

const DELEGATION = /^0xef0100[0-9a-f]{40}$/;

/** `code` as `getCode` answers it: undefined or `0x` for an address with no code. */
export function walletKindOf(code: Hex | undefined): WalletKind {
  if (code === undefined || code === "0x") return "key";
  return DELEGATION.test(code.toLowerCase()) ? "delegated" : "contract";
}

// ---------------------------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------------------------

/** The only shape a wallet write request takes in this flow. */
export type WriteRequest = {
  chainId: number;
  address: Address;
  abi: typeof identityRegistryAbi;
  functionName: "register" | "setMetadata";
  args: readonly unknown[];
  value?: bigint;
  gas?: bigint;
};

export type CallContext = {
  config: Pick<
    Extract<LegalBodyConfig, { available: true }>,
    "chainId" | "identityRegistry" | "factory"
  >;
  /** The selected order; required for the pointer. */
  order: LegalBodyOrderView | null;
};

export type Refusal = { ok: false; problem: string };

const refuse = (problem: string): Refusal => ({ ok: false, problem });

/** The order's identity and body, when both are there and well formed. */
function bodyOf(order: LegalBodyOrderView): { agentId: bigint; body: Address } | null {
  const { agentId, bodyAddress } = order;
  if (agentId === null || bodyAddress === null) return null;
  if (!CANONICAL_DECIMAL.test(agentId) || !ADDRESS.test(bodyAddress)) return null;
  return { agentId: BigInt(agentId), body: bodyAddress };
}

/** `register()` with no URI, `register(string)` otherwise. */
export function registerCall(config: CallContext["config"], uri: string | null): WriteRequest {
  return {
    chainId: config.chainId,
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "register",
    args: uri === null ? [] : [uri],
  };
}

/** `setMetadata(agentId, "legalBody", pointer)` for the selected order's own body, on the
 *  configured registry. Whether it may be sent is `allowedCall`'s to say. */
export function pointerCall(
  config: CallContext["config"],
  order: LegalBodyOrderView,
): WriteRequest | Refusal {
  const own = bodyOf(order);
  if (own === null) return refuse("order_has_no_body");
  return {
    chainId: config.chainId,
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "setMetadata",
    args: [own.agentId, POINTER_KEY, encodePointer(order.chainId, own.body)],
  };
}

/** The states whose body the owner may point at: `deployed`, and `broken` because the pointer was
 *  cleared. Never a replaced or superseded body: pointing back at it breaks its replacement. And
 *  never a revoked one, which the flow does not offer either. */
function pointable(order: LegalBodyOrderView): boolean {
  if (order.revoked) return false;
  return (
    order.state === "deployed" || (order.state === "broken" && order.brokenReason === "not_linked")
  );
}

/** What the allowlist accepted: the calldata, and the arguments it was encoded from. */
type Checked = { ok: true; data: Hex; args: readonly unknown[] };

/** The allowlist itself; `allowedCall` shows its answer, `sendAllowedCall` sends it. */
function checkCall(req: WriteRequest, ctx: CallContext): Checked | Refusal {
  const { config } = ctx;
  if (req.value !== undefined && req.value !== BigInt(0)) return refuse("sends_value");
  if (req.chainId !== config.chainId) return refuse("wrong_chain");
  if (!sameAddress(req.address, config.identityRegistry)) return refuse("not_the_registry");
  if (req.abi !== identityRegistryAbi) return refuse("not_the_pinned_abi");
  // The type says an array; a request assembled elsewhere might not hold one.
  const args: readonly unknown[] | null = Array.isArray(req.args) ? req.args : null;

  if (req.functionName === "register") {
    if (args === null) return refuse("register_args");
    if (args.length === 0) {
      return {
        ok: true,
        data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [] }),
        args: [],
      };
    }
    const [uri] = args;
    if (args.length === 1 && typeof uri === "string") {
      return {
        ok: true,
        data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [uri] }),
        args: [uri],
      };
    }
    return refuse("register_args");
  }

  if (req.functionName === "setMetadata") {
    const order = ctx.order;
    if (order === null) return refuse("no_order");
    if (order.chainId !== config.chainId || !sameAddress(order.factory, config.factory))
      return refuse("order_on_another_deployment");
    if (!pointable(order)) return refuse("order_not_pointable");
    const own = bodyOf(order);
    if (own === null) return refuse("order_has_no_body");
    if (args === null || args.length !== 3) return refuse("set_metadata_args");
    const [agentId, key, value] = args;
    if (typeof agentId !== "bigint" || agentId !== own.agentId) return refuse("other_identity");
    if (key !== POINTER_KEY) return refuse("other_key");
    const expected = encodePointer(order.chainId, own.body);
    if (typeof value !== "string" || value.toLowerCase() !== expected) return refuse("other_body");
    return {
      ok: true,
      data: encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "setMetadata",
        args: [own.agentId, POINTER_KEY, expected],
      }),
      args: [own.agentId, POINTER_KEY, expected],
    };
  }

  return refuse("not_allowed");
}

/**
 * The allowlist's answer, for a screen to show. Both doors, this one and `sendAllowedCall`, pass
 * `checkCall`, which holds the rules, so there is one allowlist: exactly `register()` and
 * `register(string)` on the registry of `/config`'s chain, and `setMetadata(agentId, "legalBody",
 * pointer)` for the selected order's own identity and body. Refuses with the first rule broken, in
 * the order they are written. Returns the calldata it checked, encoded over the pinned ABI.
 */
export function allowedCall(
  req: WriteRequest,
  ctx: CallContext,
): { ok: true; data: Hex } | Refusal {
  const checked = checkCall(req, ctx);
  return checked.ok ? { ok: true, data: checked.data } : checked;
}

/** The request the wallet gets: the fields the allowlist read, with the arguments it checked
 *  (a new array, never the caller's, which could still change), and nothing else: a key it did not
 *  read (a calldata suffix, a nonce) never reaches the wallet. `gas` passes through untouched. */
function forwarded(req: WriteRequest, args: readonly unknown[]): WriteRequest {
  const out: WriteRequest = {
    chainId: req.chainId,
    address: req.address,
    abi: identityRegistryAbi,
    functionName: req.functionName,
    args,
  };
  if (req.value !== undefined) out.value = req.value;
  if (req.gas !== undefined) out.gas = req.gas;
  return out;
}

/**
 * The one door to the wallet: the allowlist, then the chain. Refuses, with a problem the screen
 * turns into a sentence, when this site is not configured for the request's chain or the wallet
 * is on another one, instead of switching the wallet silently. Otherwise one `writeContract`.
 */
export async function sendAllowedCall(
  req: WriteRequest,
  ctx: CallContext,
  deps: {
    walletChainId: number | undefined;
    configuredChainIds: readonly number[];
    writeContract: (req: WriteRequest) => Promise<Hex>;
  },
): Promise<{ ok: true; hash: Hex; data: Hex } | Refusal> {
  const checked = checkCall(req, ctx);
  if (!checked.ok) return checked;
  if (!deps.configuredChainIds.includes(req.chainId)) return refuse("chain_not_configured");
  if (deps.walletChainId !== req.chainId) return refuse("wallet_on_another_chain");
  const hash = await deps.writeContract(forwarded(req, checked.args));
  return { ok: true, hash, data: checked.data };
}

// ---------------------------------------------------------------------------------------------
// The mint
// ---------------------------------------------------------------------------------------------

/**
 * The agentId a `register` minted, from its receipt: the one `Transfer` from the zero address,
 * emitted by the registry, to the registering wallet. Anything else is null: never guess an id.
 * A receipt that says it did not succeed is null; one that names no status is read by its logs,
 * which a reverted transaction never carries.
 */
export function agentIdFromMint(
  receipt: { status?: string; logs: readonly { address: string; topics: readonly string[] }[] },
  ctx: { registry: Address; owner: Address },
): string | null {
  if (receipt.status !== undefined && receipt.status !== "success") return null;
  const mints = receipt.logs.filter(
    (l) =>
      sameAddress(l.address, ctx.registry) &&
      l.topics.length === 4 &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      ZERO_WORD.test(l.topics[1] ?? ""),
  );
  if (mints.length !== 1) return null;
  const [, , to, id] = mints[0].topics;
  const recipient = ADDRESS_WORD.exec(to ?? "");
  if (recipient === null || !sameAddress(`0x${recipient[1]}`, ctx.owner)) return null;
  if (!WORD.test(id ?? "")) return null;
  return BigInt(id).toString();
}
