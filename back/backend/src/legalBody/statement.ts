import {
  type Address,
  type Hex,
  hashTypedData,
  keccak256,
  recoverAddress,
  stringToBytes,
} from "viem";
import type { LegalText } from "./texts/index";
import type { StatementFields } from "./texts/statementOfAuthority";

/**
 * The statement of authority as EIP-712 typed data: what a guardian signs to declare an existing
 * Wyoming LLC as the company behind a legal body, and how that signature is checked.
 *
 * The message carries the rendered sentence AND every field it was rendered from, the version of
 * the wording and the time it was issued, so a wallet shows the signer the whole sentence and the
 * signature pins every word of it. The domain names the chain and the deployment's legal-body
 * factory, so a statement signed for one deployment is worth nothing on another. No contract reads
 * this signature: the factory is a name in the domain, not a verifier.
 *
 * The signature is checked by local ECDSA recovery, with no node, so a stored declaration can be
 * checked again from its row alone, at any time.
 */

export const STATEMENT_DOMAIN_NAME = "Novi Corpus Statement of Authority";
export const STATEMENT_DOMAIN_VERSION = "1";
export const STATEMENT_PRIMARY_TYPE = "StatementOfAuthority";
/** A statement issued longer ago than this, by the server's clock, is stale. */
export const STATEMENT_MAX_AGE_SECONDS = 600n;
/** A statement issued further ahead of the server's clock than this is stale: room for a
 *  client's clock that runs a little fast, and no more. */
export const STATEMENT_MAX_AHEAD_SECONDS = 60n;

/** The fields of the `StatementOfAuthority` type string, in its order. */
const STATEMENT_FIELDS = [
  { name: "statement", type: "string" },
  { name: "declarantName", type: "string" },
  { name: "declarantTitle", type: "string" },
  { name: "companyName", type: "string" },
  { name: "jurisdiction", type: "string" },
  { name: "filingNumber", type: "string" },
  { name: "guardian", type: "address" },
  { name: "wordingVersion", type: "string" },
  { name: "issuedAt", type: "uint256" },
] as const;

const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export interface StatementMessage extends StatementFields {
  /** The sentence, rendered by the server from the fields and its own wording. */
  statement: string;
  /** The version of the wording the sentence was rendered from. */
  wordingVersion: string;
  /** Unix seconds. */
  issuedAt: bigint;
}

/**
 * The JSON-safe form served to a wallet. `issuedAt` is a canonical decimal string and `chainId` a
 * number, so `JSON.stringify` works on it (it throws on a bigint). `EIP712Domain` is declared: a
 * signer that serialises the typed data and signs it elsewhere drops the domain when the type is
 * absent, and would then sign a digest nobody computes. A wallet that signs this object as it
 * arrives signs `statementDigest`.
 */
export interface StatementTypedDataWire {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: {
    EIP712Domain: readonly { name: string; type: string }[];
    StatementOfAuthority: readonly { name: string; type: string }[];
  };
  primaryType: "StatementOfAuthority";
  message: Omit<StatementMessage, "issuedAt"> & { issuedAt: string };
}

export function statementDomain(
  chainId: number,
  factory: Address,
): { name: string; version: string; chainId: number; verifyingContract: Address } {
  return {
    name: STATEMENT_DOMAIN_NAME,
    version: STATEMENT_DOMAIN_VERSION,
    chainId,
    verifyingContract: factory,
  };
}

/**
 * The message for these fields under this wording. The sentence is rendered here, from the fields
 * and the text, and the version is the text's own: nothing else the caller's object holds is
 * carried over.
 */
export function buildStatementMessage(
  fields: StatementFields,
  text: LegalText<StatementFields>,
  issuedAt: bigint,
): StatementMessage {
  return {
    statement: text.render(fields),
    declarantName: fields.declarantName,
    declarantTitle: fields.declarantTitle,
    companyName: fields.companyName,
    jurisdiction: fields.jurisdiction,
    filingNumber: fields.filingNumber,
    guardian: fields.guardian,
    wordingVersion: text.version,
    issuedAt,
  };
}

