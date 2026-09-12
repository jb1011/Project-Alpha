/**
 * HCS-14 Universal Agent ID (UAID) derivation for this entity's Hedera identity (design D10).
 *
 * COPIED, NOT IMPORTED. The canonicalization (`canonicalizeAgentData`), the DID param-string
 * builder (`buildParamString`), and the CAIP-10 guards below are copied line for line from
 * `@hashgraphonline/standards-sdk@0.1.186`'s `src/hcs-14/canonical.ts`, `src/hcs-14/did.ts`, and
 * `src/hcs-14/caip.ts`. That package publishes only a bundled build (numbered chunk files, no
 * per-module `.js` under `dist/`); the original TypeScript was recovered from those chunks'
 * sourcemaps (`dist/es/standards-sdk.es55.js.map`, `.es56.js.map`, `.es57.js.map` carry
 * `sourcesContent`), not by importing the package. It is copied rather than imported because the
 * SDK depends on `@hashgraph/sdk` — a second, full Hedera consensus-node SDK stack — to support
 * client features (transaction building, live DID resolution) this server never uses; the server
 * only ever computes a hash and a string (design D24, `src/hedera/keyDecode.ts` explains the same
 * policy for the mirror node's key format). @noble/hashes and @scure/base are the two primitives
 * the copied logic actually needs.
 *
 * Deviations from the original, and why:
 *  - `canonicalizeAgentData` here takes `CanonicalAgentData` directly, not `unknown`, and skips the
 *    SDK's zod `.parse(input)` at the top: our caller already hands us a typed, constructed object
 *    (`uaidInputsFor`), so there is nothing left to validate at runtime. Everything after that line
 *    — the protocol guards, the normalization, the key order, the JSON — is unchanged.
 *  - `nativeId` is only trimmed here, never lowercased, exactly like the SDK. A caller that needs a
 *    lowercased `nativeId` (we do) must lowercase it before calling this function; `uaidInputsFor`
 *    does that when it builds the CAIP-10 string, not this function.
 *  - `deriveUaid` is synchronous. The SDK's `createUaid` is async because its crypto adapter also
 *    supports a browser `SubtleCrypto` path; this server only ever runs in Node, so the digest is
 *    computed with `@noble/hashes/sha2`'s synchronous `sha384` and there is nothing to await.
 *  - `deriveUaid`'s `params` is `{ uid: string }` only, not the SDK's full `DidRoutingParams`. Our
 *    protocol is always `"mcp"` (D10), so `proto` is read from `input.protocol` (post-canonicalize)
 *    rather than required as a second caller-supplied argument; `domain` and `src` are routing
 *    params for DID-based (not AID-based) UAIDs, which this entity never produces.
 *
 * Golden vector (task 9, pinned 2026-09-10): see `test/hedera/uaid.test.ts`.
 */
import { sha384 } from "@noble/hashes/sha2";
import { base58 } from "@scure/base";
import type { EntityRecord } from "../types";

/** Mirrors the SDK's zod-inferred `CanonicalAgentData` shape (see the file comment on why this is
 * a plain interface here instead). */
export interface CanonicalAgentData {
  registry: string;
  name: string;
  version: string;
  protocol: string;
  nativeId: string;
  skills: number[];
}

export interface CanonicalizationResult {
  normalized: CanonicalAgentData;
  canonicalJson: string;
}

// ---- copied from the SDK's src/hcs-14/caip.ts (only the two guards canonical.ts calls) ----
const CAIP10_HEDERA_REGEX =
  /^hedera:(mainnet|testnet|previewnet|devnet):\d+\.\d+\.\d+(?:-[a-zA-Z0-9]{5})?$/;
function isHederaCaip10(value: string): boolean {
  return CAIP10_HEDERA_REGEX.test(value);
}
const EIP155_REGEX = /^eip155:(\d+):(0x[0-9a-fA-F]{39,40})$/;
function isEip155Caip10(value: string): boolean {
  return EIP155_REGEX.test(value);
}

