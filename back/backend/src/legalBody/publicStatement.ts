import {
  type Address,
  type Hex,
  type LocalAccount,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  stringToBytes,
  verifyTypedData,
  zeroAddress,
} from "viem";
import type { AgentSnapshot, BodySnapshot, CodeKind } from "../adapters/arc/legalBodyChain";
import { canonicalizeJcs } from "../oa/manifest";
import { isCalendarDate } from "../util/wyomingCalendar";
import type { Attestation, AttestationState } from "./attestation";
import type { FilingFacts, FilingStatus } from "./filings";
import { CUSTOMER_PROVIDER } from "./provider";
import {
  type PublicBindingState,
  type Standing,
  type StandingReason,
  computeStanding,
} from "./standing";

/**
 * THE PUBLIC LEGAL-BODY STATEMENT: what Novi states about a legal body, built from one block's
 * chain facts and the facts the deployment recorded, and signed per request (EIP-712).
 *
 * What binds it: the domain names the chain and no contract; the message names the chain again,
 * the identity registry, the factory, the body and the agent, so a statement says nothing about
 * another deployment; and it expires STATEMENT_TTL_SECONDS after it was issued.
 *
 * FLAT, like the v1 attestation (`src/hedera/attestation.ts`): a Solidity verifier hashes it with
 * no nested struct. A field that can be absent has a sentinel the real field never takes: the zero
 * address for no agent wallet, "" for an absent string or date, 0 for an absent time or report
 * year. A boolean has no sentinel: `false` means "not established".
 *
 * ONE list of the 33 fields drives the typed data, the JSON form and its strict reading, and ONE
 * flattener builds the message for the signer and the verifier alike, so the two cannot drift.
 */

export const STATEMENT_DOMAIN_NAME = "Novi Corpus Attestation";
export const STATEMENT_DOMAIN_VERSION = "2";
export const STATEMENT_PRIMARY_TYPE = "LegalBodyStatement";
/** How long a statement is good for, in seconds from its issue. */
export const STATEMENT_TTL_SECONDS = 300;
export const STATEMENT_JURISDICTION = "WY";
export const STATEMENT_ENTITY_TYPE = "LLC";

type FieldType = "uint256" | "address" | "bytes32" | "bool" | "string";

/** The 33 fields, in their fixed order: the order of the type string. */
const FIELDS = [
  { name: "chainId", type: "uint256" },
  { name: "identityRegistry", type: "address" },
  { name: "factory", type: "address" },
  { name: "legalBody", type: "address" },
  { name: "agentId", type: "uint256" },
  { name: "agentWallet", type: "address" },
  { name: "identityOwnerAtCreation", type: "address" },
  { name: "bindingState", type: "string" },
  { name: "identityOwnerIsContract", type: "bool" },
  { name: "agentWalletIsContract", type: "bool" },
  { name: "standing", type: "string" },
  { name: "attestationState", type: "string" },
  { name: "jurisdiction", type: "string" },
  { name: "entityType", type: "string" },
  { name: "legalName", type: "string" },
  { name: "filingNumber", type: "string" },
  { name: "source", type: "string" },
  { name: "environment", type: "string" },
  { name: "controlVerified", type: "bool" },
  { name: "existenceCheckedAt", type: "uint256" },
  { name: "filedAt", type: "string" },
  { name: "einIssued", type: "bool" },
  { name: "filingStatus", type: "string" },
  { name: "lastFiledPeriod", type: "uint256" },
  { name: "lastFiledAt", type: "string" },
  { name: "lastFiledConfirmedBy", type: "string" },
  { name: "nextDue", type: "string" },
  { name: "oaManifestHash", type: "bytes32" },
  { name: "oaManifestVersion", type: "uint256" },
  { name: "guardianHumanVerified", type: "bool" },
  { name: "observedAtBlock", type: "uint256" },
  { name: "issuedAt", type: "uint256" },
  { name: "expiresAt", type: "uint256" },
] as const satisfies readonly { name: keyof LegalBodyStatement; type: FieldType }[];

