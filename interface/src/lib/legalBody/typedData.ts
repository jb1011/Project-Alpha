/**
 * The two typed data a person signs in the legal-body flow, checked field by field before a wallet
 * opens, and the form wagmi signs.
 *
 * The link binds an identity to its legal body; the statement of authority declares the company
 * behind it. The API serves both, and both are refused here unless every field is the one the
 * person chose: the deployment, the wallet in session, the identity, the agreement read, the
 * company, number and declarant typed, and a time inside its window. A refusal names the first rule
 * broken; a screen stops on it and never opens the wallet or shows a copy box.
 *
 * The served value is read as untrusted JSON: a wrong shape is a refusal, never a throw.
 *
 * The converters translate a served form the checks accepted into wagmi's typed form and construct
 * nothing: a wallet that signs the converted form signs the served form's digest, which a test
 * checks for both.
 */
import type {
  Address,
  CustomerStatementInput,
  Hex,
  LegalBodyAgreement,
  LegalBodyConfig,
  LegalBodyOrderView,
  LinkMessageResult,
  LinkTypedDataWire,
  StatementMessageAnswer,
  StatementTypedDataWire,
} from "@/lib/api/types";
import { EIP712_DOMAIN_FIELDS, LINK_FIELDS } from "@/lib/api/types";
import type { Refusal } from "./chain";
import { sameAddress } from "./flow";

// ---------------------------------------------------------------------------------------------
// The pinned values
// ---------------------------------------------------------------------------------------------

export const LINK_DOMAIN_NAME = "Novi LegalBodyFactory";
export const STATEMENT_DOMAIN_NAME = "Novi Corpus Statement of Authority";
/** Both domains' version. */
const DOMAIN_VERSION = "1";

