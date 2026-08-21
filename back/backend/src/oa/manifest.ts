import { type Hex, keccak256, toHex } from "viem";
import type { DoolaEnvironment } from "../adapters/doola/types";
import type { AgentSpec } from "../policy/agentSpec";
import type { TranslateResult } from "../policy/translator";
import { computeOaHash, renderOperatingAgreement } from "./generator";

/**
 * The OA bundle manifest (design 2026-08-19 §4) — the B+ core.
 *
 * ONE canonical JSON document commits to everything a verifier needs: the machine-readable terms
 * doc, every legal document's hash, the legal facts, and the on-chain identity. Its keccak256 IS
 * the on-chain anchor, from birth (v1 at `createEntity`) onward.
 *
 * Canonicalization is RFC 8785 (JCS), NOT "sorted keys" prose. The distinction matters because
 * the anchor has to be recomputable by SOMEONE ELSE: a JS round-trip only proves our serializer
 * agrees with itself, so the golden vectors in the tests are written out by hand, byte for byte.
 *
 * Hash functions are mixed DELIBERATELY and documented for verifiers:
 *   keccak256 — the manifest anchor and `terms.hash` (EVM-native, what the chain compares);
 *   sha256    — document bytes (PDF-ecosystem-native, what doola and every PDF tool report).
 */

// ── RFC 8785 (JCS) ──────────────────────────────────────────────────────────────────────────

/** The value shapes a manifest can hold. Floats are absent BY CONSTRUCTION — see below. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JcsError";
  }
}

/**
 * Serialize `value` to RFC 8785 canonical JSON.
 *
 * The rules that actually bite, and how each is met:
 *  - **Object keys sort by UTF-16 code unit**, which is exactly what JS's default string sort
 *    does. (Sorting by code POINT would order astral keys differently — a real cross-
 *    implementation divergence, so this is not an accident of convenience.)
 *  - **Numbers: integers only.** JCS's number rule is ECMAScript's `Number::toString`, whose
 *    float output (`1e+21`, `5e-324`) no other language reproduces casually. Rather than
 *    implement that, we REFUSE non-integers: nothing in this schema is fractional (chain ids,
 *    versions, unix seconds), so a float here means a bug upstream, and a silent
 *    mis-serialization would be an unverifiable anchor. Values beyond `MAX_SAFE_INTEGER` are
 *    refused for the same reason — their decimal form is not faithfully recoverable.
 *  - **Strings**: `JSON.stringify` implements RFC 8259's escaping with the shortest escapes,
 *    which is what JCS specifies; astral characters stay literal (UTF-8 at encode time).
 *  - **No whitespace anywhere**, and array order is preserved verbatim.
 *  - `undefined` is refused rather than dropped: a key that vanishes silently changes the hash.
 */
export function canonicalizeJcs(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new JcsError(`JCS: ${String(value)} is not a serializable JSON number`);
    if (!Number.isInteger(value))
      throw new JcsError(
        `JCS: ${value} is not an integer — this schema is integers-only so the canonical form is reproducible outside JavaScript`,
      );
    if (!Number.isSafeInteger(value))
      throw new JcsError(`JCS: ${value} exceeds the safe-integer range and cannot round-trip`);
    // -0 renders as "0" under Number::toString, which is what JCS requires.
    return String(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJcs).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(); // default sort == UTF-16 code-unit order
    const parts = keys.map((k) => {
      const v = (value as Record<string, JsonValue>)[k];
      if (v === undefined)
        throw new JcsError(
          `JCS: key "${k}" is undefined — an omitted key silently changes the anchor, so it must be an explicit null`,
        );
      return `${JSON.stringify(k)}:${canonicalizeJcs(v)}`;
    });
    return `{${parts.join(",")}}`;
  }
  throw new JcsError(`JCS: unsupported value of type ${typeof value}`);
}

/** Anything the manifest schema can hold. `OaBundleManifest` IS a JsonValue by construction —
 *  it just lacks the index signature TypeScript needs to prove it structurally. */
type Canonicalizable = JsonValue | OaBundleManifest;

/** Canonical bytes as stored on disk and hashed: JCS + exactly ONE trailing newline. */
export function serializeManifest(manifest: Canonicalizable): string {
  return `${canonicalizeJcs(manifest as JsonValue)}\n`;
}