/**
 * The EIP-712 type of the statement, verbatim: what a verifier hashes. The 33 fields above produce
 * it, which a test asserts.
 */
export const LEGAL_BODY_STATEMENT_TYPE_STRING: string =
  "LegalBodyStatement(uint256 chainId,address identityRegistry,address factory,address legalBody,uint256 agentId,address agentWallet,address identityOwnerAtCreation,string bindingState,bool identityOwnerIsContract,bool agentWalletIsContract,string standing,string attestationState,string jurisdiction,string entityType,string legalName,string filingNumber,string source,string environment,bool controlVerified,uint256 existenceCheckedAt,string filedAt,bool einIssued,string filingStatus,uint256 lastFiledPeriod,string lastFiledAt,string lastFiledConfirmedBy,string nextDue,bytes32 oaManifestHash,uint256 oaManifestVersion,bool guardianHumanVerified,uint256 observedAtBlock,uint256 issuedAt,uint256 expiresAt)";

/**
 * The typed data's types: one primary type of 33 fields.
 *
 * DECLARED WIDE on purpose: under the list's literal type, viem's signTypedData and verifyTypedData
 * type the message field by field and refuse the flattener's `Record<string, unknown>`.
 */
export const LEGAL_BODY_STATEMENT_TYPES: {
  LegalBodyStatement: readonly { name: string; type: string }[];
} = { LegalBodyStatement: FIELDS };

/** The domain: the name, version "2" and the chain id. No verifying contract: no contract reads the
 *  signature, and the factory the statement is about is in the message. */
export function statementDomain(chainId: number): {
  name: string;
  version: string;
  chainId: number;
} {
  return { name: STATEMENT_DOMAIN_NAME, version: STATEMENT_DOMAIN_VERSION, chainId };
}

export interface LegalBodyStatement {
  chainId: bigint;
  identityRegistry: Address;
  factory: Address;
  legalBody: Address;
  agentId: bigint;
  /** The agent's wallet in the identity registry; the zero address when it has none. */
  agentWallet: Address;
  /** The identity's owner when the body was created, as the factory recorded it. */
  identityOwnerAtCreation: Address;
  bindingState: PublicBindingState;
  /** The identity owner at creation holds contract code (a delegated account does not count):
   *  verify its signatures with ERC-1271, not ecrecover. */
  identityOwnerIsContract: boolean;
  /** The same for the agent's wallet; false for the zero wallet. */
  agentWalletIsContract: boolean;
  standing: Standing;
  attestationState: AttestationState;
  jurisdiction: "WY";
  entityType: "LLC";
  /** "" unless the names may be shown (see {@link assembleStatement}). */
  legalName: string;
  filingNumber: string;
  source: "customer" | "novi";
  environment: "sandbox" | "production";
  /** The operator saw evidence that the declarant controls the company. */
  controlVerified: boolean;
  /** Unix seconds of the check that established the company; 0 when none did. */
  existenceCheckedAt: bigint;
  /** The formation date, or "". */
  filedAt: string;
  einIssued: boolean;
  filingStatus: FilingStatus;
  /** The year of the recorded report that counts; 0 when none does. */
  lastFiledPeriod: bigint;
  lastFiledAt: string;
  lastFiledConfirmedBy: "" | "operator";
  nextDue: string;
  /** The operating agreement frozen for the body: the hash the chain is compared against. */
  oaManifestHash: Hex;
  oaManifestVersion: bigint;
  guardianHumanVerified: boolean;
  /** The block every chain fact of the statement was read at. */
  observedAtBlock: bigint;
  /** Unix seconds. */
  issuedAt: bigint;
  /** `issuedAt` + STATEMENT_TTL_SECONDS. */
  expiresAt: bigint;
}