/** The nine fields of the `StatementOfAuthority` type string, in its order. */
export const STATEMENT_FIELDS = [
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

/** At submit the link must still have this long left by the chain's clock; the backend refuses
 *  less. */
export const MIN_LINK_REMAINING_SECONDS = 300;
/** Room for this browser's clock against the chain's or the server's. */
export const CLOCK_SKEW_SECONDS = 120;
/** The server refuses a statement issued longer ago than this, by its own clock. */
export const STATEMENT_MAX_AGE_SECONDS = 600;
/** The server refuses a statement issued further ahead of its own clock than this. */
export const STATEMENT_MAX_AHEAD_SECONDS = 60;

const TYPED_DATA_KEYS = ["domain", "types", "primaryType", "message"] as const;
const DOMAIN_KEYS = ["name", "version", "chainId", "verifyingContract"] as const;
const FIELD_KEYS = ["name", "type"] as const;
/** A uint256 in decimal as the backend writes it: no sign, no leading zero, at most 78 digits. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** The plain spaces at either end, and runs of them. */
const SPACES_AT_THE_ENDS = /^ +| +$/g;
const SPACE_RUNS = / {2,}/g;

/**
 * The backend's normalisation of a declared text: NFC, trimmed, runs of U+0020 collapsed.
 *
 * Only U+0020 is trimmed and collapsed, as the backend does: it refuses any other space or control
 * character instead of cleaning it, so none of them reaches a served statement.
 */
export function normaliseDeclaredText(s: string): string {
  return s.normalize("NFC").replace(SPACES_AT_THE_ENDS, "").replace(SPACE_RUNS, " ");
}

// ---------------------------------------------------------------------------------------------
// The shared checks
// ---------------------------------------------------------------------------------------------

type Field = { readonly name: string; readonly type: string };
type Loose = Record<string, unknown>;

const refuse = (problem: string): Refusal => ({ ok: false, problem });

function isRecord(v: unknown): v is Loose {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An object with exactly these own keys, in any order. */
function hasExactKeys(v: unknown, keys: readonly string[]): v is Loose {
  if (!isRecord(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** Exactly these fields, by name and type and in this order, each `{ name, type }` and no more. */
function hasFields(v: unknown, pinned: readonly Field[]): boolean {
  return (
    Array.isArray(v) &&
    v.length === pinned.length &&
    v.every(
      (f: unknown, i) =>
        hasExactKeys(f, FIELD_KEYS) && f.name === pinned[i].name && f.type === pinned[i].type,
    )
  );
}

function isCanonical(v: unknown): v is string {
  return typeof v === "string" && CANONICAL_DECIMAL.test(v);
}

/** Two hex values equal in any case. */
const sameHex = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The checks both typed data share, in their order: the primary type; the keys of the typed data,
 * of its types and of its domain; the two field lists; the domain's name, version, chain and
 * verifying contract; the message's keys. Returns the domain and the message to check further.
 */
function checkShape(
  td: unknown,
  pin: {
    primaryType: string;
    fields: readonly Field[];
    fieldsProblem: string;
    domainName: string;
    chainId: number;
    factory: Address;
  },
): { ok: true; message: Loose } | Refusal {
  if (!isRecord(td) || td.primaryType !== pin.primaryType) return refuse("primary_type");
  if (!hasExactKeys(td, TYPED_DATA_KEYS)) return refuse("typed_data_keys");
  const types = td.types;
  if (!hasExactKeys(types, ["EIP712Domain", pin.primaryType])) return refuse("types_keys");
  if (!hasFields(types[pin.primaryType], pin.fields)) return refuse(pin.fieldsProblem);
  if (!hasFields(types.EIP712Domain, EIP712_DOMAIN_FIELDS)) return refuse("domain_fields");
  const d = td.domain;
  if (!hasExactKeys(d, DOMAIN_KEYS)) return refuse("domain_keys");
  if (d.name !== pin.domainName || d.version !== DOMAIN_VERSION) return refuse("domain_name");
  if (d.chainId !== pin.chainId) return refuse("domain_chain");
  if (typeof d.verifyingContract !== "string" || !sameAddress(d.verifyingContract, pin.factory))
    return refuse("domain_factory");
  const m = td.message;
  if (!hasExactKeys(m, pin.fields.map((f) => f.name))) return refuse("message_keys");
  return { ok: true, message: m };
}

// ---------------------------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------------------------

/**
 * The link typed data, checked against the selected order, the agreement the person read, the
 * identity they picked and the wallet in session, before a wallet opens or a copy box shows it.
 *
 * `served.deadline` is counted from the chain's clock and `nowSeconds` is this browser's: the
 * deadline must leave at least `MIN_LINK_REMAINING_SECONDS`, and no more than the served ceiling
 * plus `CLOCK_SKEW_SECONDS`.
 */
export function assertLinkTypedData(
  served: LinkMessageResult,
  ctx: {
    order: LegalBodyOrderView;
    agreement: Pick<LegalBodyAgreement, "manifestHash">;
    sessionAddress: Address;
    /** The identity the person picked. */
    agentId: string;
    nowSeconds: number;
    /** `/config.legalBodies.linkTtl.max`. */
    linkTtlMax: number;
  },
): { ok: true } | Refusal {
  const shape = checkShape(served?.typedData, {
    primaryType: "LegalBodyLink",
    fields: LINK_FIELDS,
    fieldsProblem: "link_fields",
    domainName: LINK_DOMAIN_NAME,
    chainId: ctx.order.chainId,
    factory: ctx.order.factory,
  });
  if (!shape.ok) return shape;
  const m = shape.message;

  if (!isCanonical(m.agentId) || m.agentId !== ctx.agentId) return refuse("agent_id");
  if (typeof m.guardian !== "string" || !sameAddress(m.guardian, ctx.sessionAddress))
    return refuse("guardian");
  const hash = m.operatingAgreementHash;
  const frozen = ctx.order.agreement;
  if (
    typeof hash !== "string" ||
    !BYTES32.test(hash) ||
    !sameHex(hash, ctx.agreement.manifestHash) ||
    (frozen && !sameHex(hash, frozen.hash))
  )
    return refuse("agreement_hash");
  if (!isCanonical(m.amendmentDelay) || m.amendmentDelay !== String(ctx.order.amendmentDelay))
    return refuse("amendment_delay");
  if (
    !isCanonical(m.deadline) ||
    !Number.isSafeInteger(served.deadline) ||
    m.deadline !== String(served.deadline)
  )
    return refuse("deadline");
  // Written so that a clock that cannot be read (NaN) refuses.
  const left = served.deadline - ctx.nowSeconds;
  if (!(left >= MIN_LINK_REMAINING_SECONDS && left <= ctx.linkTtlMax + CLOCK_SKEW_SECONDS))
    return refuse("deadline_window");
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The statement of authority
// ---------------------------------------------------------------------------------------------

/**
 * The statement of authority, checked against the deployment `/config` names, the wallet in
 * session and what the person typed, before the wallet prompt.
 *
 * `issuedAt` is counted from the server's clock and `nowSeconds` is this browser's: it passes from
 * `STATEMENT_MAX_AHEAD_SECONDS + CLOCK_SKEW_SECONDS` ahead of this clock to
 * `STATEMENT_MAX_AGE_SECONDS` behind it, both edges included.
 */
export function assertStatementTypedData(
  served: StatementMessageAnswer,
  ctx: {
    config: Pick<Extract<LegalBodyConfig, { available: true }>, "chainId" | "factory">;
    sessionAddress: Address;
    typed: CustomerStatementInput;
    nowSeconds: number;
  },
): { ok: true } | Refusal {
  const shape = checkShape(served?.typedData, {
    primaryType: "StatementOfAuthority",
    fields: STATEMENT_FIELDS,
    fieldsProblem: "statement_fields",
    domainName: STATEMENT_DOMAIN_NAME,
    chainId: ctx.config.chainId,
    factory: ctx.config.factory,
  });
  if (!shape.ok) return shape;
  const m = shape.message;

  const guardian = m.guardian;
  if (typeof guardian !== "string" || !sameAddress(guardian, ctx.sessionAddress))
    return refuse("guardian");
  const companyName = normaliseDeclaredText(ctx.typed.companyName);
  if (m.companyName !== companyName) return refuse("company_name");
  const filingNumber = normaliseDeclaredText(ctx.typed.filingNumber);
  if (m.filingNumber !== filingNumber) return refuse("filing_number");
  // The declarant is typed on production only; a sandbox serves its fixed one. Text either way.
  const { declarantName, declarantTitle } = ctx.typed;
  if (
    typeof m.declarantName !== "string" ||
    (declarantName !== undefined && m.declarantName !== normaliseDeclaredText(declarantName))
  )
    return refuse("declarant_name");
  if (
    typeof m.declarantTitle !== "string" ||
    (declarantTitle !== undefined && m.declarantTitle !== normaliseDeclaredText(declarantTitle))
  )
    return refuse("declarant_title");
  if (m.jurisdiction !== "WY") return refuse("jurisdiction");
  if (typeof m.wordingVersion !== "string" || m.wordingVersion !== served.wordingVersion)
    return refuse("wording_version");
  // The sentence carries what it is about: the company and the number between double quotes, as
  // the wording renders them, and the guardian's address.
  // The address is matched as the message spells it: the server renders that exact string into
  // the sentence, and the session was already compared with `sameAddress` above.
  const sentence = m.statement;
  if (
    typeof sentence !== "string" ||
    !sentence.includes(`"${companyName}"`) ||
    !sentence.includes(`"${filingNumber}"`) ||
    !sentence.includes(guardian)
  )
    return refuse("sentence");
  if (!isCanonical(m.issuedAt)) return refuse("issued_at_window");
  // Written so that a clock that cannot be read (NaN) refuses.
  const age = ctx.nowSeconds - Number(m.issuedAt);
  if (
    !(
      age >= -(STATEMENT_MAX_AHEAD_SECONDS + CLOCK_SKEW_SECONDS) &&
      age <= STATEMENT_MAX_AGE_SECONDS
    )
  )
    return refuse("issued_at_window");
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The form wagmi signs
// ---------------------------------------------------------------------------------------------

type WagmiDomain = { name: string; version: string; chainId: number; verifyingContract: Address };

/** The link as wagmi's `signTypedDataAsync` types it. */
export type WagmiLinkTypedData = {
  domain: WagmiDomain;
  types: { LegalBodyLink: typeof LINK_FIELDS };
  primaryType: "LegalBodyLink";
  message: {
    agentId: bigint;
    guardian: Address;
    amendmentDelay: bigint;
    operatingAgreementHash: Hex;
    deadline: bigint;
  };
};

/** The statement of authority as wagmi's `signTypedDataAsync` types it. */
export type WagmiStatementTypedData = {
  domain: WagmiDomain;
  types: { StatementOfAuthority: typeof STATEMENT_FIELDS };
  primaryType: "StatementOfAuthority";
  message: {
    statement: string;
    declarantName: string;
    declarantTitle: string;
    companyName: string;
    jurisdiction: "WY";
    filingNumber: string;
    guardian: Address;
    wordingVersion: string;
    issuedAt: bigint;
  };
};

/** The domain's four fields, copied. */
const copyDomain = (d: WagmiDomain): WagmiDomain => ({
  name: d.name,
  version: d.version,
  chainId: d.chainId,
  verifyingContract: d.verifyingContract,
});

/**
 * The link in the form wagmi signs: a translation, never a construction. The domain's four fields
 * are copied; `types` leaves `EIP712Domain` out, since viem derives the same four from the domain
 * and a declared one would make wagmi type the domain as unknowns; the three uint256 strings
 * become bigints; every other field is copied. The field list is the pinned one, which the check
 * has already found equal to the served one. Call it only on a link `assertLinkTypedData`
 * accepted.
 */
export function toWagmiLinkTypedData(td: LinkTypedDataWire): WagmiLinkTypedData {
  return {
    domain: copyDomain(td.domain),
    types: { LegalBodyLink: LINK_FIELDS },
    primaryType: "LegalBodyLink",
    message: {
      agentId: BigInt(td.message.agentId),
      guardian: td.message.guardian,
      amendmentDelay: BigInt(td.message.amendmentDelay),
      operatingAgreementHash: td.message.operatingAgreementHash,
      deadline: BigInt(td.message.deadline),
    },
  };
}

/**
 * The statement of authority in the form wagmi signs, translated as the link is: `issuedAt`
 * becomes a bigint and the eight other fields are copied by name. Call it only on a statement
 * `assertStatementTypedData` accepted.
 */
export function toWagmiStatementTypedData(td: StatementTypedDataWire): WagmiStatementTypedData {
  const m = td.message;
  return {
    domain: copyDomain(td.domain),
    types: { StatementOfAuthority: STATEMENT_FIELDS },
    primaryType: "StatementOfAuthority",
    message: {
      statement: m.statement,
      declarantName: m.declarantName,
      declarantTitle: m.declarantTitle,
      companyName: m.companyName,
      jurisdiction: m.jurisdiction,
      filingNumber: m.filingNumber,
      guardian: m.guardian,
      wordingVersion: m.wordingVersion,
      issuedAt: BigInt(m.issuedAt),
    },
  };
}