export function statementTypedDataWire(
  chainId: number,
  factory: Address,
  m: StatementMessage,
): StatementTypedDataWire {
  return {
    domain: statementDomain(chainId, factory),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, StatementOfAuthority: STATEMENT_FIELDS },
    primaryType: STATEMENT_PRIMARY_TYPE,
    message: {
      statement: m.statement,
      declarantName: m.declarantName,
      declarantTitle: m.declarantTitle,
      companyName: m.companyName,
      jurisdiction: m.jurisdiction,
      filingNumber: m.filingNumber,
      guardian: m.guardian,
      wordingVersion: m.wordingVersion,
      issuedAt: m.issuedAt.toString(),
    },
  };
}

/** The digest a signature over the statement covers. viem derives the domain type from the domain
 *  itself, so the types here leave `EIP712Domain` out; the wire form hashes to the same value. */
export function statementDigest(chainId: number, factory: Address, m: StatementMessage): Hex {
  return hashTypedData({
    domain: statementDomain(chainId, factory),
    types: { StatementOfAuthority: STATEMENT_FIELDS },
    primaryType: STATEMENT_PRIMARY_TYPE,
    message: m,
  });
}

/** keccak256 of the sentence's UTF-8 bytes: the same value EIP-712 encodes for the `statement`
 *  field. */
export function statementHash(m: StatementMessage): Hex {
  return keccak256(stringToBytes(m.statement));
}

export type StatementProblem = "wrong_wording" | "stale" | "bad_signature" | "unsupported_signer";

/** `0x` followed by whole bytes of hex. */
const WHOLE_BYTES_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
/** r, s and v: the only signature form accepted. */
const ECDSA_SIGNATURE_BYTES = 65;

/**
 * Checks a signed statement of authority. It never takes a sentence from the client: it renders
 * the message from the fields and the server's own text, and checks the signature over THAT. A
 * signature over any other sentence, version, chain or factory therefore fails, whatever the
 * client says it signed.
 *
 * The checks, in order:
 *  - `wrong_wording`: the guardian named in the fields is not the tenant, spelled exactly as the
 *    session spells it (checksummed), so a stored sentence names the wallet in one spelling only;
 *  - `stale`: `issuedAt` is more than 600 seconds before `nowSeconds` or more than 60 after it;
 *  - `unsupported_signer`: the signature is not 65 bytes. Sign-in is ECDSA only, so the tenant is
 *    always an address a key controls; a statement accepted on a contract's answer could not be
 *    checked again from the stored row later;
 *  - `bad_signature`: the signature is not hex, or does not recover, over the digest, to the
 *    tenant.
 *
 * A refusal is a value, never a throw. Only a fault on the server's side (a factory that is not an
 * address, fields missing from the text) still throws.
 */
export async function verifyStatement(p: {
  chainId: number;
  factory: Address;
  tenant: Address;
  text: LegalText<StatementFields>;
  fields: StatementFields;
  issuedAt: bigint;
  signature: Hex;
  nowSeconds: bigint;
}): Promise<
  { ok: true; message: StatementMessage; digest: Hex } | { ok: false; problem: StatementProblem }
> {
  if (p.fields.guardian !== p.tenant) return { ok: false, problem: "wrong_wording" };
  if (
    p.issuedAt < p.nowSeconds - STATEMENT_MAX_AGE_SECONDS ||
    p.issuedAt > p.nowSeconds + STATEMENT_MAX_AHEAD_SECONDS
  )
    return { ok: false, problem: "stale" };
  if (typeof p.signature !== "string" || !WHOLE_BYTES_HEX.test(p.signature))
    return { ok: false, problem: "bad_signature" };
  if ((p.signature.length - 2) / 2 !== ECDSA_SIGNATURE_BYTES)
    return { ok: false, problem: "unsupported_signer" };

  const message = buildStatementMessage(p.fields, p.text, p.issuedAt);
  const digest = statementDigest(p.chainId, p.factory, message);
  let signer: Address;
  try {
    signer = await recoverAddress({ hash: digest, signature: p.signature });
  } catch {
    // An r or s out of range, or a v that is no recovery bit.
    return { ok: false, problem: "bad_signature" };
  }
  if (signer.toLowerCase() !== p.tenant.toLowerCase())
    return { ok: false, problem: "bad_signature" };
  return { ok: true, message, digest };
}