/** The JSON form: every uint256 as a canonical decimal string (JSON numbers are doubles). */
export type LegalBodyStatementJson = {
  [K in keyof LegalBodyStatement]: LegalBodyStatement[K] extends bigint
    ? string
    : LegalBodyStatement[K];
};

/** What is served: the typed data in JSON, the signer's address and the signature. */
export interface SignedStatementJson {
  domain: { name: string; version: string; chainId: number };
  primaryType: "LegalBodyStatement";
  message: LegalBodyStatementJson;
  /** The address that signed. A verifier never trusts it: it checks against the attestor it took
   *  from ENS or the published docs. */
  attestor: Address;
  signature: Hex;
}

/**
 * The chain disagrees with the row on what the body is, or the body is not one this deployment
 * states. Nothing is signed. `problem` is a code (`body_mismatch`, `not_ours`, `agent_mismatch`,
 * `unsupported_provider`, or a caller's own), never a name, a number or an address, so it can go
 * into an ops line as it is.
 */
export class StatementIntegrityError extends Error {
  constructor(readonly problem: string) {
    super(`legal-body statement refused: ${problem}`);
    this.name = "StatementIntegrityError";
  }
}

export interface StatementInputs {
  chainId: number;
  identityRegistry: Address;
  factory: Address;
  /** The legal-body row, its nullable fields already narrowed by the caller. */
  row: {
    bodyAddress: Address;
    agentId: string;
    identityOwner: Address;
    oaManifestHash: Hex;
    oaManifestVersion: number;
  };
  /** The agent and the body as the chain stood at `observedAtBlock`. */
  agent: AgentSnapshot;
  body: BodySnapshot;
  observedAtBlock: bigint;
  /** The code at the body's creator, and at the agent's wallet, at `observedAtBlock`. */
  ownerCode: CodeKind;
  walletCode: CodeKind;
  /** The company's provider: only a customer's own company is stated. */
  provider: string;
  attestation: Attestation;
  /** The names a public surface may show, or null (`publicCompanyNames`). */
  names: { legalName: string; filingNumber: string } | null;
  filing: FilingFacts;
  guardianHumanVerified: boolean;
  environment: "sandbox" | "production";
  /** Unix seconds. */
  issuedAt: number;
}

/**
 * The statement, unsigned, and every reason behind its standing.
 *
 * REFUSED with a StatementIntegrityError, checked in this order, when:
 *  1. `body_mismatch`: the body read is not the row's;
 *  2. `not_ours`: the factory recorded no creator for it, or another than the row's identity owner;
 *  3. `agent_mismatch`: the agent read, or the agent the body names itself, is not the row's;
 *  4. `unsupported_provider`: the company is not a customer's own.
 *
 * THE NAMES are stated only while the binding is linked, the attestation is not revoked, and a
 * passed check made them public (`names` is not null); otherwise both are "". A broken binding or a
 * revocation takes them off the next statement.
 *
 * THE FLAGS are true only for contract code. A delegated account (EIP-7702) is not a contract here:
 * its key still signs with plain ECDSA, which is what a flag tells a reader. The zero wallet is no
 * account at all: false, whatever its code read says.
 *
 * Every address is written in its EIP-55 form and the hash in lower case, as the JSON form writes
 * them, so a statement equals its own JSON round trip.
 */
