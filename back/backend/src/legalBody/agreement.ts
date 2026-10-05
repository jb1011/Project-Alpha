import { type Hex, getAddress, keccak256 } from "viem";
import { computeOaHash } from "../oa/generator";
import { manifestHash, serializeManifestBytes } from "../oa/manifest";
import { opsLog } from "../observability/opsLog";
import type { DocumentStore } from "../persistence/documentStore";
import type { Address } from "../types";
import type { LegalText, LegalTextStatus } from "./texts/index";
import type { AgreementFields } from "./texts/operatingAgreement";

/**
 * An order's agreement: the operating-agreement text, and the manifest whose hash the identity
 * owner's link signs and the legal body records.
 *
 * The manifest is canonical JSON (RFC 8785, one trailing newline) and commits to the chain, the
 * guardian, the amendment delay, the kind of company, and the text by id, version, status and
 * hash. It holds no company name, no filing number and no agentId: the name is committed through
 * the terms hash, so the manifest itself can be published without naming anyone.
 *
 * One buffer is built, hashed and written: the file on disk is the bytes the hash was taken over.
 */

export const LEGAL_BODY_MANIFEST_SCHEMA = "novi.legal-body-manifest/1";

/** A type alias, not an interface: the canonical serialiser takes a JSON value, which only an
 *  alias proves structurally. */
export type LegalBodyManifest = {
  schema: typeof LEGAL_BODY_MANIFEST_SCHEMA;
  version: 1;
  chain: { chainId: number; factory: Address; identityRegistry: Address };
  guardian: Address;
  /** Seconds. */
  amendmentDelay: number;
  company: { source: "customer"; jurisdiction: "WY"; entityType: "LLC" };
  /** `hash` is keccak256 of the terms document's UTF-8 bytes (`computeOaHash`). */
  terms: { textId: string; textVersion: string; textStatus: LegalTextStatus; hash: Hex };
};

export interface BuiltAgreement {
  /** The rendered text, in Unicode NFC: the exact text stored and hashed. */
  termsDoc: string;
  /** `manifestBytes` decoded as UTF-8, trailing newline included. */
  manifest: string;
  manifestBytes: Buffer;
  /** keccak256 of `manifestBytes`: what the link carries. */
  manifestHash: Hex;
  version: 1;
}

const AGREEMENT_VERSION = 1;

/**
 * Builds the terms document and its manifest from one set of fields.
 *
 * Addresses are written in their checksummed form, in the text and in the manifest, so that the
 * same address in another letter case gives the same agreement (and an address that is not one
 * throws). The rendered text is stored in NFC, the form `computeOaHash` hashes, so the stored
 * bytes are the hashed bytes.
 */
export function buildAgreement(
  fields: AgreementFields,
  text: LegalText<AgreementFields>,
): BuiltAgreement {
  const guardian = getAddress(fields.guardian);
  const factory = getAddress(fields.factory);
  const identityRegistry = getAddress(fields.identityRegistry);
  const termsDoc = text.render({ ...fields, guardian, factory, identityRegistry }).normalize("NFC");
  const manifest: LegalBodyManifest = {
    schema: LEGAL_BODY_MANIFEST_SCHEMA,
    version: AGREEMENT_VERSION,
    chain: { chainId: fields.chainId, factory, identityRegistry },
    guardian,
    amendmentDelay: fields.amendmentDelaySeconds,
    company: { source: "customer", jurisdiction: fields.jurisdiction, entityType: "LLC" },
    terms: {
      textId: text.id,
      textVersion: text.version,
      textStatus: text.status,
      hash: computeOaHash(termsDoc),
    },
  };
  const manifestBytes = serializeManifestBytes(manifest);
  return {
    termsDoc,
    manifest: manifestBytes.toString("utf8"),
    manifestBytes,
    manifestHash: manifestHash(manifestBytes),
    version: AGREEMENT_VERSION,
  };
}