// ---- copied from the SDK's src/hcs-14/canonical.ts ----
function normalizeString(value: string): string {
  return value.trim();
}
function normalizeLower(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalizes agent data into the exact shape and key order HCS-14 hashes, and returns that JSON
 * string alongside the normalized fields. See the file comment for the one deviation (no zod
 * parse) from the SDK's `canonical.ts`.
 */
export function canonicalizeAgentData(input: CanonicalAgentData): CanonicalizationResult {
  if (input.protocol.trim().toLowerCase() === "hcs-10") {
    if (!isHederaCaip10(input.nativeId.trim())) {
      throw new Error(
        "HCS-14: For protocol hcs-10, nativeId must be CAIP-10 (hedera:<network>:<account>)",
      );
    }
  }
  const protocol = input.protocol.trim().toLowerCase();
  if (protocol === "acp-virtuals") {
    if (!isEip155Caip10(input.nativeId.trim())) {
      throw new Error(
        "HCS-14: For protocol acp-virtuals, nativeId must be EIP-155 CAIP-10 (eip155:<chainId>:<address>)",
      );
    }
  }

  const normalized: CanonicalAgentData = {
    registry: normalizeLower(input.registry),
    name: normalizeString(input.name),
    version: normalizeString(input.version),
    protocol: normalizeLower(input.protocol),
    nativeId: normalizeString(input.nativeId),
    skills: [...input.skills].sort((a, b) => a - b),
  };

  const orderedKeys = ["skills", "name", "nativeId", "protocol", "registry", "version"] as const;
  const canonicalObject: Record<string, unknown> = {};
  for (const key of orderedKeys) canonicalObject[key] = normalized[key];

  const canonicalJson = JSON.stringify(canonicalObject);
  return { normalized, canonicalJson };
}

// ---- copied from the SDK's src/hcs-14/did.ts, `buildParamString` (trimmed to the params this
// entity ever sets: `domain` and `src` are for DID-based UAIDs, which D10 never produces) ----
function buildParamString(params: {
  uid?: string;
  registry?: string;
  proto?: string;
  nativeId?: string;
}): string {
  const entries: Array<[string, string]> = [];
  if (params.uid) entries.push(["uid", params.uid]);
  if (params.registry) entries.push(["registry", params.registry]);
  if (params.proto) entries.push(["proto", params.proto]);
  if (params.nativeId) entries.push(["nativeId", params.nativeId]);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${v}`).join(";");
}

/**
 * Derives a `uaid:aid:...` UAID: canonicalize the input, SHA-384 the canonical JSON, Base58 the
 * digest, and append the routing params in `uid, registry, proto, nativeId` order (the SDK's fixed
 * `buildParamString` order). See the file comment for why this is synchronous and why `proto`
 * comes from `input.protocol` instead of `params`.
 */
export function deriveUaid(input: CanonicalAgentData, params: { uid: string }): string {
  const { normalized, canonicalJson } = canonicalizeAgentData(input);
  const digest = sha384(Buffer.from(canonicalJson, "utf8"));
  const id = base58.encode(digest);
  const paramString = buildParamString({
    uid: params.uid,
    registry: normalized.registry,
    proto: normalized.protocol,
    nativeId: normalized.nativeId,
  });
  return paramString ? `uaid:aid:${id};${paramString}` : `uaid:aid:${id}`;
}

/**
 * Builds this entity's HCS-14 input (design D10): registry `"novicorpus"`, `version: "1"`,
 * `protocol: "mcp"`, no skills yet, and `nativeId` as `eip155:<chainId>:<treasury, lowercased>`.
 * `nativeId` is lowercased here — not by `canonicalizeAgentData`, which only trims it, mirroring
 * the SDK exactly (see the file comment).
 */
export function uaidInputsFor(entity: EntityRecord, chainId: number): CanonicalAgentData {
  if (!entity.treasury) {
    throw new Error(`uaidInputsFor: entity "${entity.name}" has no treasury address yet`);
  }
  return {
    registry: "novicorpus",
    name: entity.name,
    version: "1",
    protocol: "mcp",
    nativeId: `eip155:${chainId}:${entity.treasury.toLowerCase()}`,
    skills: [],
  };
}

/**
 * Extracts the CAIP-10 `nativeId` routing param from a `uaid:aid:...` UAID produced by
 * `deriveUaid`. Returns null for anything else: a UAID with no `nativeId` param, or a string that
 * is not a `uaid:aid:` UAID at all.
 */
export function parseUaidNativeId(uaid: string): string | null {
  if (!uaid.startsWith("uaid:aid:")) return null;
  const semi = uaid.indexOf(";");
  if (semi < 0) return null;
  for (const pair of uaid.slice(semi + 1).split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === "nativeId") return pair.slice(eq + 1);
  }
  return null;
}