export function assembleStatement(p: StatementInputs): {
  statement: LegalBodyStatement;
  reasons: StandingReason[];
} {
  const { row, agent, body } = p;
  if (!isAddressEqual(body.body, row.bodyAddress))
    throw new StatementIntegrityError("body_mismatch");
  if (body.creator === undefined || !isAddressEqual(body.creator, row.identityOwner))
    throw new StatementIntegrityError("not_ours");
  // A row's agent id is a canonical decimal, compared as text: no other spelling names the agent.
  if (agent.agentId.toString() !== row.agentId || body.metaAgentId.toString() !== row.agentId)
    throw new StatementIntegrityError("agent_mismatch");
  if (p.provider !== CUSTOMER_PROVIDER) throw new StatementIntegrityError("unsupported_provider");

  const bindingState: PublicBindingState =
    agent.linked !== undefined && isAddressEqual(agent.linked, row.bodyAddress)
      ? "linked"
      : "broken";
  const { standing, reasons } = computeStanding(
    { bindingState, status: body.status, oaHashOnChain: body.oaHash },
    { frozenOaHash: row.oaManifestHash, attestation: p.attestation.state, filing: p.filing },
  );
  const names = bindingState === "linked" && p.attestation.state !== "revoked" ? p.names : null;
  const hasWallet = !isAddressEqual(agent.agentWallet, zeroAddress);
  const issuedAt = BigInt(p.issuedAt);
  return {
    statement: {
      chainId: BigInt(p.chainId),
      identityRegistry: getAddress(p.identityRegistry),
      factory: getAddress(p.factory),
      legalBody: getAddress(row.bodyAddress),
      agentId: agent.agentId,
      agentWallet: getAddress(agent.agentWallet),
      identityOwnerAtCreation: getAddress(body.creator),
      bindingState,
      identityOwnerIsContract: p.ownerCode === "contract",
      agentWalletIsContract: hasWallet && p.walletCode === "contract",
      standing,
      attestationState: p.attestation.state,
      jurisdiction: STATEMENT_JURISDICTION,
      entityType: STATEMENT_ENTITY_TYPE,
      legalName: names?.legalName ?? "",
      filingNumber: names?.filingNumber ?? "",
      source: "customer",
      environment: p.environment,
      controlVerified: p.attestation.controlVerified,
      existenceCheckedAt: BigInt(p.attestation.existenceCheckedAt ?? 0),
      filedAt: p.filing.filedAt,
      // Novi checks no EIN for a company its customer brought.
      einIssued: false,
      filingStatus: p.filing.filingStatus,
      lastFiledPeriod: BigInt(p.filing.lastFiledPeriod),
      lastFiledAt: p.filing.lastFiledAt,
      lastFiledConfirmedBy: p.filing.lastFiledConfirmedBy,
      nextDue: p.filing.nextDue,
      oaManifestHash: row.oaManifestHash.toLowerCase() as Hex,
      oaManifestVersion: BigInt(row.oaManifestVersion),
      guardianHumanVerified: p.guardianHumanVerified,
      observedAtBlock: p.observedAtBlock,
      issuedAt,
      expiresAt: issuedAt + BigInt(STATEMENT_TTL_SECONDS),
    },
    reasons,
  };
}

/**
 * THE ONE FLATTENER: the typed-data message, the 33 fields in the type's order, each value as it
 * is. The signer and the verifier both build their message here.
 */
export function statementMessage(s: LegalBodyStatement): Record<string, unknown> {
  return Object.fromEntries(FIELDS.map(({ name }) => [name, s[name]]));
}

/** The JSON form, the fields in the type's order: every uint256 a canonical decimal string, every
 *  address in its EIP-55 form, the bytes32 in lower case, booleans and strings as they are. */
export function statementJson(s: LegalBodyStatement): LegalBodyStatementJson {
  const json: Record<string, string | boolean> = {};
  for (const { name, type } of FIELDS) {
    const value = s[name];
    switch (type) {
      case "uint256":
        json[name] = (value as bigint).toString();
        break;
      case "address":
        json[name] = getAddress(value as Address);
        break;
      case "bytes32":
        json[name] = (value as Hex).toLowerCase();
        break;
      case "bool":
      case "string":
        json[name] = value as boolean | string;
        break;
    }
  }
  return json as LegalBodyStatementJson;
}

const UINT256_MAX = 2n ** 256n - 1n;
/** A canonical decimal: no sign, no space, no leading zero, at most 78 digits. */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const LOWER_BYTES32 = /^0x[0-9a-f]{64}$/;

