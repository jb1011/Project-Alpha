import {
  type Address,
  type Hex,
  type TypedDataDefinition,
  compactSignatureToSignature,
  getAddress,
  hashTypedData,
  hexToBigInt,
  isAddress,
  isAddressEqual,
  isErc6492Signature,
  maxUint256,
  numberToHex,
  parseCompactSignature,
  parseSignature,
  recoverAddress,
  serializeSignature,
} from "viem";

/**
 * The message an identity owner signs to authorise a legal body for their agent.
 *
 * It mirrors, field for field and in order, the struct the LegalBodyFactory contract verifies.
 * Every field is pinned by the signature: the agent, the guardian, the amendment delay, the hash
 * of the operating agreement, and a deadline. The factory refuses a deadline more than 24 hours
 * ahead, and one signature can create at most one body.
 */
export interface LegalBodyLink {
  agentId: bigint;
  guardian: Address;
  /** Seconds. The factory accepts 48 hours to 30 days. */
  amendmentDelay: bigint;
  /** keccak256 of the frozen operating-agreement manifest (32 bytes). */
  operatingAgreementHash: Hex;
  /** Unix seconds, in CHAIN time. */
  deadline: bigint;
}

export const LINK_DOMAIN_NAME = "Novi LegalBodyFactory";
export const LINK_DOMAIN_VERSION = "1";
export const LINK_PRIMARY_TYPE = "LegalBodyLink";

/** The five fields of the contract's `LegalBodyLink` type string, in its order. */
export const LINK_FIELDS = [
  { name: "agentId", type: "uint256" },
  { name: "guardian", type: "address" },
  { name: "amendmentDelay", type: "uint256" },
  { name: "operatingAgreementHash", type: "bytes32" },
  { name: "deadline", type: "uint256" },
] as const;

const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** The factory refuses a deadline further ahead than this. */
export const MAX_LINK_WINDOW_SECONDS = 86_400n;
/** The longest lifetime the backend serves: ten minutes inside the factory's 24 hours, so a
 *  served deadline never sits on the edge of what the factory accepts. */
export const MAX_SERVED_LINK_TTL_SECONDS = 85_800n;
/** How long a served link stays signable by default. Short on purpose: the body is created
 *  seconds after the signature arrives, and a captured signature dies with its deadline. */
export const DEFAULT_LINK_TTL_SECONDS = 3_600n;
/** A link checked with less than this left could expire before its transaction is mined. */
export const MIN_LINK_REMAINING_SECONDS = 300n;

export function linkDomain(chainId: number, factory: Address) {
  return {
    name: LINK_DOMAIN_NAME,
    version: LINK_DOMAIN_VERSION,
    chainId,
    verifyingContract: factory,
  } as const;
}

/**
 * The SIGNING form, for a signer called from this process (a local key, or a remote signer's
 * client).
 *
 * `EIP712Domain` is declared explicitly. A local signer does not need it, but a signer that
 * serialises the typed data and signs it elsewhere drops the domain when the type is absent, and
 * then signs a digest the contract will never accept. Typed as viem's `TypedDataDefinition`
 * because viem would otherwise type the domain from the declared `EIP712Domain` and ask for a
 * bigint `chainId`. Its `uint256` fields are bigints, so it is not JSON: what goes over the wire
 * is `linkTypedDataWire`.
 */
export function buildLinkTypedData(p: {
  chainId: number;
  factory: Address;
  link: LegalBodyLink;
}): TypedDataDefinition {
  return {
    domain: linkDomain(p.chainId, p.factory),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, LegalBodyLink: LINK_FIELDS },
    primaryType: LINK_PRIMARY_TYPE,
    message: { ...p.link },
  };
}

/**
 * The VERIFYING form. viem derives the domain type from the `domain` object and refuses an
 * explicit `EIP712Domain` member, so verification uses the types without it. Both forms hash to
 * the same digest.
 */
export function linkVerifyTypes() {
  return { LegalBodyLink: LINK_FIELDS } as const;
}

/** The digest the owner's signature covers, computed off chain. The factory exposes the same
 *  value through its `linkDigest` view; callers that hold a client compare the two. */
export function offChainLinkDigest(p: {
  chainId: number;
  factory: Address;
  link: LegalBodyLink;
}): Hex {
  return hashTypedData({
    domain: linkDomain(p.chainId, p.factory),
    types: linkVerifyTypes(),
    primaryType: LINK_PRIMARY_TYPE,
    message: p.link,
  });
}