/** The on-chain anchor: keccak256 over the canonical UTF-8 bytes (trailing newline included). */
export function manifestHash(manifest: Canonicalizable): Hex {
  return keccak256(toHex(serializeManifest(manifest)));
}

// ── The v1 schema ───────────────────────────────────────────────────────────────────────────

export const OA_MANIFEST_SCHEMA_V1 = "novi/oa-bundle/1";
export const OA_MANIFEST_VERSION_V1 = 1;

/** Legal facts, folded in from v2 onward. `environment` is REQUIRED by the schema — the honesty
 *  invariant is mechanical: a sandbox filing cannot be rendered as a real one by omission. */
export interface ManifestLegal {
  provider: string;
  environment: DoolaEnvironment;
  providerCompanyId: string;
  entityType: string;
  state: string;
  formationDate: number;
  filingNumber: string;
  ein: string | null;
  documents: { type: string; sha256: string; name: string }[];
}

export interface OaBundleManifest {
  schema: string;
  chain: {
    chainId: number;
    /** The LegalManager proxy. NULL at v1 — the proxy does not exist until `createEntity`
     *  returns, and v1 IS the value passed INTO that call. v2+ fills it. */
    legalManager: string | null;
    /** Likewise: the agentId is minted by the very tx this hash is an argument to. */
    agentId: string | null;
  };
  entity: { name: string; jurisdiction: string; publicId: string };
  version: number;
  /** The last ANCHORED hash. Null at v1. Vetoed/superseded versions never enter this chain. */
  previous: string | null;
  terms: { hash: string; uri: string };
  /** Null at v1: nothing has been filed yet. */
  legal: ManifestLegal | null;
}

export interface ManifestChainMeta {
  /** Real chain id from config — domain separation, so a manifest cannot be replayed across
   *  networks (audit M9). */
  chainId: number;
  /** The entity's idempotency key; names the terms doc (`oa-<key>-v1.md`). */
  entityKey: string;
}

/**
 * Build the v1 manifest for a brand-new entity.
 *
 * v1 is the pre-formation snapshot: `legal` is null (nothing filed), `previous` is null (nothing
 * anchored before it), and `chain.legalManager`/`chain.agentId` are null because BOTH are minted
 * by the same `createEntity` call this manifest's hash is an argument to. They are explicit nulls
 * rather than absent keys so the schema shape — and therefore the canonical byte layout — is the
 * same at every version; v2+ fills them from the confirmed receipt.
 *
 * Strings that reach the hash are NFC-normalized here, for the reason `computeOaHash` documents:
 * `name`/`jurisdiction` are user-supplied free text that could otherwise arrive decomposed and
 * hash differently for a visually identical entity. Normalizing at BUILD time (not inside the
 * JCS serializer, which stays pure per RFC 8785) means the normalized form is what gets stored,
 * so a verifier re-canonicalizing the published manifest reproduces the anchor exactly.
 */
export function buildManifestV1(
  spec: AgentSpec,
  r: TranslateResult,
  publicId: string,
  chain: ManifestChainMeta,
): OaBundleManifest {
  const termsDoc = renderOperatingAgreement(spec, r, { scheme: "manifest" });
  return {
    schema: OA_MANIFEST_SCHEMA_V1,
    chain: { chainId: chain.chainId, legalManager: null, agentId: null },
    entity: {
      name: spec.name.normalize("NFC"),
      jurisdiction: spec.jurisdiction.normalize("NFC"),
      publicId,
    },
    version: OA_MANIFEST_VERSION_V1,
    previous: null,
    terms: {
      hash: computeOaHash(termsDoc),
      // `novi:doc:` is our own resolution scheme; PR 2 serves these bytes over an authenticated
      // route. The name is VERSIONED because a terms change mints a new terms doc, while a v2/v3
      // that only folds in legal facts leaves `terms.uri` pointing at v1.
      uri: `novi:doc:${termsDocName(chain.entityKey, OA_MANIFEST_VERSION_V1)}`,
    },
    legal: null,
  };
}

/** Terms-doc file name for a manifest-scheme entity. */
export function termsDocName(entityKey: string, version: number): string {
  return `oa-${entityKey}-v${version}.md`;
}

/** Manifest file name. Stored beside the terms doc it commits to. */
export function manifestDocName(entityKey: string, version: number): string {
  return `manifest-${entityKey}-v${version}.json`;
}
