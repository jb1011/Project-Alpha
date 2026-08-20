/**
 * OA bundle manifest v1 + RFC 8785 (JCS) canonicalization (design §4).
 *
 * The golden vectors below are written out BY HAND, byte for byte, and were independently
 * verified against a second JCS implementation written in Python from the RFC rules. That is the
 * whole point: a JS round-trip only proves our serializer agrees with itself, while the anchor
 * has to be recomputable by an outsider holding nothing but the chain and the published manifest.
 */
import { keccak256, toHex } from "viem";
import { expect, test } from "vitest";
import { computeOaHash, renderOperatingAgreement } from "../../src/oa/generator";
import {
  JcsError,
  buildManifestV1,
  canonicalizeJcs,
  manifestDocName,
  manifestHash,
  serializeManifest,
  termsDocName,
} from "../../src/oa/manifest";
import { parseAgentSpec } from "../../src/policy/agentSpec";
import { translate } from "../../src/policy/translator";

const USDC = "0x3600000000000000000000000000000000000000" as const;

// ── Golden vector 1: a complete v1 manifest ─────────────────────────────────────────────────

const GOLDEN_MANIFEST = {
  schema: "novi/oa-bundle/1",
  chain: { chainId: 5042002, legalManager: null, agentId: null },
  entity: {
    name: "Golden Agent",
    jurisdiction: "Wyoming-DAO-LLC",
    publicId: "11111111-2222-3333-4444-555555555555",
  },
  version: 1,
  previous: null,
  terms: {
    hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    uri: "novi:doc:oa-golden-key-v1.md",
  },
  legal: null,
};

/** Hand-written canonical form. Keys sorted by UTF-16 code unit at EVERY level, no whitespace,
 *  exactly one trailing newline. 373 UTF-8 bytes. */
const GOLDEN_BYTES =
  '{"chain":{"agentId":null,"chainId":5042002,"legalManager":null},' +
  '"entity":{"jurisdiction":"Wyoming-DAO-LLC","name":"Golden Agent",' +
  '"publicId":"11111111-2222-3333-4444-555555555555"},' +
  '"legal":null,"previous":null,"schema":"novi/oa-bundle/1",' +
  '"terms":{"hash":"0x1111111111111111111111111111111111111111111111111111111111111111",' +
  '"uri":"novi:doc:oa-golden-key-v1.md"},"version":1}\n';

const GOLDEN_HASH = "0x1aedd87173d59c10abcfeb02713e8bdbdf8b00b83e7bcdf1c971bea0eb3e6b6c";

test("GOLDEN: a v1 manifest serializes to exactly these bytes and this anchor", () => {
  expect(serializeManifest(GOLDEN_MANIFEST)).toBe(GOLDEN_BYTES);
  expect(Buffer.byteLength(GOLDEN_BYTES, "utf8")).toBe(373);
  // The anchor, pinned as a literal — if this value ever moves, every entity anchored under the
  // old one becomes unverifiable, so the change has to be a deliberate schema version bump.
  expect(manifestHash(GOLDEN_MANIFEST)).toBe(GOLDEN_HASH);
  // …and the hash is genuinely keccak256 of THOSE bytes, not of whatever our serializer emitted.
  expect(keccak256(toHex(GOLDEN_BYTES))).toBe(GOLDEN_HASH);
});

test("GOLDEN: input key order does not matter — the canonical form is one fixed byte string", () => {
  const shuffled = {
    terms: GOLDEN_MANIFEST.terms,
    legal: null,
    version: 1,
    entity: {
      publicId: GOLDEN_MANIFEST.entity.publicId,
      name: GOLDEN_MANIFEST.entity.name,
      jurisdiction: GOLDEN_MANIFEST.entity.jurisdiction,
    },
    previous: null,
    chain: { legalManager: null, agentId: null, chainId: 5042002 },
    schema: "novi/oa-bundle/1",
  };
  expect(serializeManifest(shuffled)).toBe(GOLDEN_BYTES);
  expect(manifestHash(shuffled)).toBe(GOLDEN_HASH);
});

test("exactly ONE trailing newline, and it is inside the hashed bytes", () => {
  const bytes = serializeManifest(GOLDEN_MANIFEST);
  expect(bytes.endsWith("}\n")).toBe(true);
  expect(bytes.endsWith("}\n\n")).toBe(false);
  expect(canonicalizeJcs(GOLDEN_MANIFEST)).not.toContain("\n"); // the raw JCS carries none
  expect(manifestHash(GOLDEN_MANIFEST)).not.toBe(
    keccak256(toHex(canonicalizeJcs(GOLDEN_MANIFEST))),
  );
});