/** The deadline to serve: chain time plus a lifetime the backend is willing to serve. */
export function linkDeadline(
  chainNow: bigint,
  ttlSeconds: bigint = DEFAULT_LINK_TTL_SECONDS,
): bigint {
  if (ttlSeconds <= 0n) throw new Error("linkDeadline: the lifetime must be positive");
  if (ttlSeconds > MAX_SERVED_LINK_TTL_SECONDS)
    throw new Error(
      `linkDeadline: a served link lives at most ${MAX_SERVED_LINK_TTL_SECONDS} seconds`,
    );
  return chainNow + ttlSeconds;
}

/** True when the link can still be used: enough time left to mine the create, and not beyond the
 *  window the factory accepts. */
export function deadlineInWindow(deadline: bigint, chainNow: bigint): boolean {
  return (
    deadline >= chainNow + MIN_LINK_REMAINING_SECONDS &&
    deadline <= chainNow + MAX_LINK_WINDOW_SECONDS
  );
}

/**
 * The JSON-safe form served to a wallet, an agent or a CLI.
 *
 * Every `uint256` is a canonical decimal string and `chainId` a number, so `JSON.stringify` works
 * on it (it throws on a bigint). `EIP712Domain` is declared, as in the signing form. A wallet that
 * signs this object as it arrives signs the digest the factory computes.
 */
export interface LinkTypedDataWire {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: { EIP712Domain: typeof EIP712_DOMAIN_FIELDS; LegalBodyLink: typeof LINK_FIELDS };
  primaryType: "LegalBodyLink";
  message: {
    agentId: string;
    guardian: Address;
    amendmentDelay: string;
    operatingAgreementHash: Hex;
    deadline: string;
  };
}

export function linkTypedDataWire(p: {
  chainId: number;
  factory: Address;
  link: LegalBodyLink;
}): LinkTypedDataWire {
  const { link } = p;
  return {
    domain: linkDomain(p.chainId, p.factory),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, LegalBodyLink: LINK_FIELDS },
    primaryType: LINK_PRIMARY_TYPE,
    message: {
      agentId: link.agentId.toString(),
      guardian: link.guardian,
      amendmentDelay: link.amendmentDelay.toString(),
      operatingAgreementHash: link.operatingAgreementHash,
      deadline: link.deadline.toString(),
    },
  };
}

/** A link message that is not the shape `linkTypedDataWire` serves. */
export class LinkShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkShapeError";
  }
}

const LINK_FIELD_NAMES: readonly string[] = LINK_FIELDS.map((f) => f.name);
const UINT256_FIELDS = ["agentId", "amendmentDelay", "deadline"] as const;
/** Digits only, no sign, no leading zero except "0" itself, at most 78 digits (2^256 has 78). */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/;
const WHOLE_BYTES_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * The link inside a message that came back over the wire, or a `LinkShapeError`.
 *
 * Strict on purpose: the message must have exactly the five fields, every `uint256` must be the
 * canonical decimal string `linkTypedDataWire` serves (a JavaScript number is refused, even an
 * integer, because it may already have lost precision), the guardian must be an address and the
 * hash 32 bytes of hex. The guardian comes back checksummed and the hash in lower case.
 */
export function linkFromWire(message: unknown): LegalBodyLink {
  if (typeof message !== "object" || message === null || Array.isArray(message))
    throw new LinkShapeError("the link message is not an object");
  const m = message as Record<string, unknown>;
  for (const key of Object.keys(m))
    if (!LINK_FIELD_NAMES.includes(key))
      throw new LinkShapeError("the link message has a field the link does not define");
  for (const name of LINK_FIELD_NAMES)
    if (!Object.hasOwn(m, name)) throw new LinkShapeError(`the link message has no ${name}`);

  if (typeof m.guardian !== "string" || !isAddress(m.guardian))
    throw new LinkShapeError("guardian is not an address");
  if (typeof m.operatingAgreementHash !== "string" || !BYTES32_HEX.test(m.operatingAgreementHash))
    throw new LinkShapeError("operatingAgreementHash is not 32 bytes of hex");
  return {
    agentId: wireUint256(m.agentId, "agentId"),
    guardian: getAddress(m.guardian),
    amendmentDelay: wireUint256(m.amendmentDelay, "amendmentDelay"),
    operatingAgreementHash: m.operatingAgreementHash.toLowerCase() as Hex,
    deadline: wireUint256(m.deadline, "deadline"),
  };
}