/** The values each enumerated field allows. */
const ENUMERATIONS: {
  readonly [K in keyof LegalBodyStatement]?: readonly LegalBodyStatement[K][];
} = {
  bindingState: ["linked", "broken"],
  standing: ["pending", "active", "unknown", "inactive"],
  attestationState: ["pending", "active", "revoked"],
  jurisdiction: [STATEMENT_JURISDICTION],
  entityType: [STATEMENT_ENTITY_TYPE],
  source: ["customer", "novi"],
  environment: ["sandbox", "production"],
  filingStatus: ["not_yet_due", "filed", "past_due_unverified", "unverified"],
  lastFiledConfirmedBy: ["", "operator"],
};

/** The fields that hold a Wyoming calendar date, or "". */
const DATE_FIELDS: ReadonlySet<keyof LegalBodyStatement> = new Set([
  "filedAt",
  "lastFiledAt",
  "nextDue",
]);

/**
 * The statement from its JSON form, read STRICTLY: the canonical form only, exactly as
 * {@link statementJson} writes it. Exactly the 33 keys; a uint256 a canonical decimal string below
 * 2^256; an address in its exact EIP-55 form (a valid lower-case address is refused); the bytes32
 * a lower-case `0x` and 64 hex digits; a boolean a JSON boolean; a string a JSON string, an
 * enumerated one from its list and a date "" or a calendar date. Throws a plain Error otherwise.
 *
 * Why so strict: viem's typed-data encoder reads "042", "0x2a" and " 42" all as 42, and an address
 * or a hash in any letter case as the same bytes, so one signature would verify over many texts.
 * Read in one form only, a signed statement has one text.
 */
export function statementFromJson(j: unknown): LegalBodyStatement {
  if (typeof j !== "object" || j === null || Array.isArray(j))
    throw new Error("statement: not a JSON object");
  const o = j as Record<string, unknown>;
  if (
    Object.keys(o).length !== FIELDS.length ||
    !FIELDS.every(({ name }) => Object.hasOwn(o, name))
  )
    throw new Error(`statement: the keys are not exactly its ${FIELDS.length} fields`);
  const s: Record<string, unknown> = {};
  for (const { name, type } of FIELDS) s[name] = fieldFromJson(name, type, o[name]);
  return s as unknown as LegalBodyStatement;
}

/** One field of the JSON form, read strictly (see {@link statementFromJson}). */
function fieldFromJson(name: keyof LegalBodyStatement, type: FieldType, v: unknown): unknown {
  switch (type) {
    case "uint256":
      if (typeof v !== "string" || !CANONICAL_DECIMAL.test(v) || BigInt(v) > UINT256_MAX)
        throw new Error(`statement: ${name} is not a uint256 written as a canonical decimal`);
      return BigInt(v);
    case "address":
      if (typeof v !== "string" || !isAddress(v, { strict: false }) || getAddress(v) !== v)
        throw new Error(`statement: ${name} is not an address in its EIP-55 form`);
      return v;
    case "bytes32":
      if (typeof v !== "string" || !LOWER_BYTES32.test(v))
        throw new Error(`statement: ${name} is not 32 bytes in lower-case hex`);
      return v;
    case "bool":
      if (typeof v !== "boolean") throw new Error(`statement: ${name} is not a boolean`);
      return v;
    case "string": {
      if (typeof v !== "string") throw new Error(`statement: ${name} is not a string`);
      const allowed = ENUMERATIONS[name] as readonly string[] | undefined;
      if (allowed !== undefined && !allowed.includes(v))
        throw new Error(`statement: ${name} is not one of its values`);
      if (DATE_FIELDS.has(name) && v !== "" && !isCalendarDate(v))
        throw new Error(`statement: ${name} is neither "" nor a calendar date`);
      return v;
    }
  }
}