// ── Golden vector 2: key ordering + unicode escaping ────────────────────────────────────────

test("GOLDEN: keys sort by UTF-16 CODE UNIT, not code point (astral before U+FB33)", () => {
  const value = {
    "€": "Euro Sign",
    "\r": "Carriage Return",
    "\n": "Newline",
    "1": "One",
    ö: "Latin Small Letter O With Diaeresis",
    דּ: "Hebrew Letter Dalet With Dagesh",
    "</script>": "Browser Challenge",
    "\u{1F600}": "astral",
  };
  // U+1F600 is a HIGHER code point than U+FB33, but its first UTF-16 unit is 0xD83D, which is
  // LOWER. A code-point sort would swap the last two entries; RFC 8785 requires this order.
  expect(canonicalizeJcs(value)).toBe(
    '{"\\n":"Newline","\\r":"Carriage Return","1":"One","</script>":"Browser Challenge",' +
      '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","\u{1F600}":"astral",' +
      '"דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
});

test("strings use RFC 8259 SHORTEST escapes; non-ASCII stays literal UTF-8", () => {
  expect(canonicalizeJcs({ a: 'tab\tquote"back\\slash' })).toBe(
    '{"a":"tab\\tquote\\"back\\\\slash"}',
  );
  // Control characters below 0x20 with no short escape use \u00XX, lower-case hex digits.
  expect(canonicalizeJcs({ a: "\u0001" })).toBe('{"a":"\\u0001"}');
  // …but printable non-ASCII is NEVER \u-escaped: JCS hashes the UTF-8 bytes.
  expect(canonicalizeJcs({ a: "café — \u{1F600}" })).toBe('{"a":"café — \u{1F600}"}');
});

// ── Number discipline ───────────────────────────────────────────────────────────────────────

test("non-integer numbers are REFUSED, loudly (the float rule is unimplementable-by-accident)", () => {
  expect(() => canonicalizeJcs({ a: 1.5 })).toThrow(JcsError);
  expect(() => canonicalizeJcs({ a: 1.5 })).toThrow(/is not an integer/);
  expect(() => canonicalizeJcs([0.1])).toThrow(/is not an integer/);
  expect(() => canonicalizeJcs({ a: Number.NaN })).toThrow(/not a serializable JSON number/);
  expect(() => canonicalizeJcs({ a: Number.POSITIVE_INFINITY })).toThrow(
    /not a serializable JSON number/,
  );
  expect(() => canonicalizeJcs({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(/safe-integer range/);
});

test("integers serialize plainly; -0 renders as 0; negatives and zero survive", () => {
  expect(canonicalizeJcs({ a: 0, b: -0, c: -7, d: 5042002, e: 1755600000 })).toBe(
    '{"a":0,"b":0,"c":-7,"d":5042002,"e":1755600000}',
  );
});

test("an undefined value is an ERROR, never a silently dropped key", () => {
  // A dropped key changes the anchor without changing anything a reader can see — the single
  // most dangerous silent failure in a hashing serializer.
  expect(() => canonicalizeJcs({ a: 1, b: undefined } as never)).toThrow(/undefined/);
});

test("nested arrays and empty containers canonicalize without whitespace", () => {
  expect(canonicalizeJcs({ docs: [], meta: {}, list: [1, [2, null], { z: 1, a: 2 }] })).toBe(
    '{"docs":[],"list":[1,[2,null],{"a":2,"z":1}],"meta":{}}',
  );
  // Array order is preserved verbatim — only OBJECT keys sort.
  expect(canonicalizeJcs(["b", "a", "c"])).toBe('["b","a","c"]');
});

// ── buildManifestV1 ─────────────────────────────────────────────────────────────────────────

const SPEC_INPUT = {
  name: "Manifest Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {
    manager: "0x000000000000000000000000000000000000aAaa",
    guardian: "0x000000000000000000000000000000000000bBbb",
    operator: "0x000000000000000000000000000000000000cCcc",
  },
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000dDdd",
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
};
const SPEC = parseAgentSpec(SPEC_INPUT);

test("v1 carries the schema, a REAL chainId, and explicit nulls for what does not exist yet", () => {
  const r = translate(SPEC, { usdc: USDC });
  const m = buildManifestV1(SPEC, r, "pub-1", { chainId: 5042002, entityKey: "ent-1" });
  expect(m.schema).toBe("novi/oa-bundle/1");
  expect(m.version).toBe(1);
  expect(m.chain.chainId).toBe(5042002); // domain separation: no cross-network replay (M9)
  // The proxy and the agentId are minted by the very createEntity call this hash is an argument
  // to, so they CANNOT be known at v1. Explicit nulls, not absent keys — the byte layout has to
  // be the same at every version, and v2+ fills them from the confirmed receipt.
  expect(m.chain.legalManager).toBeNull();
  expect(m.chain.agentId).toBeNull();
  expect(m.previous).toBeNull(); // nothing anchored before v1
  expect(m.legal).toBeNull(); // nothing filed before v1
  expect(m.entity).toEqual({
    name: "Manifest Agent",
    jurisdiction: "Wyoming-DAO-LLC",
    publicId: "pub-1",
  });
  expect(m.terms.uri).toBe("novi:doc:oa-ent-1-v1.md");
});

test("terms.hash is the keccak of the terms doc the saga stores — one function, no drift", () => {
  const r = translate(SPEC, { usdc: USDC });
  const m = buildManifestV1(SPEC, r, "pub-1", { chainId: 5042002, entityKey: "ent-1" });
  const doc = renderOperatingAgreement(SPEC, r, { scheme: "manifest" });
  expect(m.terms.hash).toBe(computeOaHash(doc));
  // The LEGACY doc hashes differently (it carries the EIN line), which is exactly why an entity
  // must never switch schemes mid-flight.
  expect(m.terms.hash).not.toBe(computeOaHash(renderOperatingAgreement(SPEC, r)));
});

test("the same inputs always produce the same anchor (no clock, no randomness)", () => {
  const r = translate(SPEC, { usdc: USDC });
  const a = buildManifestV1(SPEC, r, "pub-1", { chainId: 5042002, entityKey: "ent-1" });
  const b = buildManifestV1(SPEC, r, "pub-1", { chainId: 5042002, entityKey: "ent-1" });
  expect(manifestHash(a)).toBe(manifestHash(b));
  // …and a DIFFERENT chain is a different anchor (M9 again, from the other side).
  const other = buildManifestV1(SPEC, r, "pub-1", { chainId: 1, entityKey: "ent-1" });
  expect(manifestHash(other)).not.toBe(manifestHash(a));
});

test("user-supplied text is NFC-normalized before it reaches the hash", () => {
  // "Cafe" + COMBINING ACUTE (U+0301) vs the precomposed U+00E9: identical to the eye,
  // different bytes — and therefore a different keccak unless we normalize first.
  const decomposed = parseAgentSpec({ ...SPEC_INPUT, name: "Cafe\u0301 Agent" });
  const composed = parseAgentSpec({ ...SPEC_INPUT, name: "Caf\u00e9 Agent" });
  const a = buildManifestV1(decomposed, translate(decomposed, { usdc: USDC }), "p", {
    chainId: 1,
    entityKey: "k",
  });
  const b = buildManifestV1(composed, translate(composed, { usdc: USDC }), "p", {
    chainId: 1,
    entityKey: "k",
  });
  expect(a.entity.name).toBe("Caf\u00e9 Agent");
  expect(manifestHash(a)).toBe(manifestHash(b));
});

test("document names are versioned and stable", () => {
  expect(termsDocName("ent-1", 1)).toBe("oa-ent-1-v1.md");
  expect(manifestDocName("ent-1", 1)).toBe("manifest-ent-1-v1.json");
  expect(manifestDocName("ent-1", 3)).toBe("manifest-ent-1-v3.json");
});

test("the spec REFUSES a caller-supplied EIN — the manifest is the only carrier", () => {
  expect(() => parseAgentSpec({ ...SPEC_INPUT, legal: { ein: "12-3456789" } })).toThrow(
    /legal\.ein is not accepted/,
  );
  // A spec with no legal block, or with only a formation date, is still fine.
  expect(() => parseAgentSpec({ ...SPEC_INPUT, legal: {} })).not.toThrow();
  expect(() =>
    parseAgentSpec({ ...SPEC_INPUT, legal: { formationDate: "2026-08-19" } }),
  ).not.toThrow();
});