function wireUint256(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value))
    throw new LinkShapeError(`${name} is not a canonical decimal string`);
  const parsed = BigInt(value);
  if (parsed > maxUint256) throw new LinkShapeError(`${name} is not below 2^256`);
  return parsed;
}

/**
 * A sentence naming what is wrong with the shape of a link and its signature, or `undefined`.
 *
 * Shape only: each `uint256` within range, the hash 32 bytes of hex, the guardian an address, the
 * signature `0x` followed by whole bytes of hex. An empty signature (`0x`) is well formed: a
 * contract owner may have approved the digest on chain. Whether the signature is valid, and
 * whether the values suit the factory (its bounds on the delay, for one), only the factory says.
 */
export function linkShapeProblem(link: LegalBodyLink, signature: Hex): string | undefined {
  for (const name of UINT256_FIELDS) {
    const value: unknown = link[name];
    if (typeof value !== "bigint" || value < 0n || value > maxUint256)
      return `${name} is not a uint256`;
  }
  if (
    typeof link.operatingAgreementHash !== "string" ||
    !BYTES32_HEX.test(link.operatingAgreementHash)
  )
    return "operatingAgreementHash is not 32 bytes of hex";
  if (typeof link.guardian !== "string" || !isAddress(link.guardian))
    return "guardian is not an address";
  if (typeof signature !== "string" || !WHOLE_BYTES_HEX.test(signature))
    return "the signature is not 0x followed by whole bytes of hex";
  return undefined;
}

/**
 * True when the signature ends with the 32-byte ERC-6492 suffix (`0x6492…6492`): the wrapper a
 * wallet that is not deployed yet puts around its signature.
 */
export function isErc6492Wrapped(signature: Hex): boolean {
  return isErc6492Signature(signature);
}

/** The secp256k1 group order. A signature with `s` above half of it has a low twin. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/**
 * The owner's own ECDSA signature in the one form the factory's ECDSA check accepts: 65 bytes,
 * `v` of 27 or 28, low `s`.
 *
 * Three rewrites, each made ONLY when the rewritten signature recovers to `owner`:
 *  - a 64-byte compact (EIP-2098) signature becomes 65 bytes;
 *  - a `v` of 0 or 1 becomes 27 or 28;
 *  - a high `s` becomes its low twin, with `v` flipped.
 *
 * In every other case the input comes back byte for byte. This never refuses anything: the
 * factory is the only judge of a signature. A contract wallet's signature is its own encoding,
 * and its last byte can carry the wallet's own meaning, so rewriting it would corrupt it.
 */
export async function canonicalLinkSignature(p: {
  digest: Hex;
  owner: Address;
  signature: Hex;
}): Promise<Hex> {
  const candidate = canonicalEcdsaForm(p.signature);
  if (candidate === undefined || candidate.toLowerCase() === p.signature.toLowerCase())
    return p.signature;
  try {
    const recovered = await recoverAddress({ hash: p.digest, signature: candidate });
    return isAddressEqual(recovered, p.owner) ? candidate : p.signature;
  } catch {
    return p.signature;
  }
}

/** The 65-byte, `v` 27/28, low-`s` reading of a 64- or 65-byte signature, or `undefined` when it
 *  has no such reading. Says nothing about who signed it. */
function canonicalEcdsaForm(signature: Hex): Hex | undefined {
  if (!WHOLE_BYTES_HEX.test(signature)) return undefined;
  const bytes = (signature.length - 2) / 2;
  try {
    const parsed =
      bytes === 64
        ? compactSignatureToSignature(parseCompactSignature(signature))
        : bytes === 65
          ? parseSignature(signature)
          : undefined;
    if (parsed?.yParity === undefined) return undefined;
    let s = hexToBigInt(parsed.s);
    let yParity = parsed.yParity;
    if (s > SECP256K1_HALF_N) {
      s = SECP256K1_N - s;
      yParity = 1 - yParity;
    }
    return serializeSignature({ r: parsed.r, s: numberToHex(s, { size: 32 }), yParity });
  } catch {
    return undefined;
  }
}