/**
 * The hash of what a statement CLAIMS: keccak256 over the UTF-8 bytes of the canonical JSON
 * (RFC 8785) of its JSON form without `observedAtBlock`, `issuedAt` and `expiresAt`. Two statements
 * that claim the same thing hash alike, whenever they were read and issued.
 */
export function claimsHash(s: LegalBodyStatement): Hex {
  const {
    observedAtBlock: _observedAtBlock,
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    ...claims
  } = statementJson(s);
  return keccak256(stringToBytes(canonicalizeJcs(claims)));
}

/** Signs the statement with `signer`. The answer is what is served: the domain, the primary type,
 *  the JSON form, the signer's address and the signature. */
export async function signStatement(
  s: LegalBodyStatement,
  signer: LocalAccount,
): Promise<SignedStatementJson> {
  const domain = statementDomain(Number(s.chainId));
  const signature = await signer.signTypedData({
    domain,
    types: LEGAL_BODY_STATEMENT_TYPES,
    primaryType: STATEMENT_PRIMARY_TYPE,
    message: statementMessage(s),
  });
  return {
    domain,
    primaryType: STATEMENT_PRIMARY_TYPE,
    message: statementJson(s),
    attestor: signer.address,
    signature,
  };
}

const ENVELOPE_KEYS = ["domain", "primaryType", "message", "attestor", "signature"] as const;
const DOMAIN_KEYS = ["name", "version", "chainId"] as const;
/** A signature as a signer writes it: r, s and v, 65 bytes in hex. */
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/** `v` is an object, not an array, whose own keys are exactly `keys`. */
function hasExactly(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}

/**
 * Whether `signed` is a statement the caller's attestor signed for the expected chain, valid at
 * `nowSeconds`. FALSE, and never a throw, unless every one of these holds:
 *  - the envelope has exactly its five keys and the domain exactly its three (a
 *    `verifyingContract` answers false), and the message reads strictly ({@link statementFromJson});
 *  - the domain is `statementDomain(expectedChainId)` and the message names the same chain;
 *  - `issuedAt <= nowSeconds <= expiresAt`, and `expiresAt - issuedAt` is STATEMENT_TTL_SECONDS;
 *  - the signature recovers to `opts.attestor`, by plain ECDSA.
 *
 * The attestor is the CALLER'S, taken from ENS or the published docs. The envelope's own `attestor`
 * must be an address and is never used: a forged statement can name any signer it likes.
 */
export async function verifyStatement(
  signed: unknown,
  opts: { attestor: Address; expectedChainId: number; nowSeconds: number },
): Promise<boolean> {
  try {
    if (!hasExactly(signed, ENVELOPE_KEYS)) return false;
    const { domain, primaryType, message, attestor, signature } = signed;
    const expected = statementDomain(opts.expectedChainId);
    if (!hasExactly(domain, DOMAIN_KEYS)) return false;
    if (
      domain.name !== expected.name ||
      domain.version !== expected.version ||
      domain.chainId !== expected.chainId
    )
      return false;
    if (primaryType !== STATEMENT_PRIMARY_TYPE) return false;
    if (typeof attestor !== "string" || !isAddress(attestor)) return false;
    if (typeof signature !== "string" || !SIGNATURE.test(signature)) return false;
    const s = statementFromJson(message);
    if (s.chainId !== BigInt(opts.expectedChainId)) return false;
    const now = BigInt(opts.nowSeconds);
    if (now < s.issuedAt || now > s.expiresAt) return false;
    if (s.expiresAt - s.issuedAt !== BigInt(STATEMENT_TTL_SECONDS)) return false;
    return await verifyTypedData({
      address: opts.attestor,
      domain: expected,
      types: LEGAL_BODY_STATEMENT_TYPES,
      primaryType: STATEMENT_PRIMARY_TYPE,
      message: statementMessage(s),
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}