/** The two file names of an order's agreement, version 1. */
export function agreementDocNames(legalBodyId: string): { terms: string; manifest: string } {
  return {
    terms: `legal-body-terms-${legalBodyId}-v${AGREEMENT_VERSION}.md`,
    manifest: `legal-body-manifest-${legalBodyId}-v${AGREEMENT_VERSION}.json`,
  };
}

/**
 * Writes the terms, then the manifest that commits to them. Both writes are synchronous, and the
 * manifest's buffer is the one its hash was taken over.
 */
export function storeAgreement(
  docStore: DocumentStore,
  legalBodyId: string,
  a: BuiltAgreement,
): void {
  const names = agreementDocNames(legalBodyId);
  docStore.put(names.terms, a.termsDoc);
  docStore.putBytes(names.manifest, a.manifestBytes);
}

type Unverifiable = "unreadable" | "manifest_rehash" | "manifest_shape" | "terms_rehash";

const HASH = /^0x[0-9a-f]{64}$/;

/**
 * The stored agreement, if the manifest still hashes to `expected` AND the terms still hash to
 * the manifest's `terms.hash`; otherwise undefined.
 *
 * Both checks are over the stored BYTES: keccak256 of the manifest file against `expected`, and
 * keccak256 of the terms file against `terms.hash`. A file that is missing or cannot be read, a
 * manifest that does not re-hash, and terms that do not re-hash each answer undefined, after one
 * error-level line that names the order and a fixed reason, and nothing the files hold.
 */
export function readVerifiedAgreement(
  docStore: DocumentStore,
  legalBodyId: string,
  expected: Hex,
):
  | {
      termsDoc: string;
      manifest: string;
      manifestBytes: Buffer;
      terms: { textId: string; textVersion: string; textStatus: LegalTextStatus };
    }
  | undefined {
  const fail = (reason: Unverifiable): undefined => {
    opsLog("legal_body_agreement_unverifiable", { level: "error", legalBodyId, reason });
    return undefined;
  };
  const names = agreementDocNames(legalBodyId);
  let manifestBytes: Buffer;
  let termsBytes: Buffer;
  try {
    manifestBytes = docStore.getBytes(names.manifest);
    termsBytes = docStore.getBytes(names.terms);
  } catch {
    // The store's error names a path; the line says only that a file could not be read.
    return fail("unreadable");
  }

  // A hash's letter case is not information.
  if (manifestHash(manifestBytes) !== expected.toLowerCase()) return fail("manifest_rehash");

  const manifest = manifestBytes.toString("utf8");
  const terms = readTerms(manifest);
  if (terms === undefined) return fail("manifest_shape");

  // The stored bytes, not a normalised reading of them: the terms are stored in NFC, so their
  // keccak256 is the `computeOaHash` the manifest committed to.
  if (keccak256(termsBytes) !== terms.hash) return fail("terms_rehash");

  return {
    termsDoc: termsBytes.toString("utf8"),
    manifest,
    manifestBytes,
    terms: { textId: terms.textId, textVersion: terms.textVersion, textStatus: terms.textStatus },
  };
}

/** The manifest's `terms` block, if the manifest is one of ours and the block has its shape. */
function readTerms(manifest: string): LegalBodyManifest["terms"] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(manifest);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const m = value as { schema?: unknown; terms?: unknown };
  if (m.schema !== LEGAL_BODY_MANIFEST_SCHEMA) return undefined;
  if (typeof m.terms !== "object" || m.terms === null) return undefined;
  const t = m.terms as Record<string, unknown>;
  if (typeof t.textId !== "string" || typeof t.textVersion !== "string") return undefined;
  if (t.textStatus !== "draft" && t.textStatus !== "approved") return undefined;
  if (typeof t.hash !== "string" || !HASH.test(t.hash)) return undefined;
  return {
    textId: t.textId,
    textVersion: t.textVersion,
    textStatus: t.textStatus,
    hash: t.hash as Hex,
  };
}
