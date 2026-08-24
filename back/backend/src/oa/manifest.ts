import { type Hex, keccak256 } from "viem";
import type { DoolaEnvironment } from "../adapters/doola/types";
import type { AgentSpec } from "../policy/agentSpec";
import type { TranslateResult } from "../policy/translator";
import { computeOaHash } from "./generator";

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

/** The canonical bytes, as UTF-8 — what gets written to disk AND what gets hashed. */
export function serializeManifestBytes(manifest: Canonicalizable): Buffer {
  return Buffer.from(serializeManifest(manifest), "utf8");
}

/**
 * The on-chain anchor: keccak256 over the canonical UTF-8 BYTES.
 *
 * It takes bytes, not a manifest, on purpose. The caller has to write those exact bytes to disk
 * anyway, and a signature that took the object invited serializing twice — once to hash, once to
 * store — with nothing but discipline keeping the two results identical. One serialization, one
 * buffer, hashed and stored: "the file on disk re-hashes to the anchor" stops being a property
 * that has to be tested and becomes one that cannot be violated.
 *
 * (Hashing the bytes directly also drops a UTF-8 -> hex -> bytes round trip that existed only to
 * satisfy the old signature.)
 */
export function manifestHash(bytes: Uint8Array): Hex {
  return keccak256(bytes);
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
  /** The terms doc the caller ALREADY rendered and is about to store. Passed in rather than
   *  re-rendered here: a second render is a second chance for the stored document and the
   *  document this manifest commits to to differ (a scheme flag, a spec mutation, a future
   *  render option), and the whole value of `terms.hash` is that they cannot. */
  termsDoc: string,
): OaBundleManifest {
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

// ── v2+ : folding the legal facts in ────────────────────────────────────────────────────────

/** A manifest that cannot be built (or a stored one that cannot be trusted). Distinct from
 *  `JcsError`, which is about SERIALIZATION: this one is about the schema's own rules. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * The on-chain identity, REQUIRED from v2 onward.
 *
 * v1 left all three null and documented why: the proxy and the agentId are minted by the very
 * `createEntity` call v1's hash is an argument to, so at v1 they do not exist yet. Every later
 * version is built AFTER that receipt, so there is no honest reason for them to be absent — and
 * they are what give the manifest its domain separation (audit M9): a manifest naming this chain,
 * this LegalManager and this agentId cannot be replayed as another entity's amendment.
 */
export interface ManifestChainRef {
  chainId: number;
  /** The entity's LegalManager proxy — the contract that holds the anchor. */
  legalManager: string;
  /** The ERC-8004 agentId, as a decimal string (it is a uint256; JSON numbers cannot hold it). */
  agentId: string;
}

/**
 * Build v(n) for n ≥ 2 from the last ANCHORED manifest.
 *
 * The previous manifest is passed as a whole DOCUMENT rather than as a hash, and that is the
 * point of the signature: `previous` is computed HERE, from the bytes of the document that is
 * actually on the chain, so the chain of manifests cannot be forged by a caller passing a hash
 * that belongs to nothing. Pass the anchored one — never a `vetoed` or `superseded` version
 * (design §4, M9): those never entered the chain, and a `previous` pointing at one would make the
 * published history unverifiable at exactly the point a guardian intervened.
 *
 * What carries forward verbatim, and why:
 *  - `entity` — already NFC-normalized at v1; re-normalizing a value that is already canonical is
 *    a second chance to produce different bytes for the same entity;
 *  - `terms` — the terms-doc versioning rule (§4). A v2/v3 that only folds in legal facts changes
 *    exactly ONE hash, the manifest's own; `terms.uri` keeps pointing at v1 until a TERM changes.
 *
 * The `legal` block is normalized (below) rather than trusted verbatim, because its document list
 * is assembled from a database query whose row order is not part of the schema's meaning — and
 * JCS preserves array order, so an unsorted list would hash differently for identical facts.
 */
export function buildManifestNext(
  prevAnchoredManifest: OaBundleManifest,
  version: number,
  chain: ManifestChainRef,
  legal: ManifestLegal,
): OaBundleManifest {
  if (!Number.isInteger(version) || version < 2)
    throw new ManifestError(`manifest version must be an integer ≥ 2 (got ${version})`);
  if (version <= prevAnchoredManifest.version)
    throw new ManifestError(
      `manifest v${version} does not advance the anchored v${prevAnchoredManifest.version} — anchoring is strictly monotonic (design §7)`,
    );
  if (chain.chainId !== prevAnchoredManifest.chain.chainId)
    throw new ManifestError(
      `manifest chainId ${chain.chainId} differs from the anchored manifest's ${prevAnchoredManifest.chain.chainId} — an entity does not move between chains`,
    );
  if (!chain.legalManager || !chain.agentId)
    throw new ManifestError(
      "manifest v2+ requires chain.legalManager and chain.agentId — they are null only at v1, before createEntity has minted them",
    );

  return {
    schema: OA_MANIFEST_SCHEMA_V1,
    chain: { chainId: chain.chainId, legalManager: chain.legalManager, agentId: chain.agentId },
    entity: { ...prevAnchoredManifest.entity },
    version,
    // Computed from the previous document's own canonical bytes — see the doc comment.
    previous: manifestHash(serializeManifestBytes(prevAnchoredManifest)),
    terms: { ...prevAnchoredManifest.terms },
    legal: normalizeLegal(legal),
  };
}

/**
 * Canonicalize the legal block so identical FACTS always produce identical BYTES.
 *
 * Two things are load-bearing:
 *  - the document list is SORTED (type, then sha256, then name). It arrives from a SQL query, and
 *    "ORDER BY created_at" is not a fact about the entity — but JCS preserves array order, so two
 *    runs that fetched the same documents in a different order would anchor different hashes and
 *    the second would look like a material change;
 *  - `environment` is asserted present. The honesty invariant (§2) is meant to be mechanical, and
 *    a manifest is the one artifact a verifier holds forever: a sandbox filing that lost its label
 *    on the way to the anchor is indistinguishable from a real one.
 */
function normalizeLegal(l: ManifestLegal): ManifestLegal {
  if (!l.environment)
    throw new ManifestError(
      "manifest legal.environment is required — a sandbox filing must never be able to render as a real one by omission (design §2)",
    );
  if (!l.provider) throw new ManifestError("manifest legal.provider is required");
  if (!l.providerCompanyId)
    throw new ManifestError("manifest legal.providerCompanyId is required from v2");
  if (!Number.isInteger(l.formationDate) || l.formationDate < 0)
    throw new ManifestError(
      `manifest legal.formationDate must be a non-negative integer of unix SECONDS (got ${l.formationDate})`,
    );
  if (l.documents.length === 0)
    throw new ManifestError(
      "manifest legal.documents is empty — the whole point of v2 is that it commits to the filed documents",
    );
  for (const d of l.documents)
    if (!d.type || !d.sha256)
      throw new ManifestError(
        `manifest legal.documents carries an entry with no ${d.type ? "sha256" : "type"} — a hash nobody can check is worse than no hash`,
      );

  return {
    provider: l.provider,
    environment: l.environment,
    providerCompanyId: l.providerCompanyId,
    entityType: l.entityType,
    state: l.state,
    formationDate: l.formationDate,
    filingNumber: l.filingNumber,
    ein: l.ein,
    documents: l.documents
      .map((d) => ({
        type: d.type,
        // sha256 is hex: case is not information, and doola has been seen to report both.
        sha256: d.sha256.toLowerCase(),
        // Provider-supplied free text — the same NFC discipline the entity name gets.
        name: d.name.normalize("NFC"),
      }))
      .sort(
        (a, b) =>
          a.type.localeCompare(b.type, "en") ||
          a.sha256.localeCompare(b.sha256, "en") ||
          a.name.localeCompare(b.name, "en"),
      ),
  };
}

/**
 * Read a manifest back from the bytes we stored, and REFUSE anything that is not canonical.
 *
 * The round-trip check is the whole value of this function. A manifest read off disk is about to
 * become the `previous` link of the next version — its hash is computed from ITS canonical bytes,
 * so a file that has been reformatted, re-indented, or hand-edited would silently produce a
 * `previous` that points at nothing on the chain. Failing loudly here turns a permanently
 * unverifiable chain of manifests into a parked anchor cycle and an ops line.
 */
export function parseManifest(bytes: Uint8Array): OaBundleManifest {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new ManifestError(`stored manifest is not JSON: ${(e as Error).message}`);
  }
  const m = value as Partial<OaBundleManifest>;
  if (
    !m ||
    typeof m !== "object" ||
    typeof m.schema !== "string" ||
    typeof m.version !== "number" ||
    typeof m.chain !== "object" ||
    typeof m.entity !== "object" ||
    typeof m.terms !== "object"
  )
    throw new ManifestError("stored manifest does not have the OA bundle shape");
  if (m.schema !== OA_MANIFEST_SCHEMA_V1)
    throw new ManifestError(
      `stored manifest declares schema "${m.schema}", which this build cannot extend (expected "${OA_MANIFEST_SCHEMA_V1}")`,
    );
  const manifest = value as OaBundleManifest;
  if (Buffer.compare(serializeManifestBytes(manifest), Buffer.from(bytes)) !== 0)
    throw new ManifestError(
      "stored manifest is not in canonical (JCS) form — refusing to build on bytes whose keccak is not the anchor",
    );
  return manifest;
}

/** Terms-doc file name for a manifest-scheme entity. */
export function termsDocName(entityKey: string, version: number): string {
  return `oa-${entityKey}-v${version}.md`;
}

/** Manifest file name. Stored beside the terms doc it commits to. */
export function manifestDocName(entityKey: string, version: number): string {
  return `manifest-${entityKey}-v${version}.json`;
}
