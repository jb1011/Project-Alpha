import { createHash } from "node:crypto";
import { type Address, getAddress, keccak256, toHex } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type BuiltAgreement,
  LEGAL_BODY_MANIFEST_SCHEMA,
  agreementDocNames,
  buildAgreement,
  readVerifiedAgreement,
  storeAgreement,
} from "../../src/legalBody/agreement";
import {
  type AgreementFields,
  LEGAL_BODY_OPERATING_AGREEMENT,
  LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS,
} from "../../src/legalBody/texts/operatingAgreement";
import { computeOaHash } from "../../src/oa/generator";
import { canonicalizeJcs, manifestHash } from "../../src/oa/manifest";
import { MemoryDocumentStore } from "../helpers/formationFakes";

/** Invented company values, and addresses derived from anvil's published test keys only. */
const GUARDIAN = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const FACTORY = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const REGISTRY = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const OTHER = getAddress("0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0");

const FIELDS: AgreementFields = {
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
  jurisdiction: "WY",
  guardian: GUARDIAN,
  amendmentDelaySeconds: 172_800,
  chainId: 31_337,
  factory: FACTORY,
  identityRegistry: REGISTRY,
};

const LEGAL_BODY_ID = "lb_00000000-0000-4000-8000-000000000001";

/**
 * The sha256 of every version's template. A changed text is a NEW version: add its line here and
 * its entry at the end of LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS. Never change or remove a line
 * that exists: a stored agreement names the version it was made under.
 */
const TEMPLATE_SHA256_BY_VERSION: Readonly<Record<string, string>> = {
  "2026-10-draft-1": "d704c1217852432680e7b7b1ed63c6485956bec7dccc502b4b4bd34d92c93f20",
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const build = (fields: AgreementFields = FIELDS): BuiltAgreement =>
  buildAgreement(fields, LEGAL_BODY_OPERATING_AGREEMENT);

let logLines: string[] = [];
beforeEach(() => {
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── the text ────────────────────────────────────────────────────────────────────────────────

test("the operating agreement is a draft under its own id", () => {
  expect(LEGAL_BODY_OPERATING_AGREEMENT.id).toBe("legal-body-operating-agreement");
  expect(LEGAL_BODY_OPERATING_AGREEMENT.version).toBe("2026-10-draft-1");
  expect(LEGAL_BODY_OPERATING_AGREEMENT.status).toBe("draft");
});

test("the text names the company, makes the guardian its Manager, and holds no treasury", () => {
  const doc = LEGAL_BODY_OPERATING_AGREEMENT.render(FIELDS);
  expect(doc).toContain('"Example Holdings LLC"');
  expect(doc).toContain('filing number "TEST-0001"');
  expect(doc).toContain("Wyoming limited liability company");
  expect(doc).toContain(`wallet ${GUARDIAN}`);
  expect(doc).toContain("Manager");
  expect(doc).toContain(`factory contract at ${FACTORY}`);
  expect(doc).toContain(`identity registry at ${REGISTRY}`);
  expect(doc).toMatch(/no treasury and no spending policy/);
  expect(doc).toMatch(/amendment delay/);
  // Every placeholder was filled, and the document ends with one newline.
  expect(doc).not.toMatch(/\{[A-Za-z][A-Za-z0-9]*\}/);
  expect(doc.endsWith("\n")).toBe(true);
  expect(doc.endsWith("\n\n")).toBe(false);
});

test("each version's template is pinned by its sha256, and no version leaves the module", () => {
  for (const text of LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS) {
    expect(text.id).toBe("legal-body-operating-agreement");
    expect(
      sha256(text.template),
      `The template of version "${text.version}" changed. A changed text is a new version: restore this one, add the new text as a new entry at the end of LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS, and pin its hash in TEMPLATE_SHA256_BY_VERSION.`,
    ).toBe(TEMPLATE_SHA256_BY_VERSION[text.version]);
  }
  // Every pinned version is still in the module, in order, and none is listed twice.
  expect(LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS.map((t) => t.version)).toEqual(
    Object.keys(TEMPLATE_SHA256_BY_VERSION),
  );
  // New agreements are made under the newest version.
  expect(LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS.at(-1)).toBe(LEGAL_BODY_OPERATING_AGREEMENT);
});

test("a field that holds a placeholder is not substituted again", () => {
  const plain = LEGAL_BODY_OPERATING_AGREEMENT.render(FIELDS);
  const guardianTimes = plain.split(GUARDIAN).length - 1;
  expect(guardianTimes).toBeGreaterThan(0);

  const doc = LEGAL_BODY_OPERATING_AGREEMENT.render({
    ...FIELDS,
    companyName: "{guardian}",
    filingNumber: "{factory}",
  });
  expect(doc).toContain('"{guardian}"');
  expect(doc).toContain('filing number "{factory}"');
  // The wallet and the factory appear only in their own places.
  expect(doc.split(GUARDIAN).length - 1).toBe(guardianTimes);
  expect(doc.split(FACTORY).length - 1).toBe(plain.split(FACTORY).length - 1);

  // The same holds through the build: the stored terms keep the placeholder as text.
  const built = build({ ...FIELDS, companyName: "{guardian}" });
  expect(built.termsDoc).toContain('"{guardian}"');
  expect(built.termsDoc.split(GUARDIAN).length - 1).toBe(guardianTimes);
});

// ── the manifest ────────────────────────────────────────────────────────────────────────────

test("the same fields give the same bytes and hash; any changed field changes the hash", () => {
  const a = build();
  const b = build({ ...FIELDS });
  expect(a.version).toBe(1);
  expect(b.termsDoc).toBe(a.termsDoc);
  expect(Buffer.compare(b.manifestBytes, a.manifestBytes)).toBe(0);
  expect(b.manifest).toBe(a.manifest);
  expect(b.manifestHash).toBe(a.manifestHash);

  const changed: Record<keyof AgreementFields, AgreementFields> = {
    companyName: { ...FIELDS, companyName: "Example Holdings Two LLC" },
    filingNumber: { ...FIELDS, filingNumber: "TEST-0002" },
    jurisdiction: { ...FIELDS, jurisdiction: "DE" as "WY" },
    guardian: { ...FIELDS, guardian: OTHER },
    amendmentDelaySeconds: { ...FIELDS, amendmentDelaySeconds: 172_801 },
    chainId: { ...FIELDS, chainId: 31_338 },
    factory: { ...FIELDS, factory: OTHER },
    identityRegistry: { ...FIELDS, identityRegistry: OTHER },
  };
  const hashes = new Set([a.manifestHash]);
  for (const [field, fields] of Object.entries(changed)) {
    const h = build(fields).manifestHash;
    expect(h, `changing ${field} must change the hash`).not.toBe(a.manifestHash);
    hashes.add(h);
  }
  expect(hashes.size).toBe(Object.keys(changed).length + 1);
});

test("an address's letter case is not information: it gives the same agreement", () => {
  const lower = build({
    ...FIELDS,
    guardian: GUARDIAN.toLowerCase() as Address,
    factory: FACTORY.toLowerCase() as Address,
    identityRegistry: REGISTRY.toLowerCase() as Address,
  });
  const a = build();
  expect(lower.termsDoc).toBe(a.termsDoc);
  expect(lower.manifestHash).toBe(a.manifestHash);
});

test("the manifest parses back as canonical JSON with exactly the listed keys and no company name", () => {
  const a = build();
  // The string is the bytes, decoded, trailing newline included.
  expect(a.manifest).toBe(a.manifestBytes.toString("utf8"));
  expect(a.manifest.endsWith("}\n")).toBe(true);

  const parsed = JSON.parse(a.manifest);
  expect(`${canonicalizeJcs(parsed)}\n`).toBe(a.manifest);
  expect(parsed).toEqual({
    schema: LEGAL_BODY_MANIFEST_SCHEMA,
    version: 1,
    chain: { chainId: 31_337, factory: FACTORY, identityRegistry: REGISTRY },
    guardian: GUARDIAN,
    amendmentDelay: 172_800,
    company: { source: "customer", jurisdiction: "WY", entityType: "LLC" },
    terms: {
      textId: "legal-body-operating-agreement",
      textVersion: "2026-10-draft-1",
      textStatus: "draft",
      hash: computeOaHash(a.termsDoc),
    },
  });
  expect(LEGAL_BODY_MANIFEST_SCHEMA).toBe("novi.legal-body-manifest/1");
  // Exactly these keys at every level: `toEqual` would let an undefined-valued key through.
  expect(Object.keys(parsed).sort()).toEqual(
    ["amendmentDelay", "chain", "company", "guardian", "schema", "terms", "version"].sort(),
  );
  expect(Object.keys(parsed.chain).sort()).toEqual(["chainId", "factory", "identityRegistry"]);
  expect(Object.keys(parsed.company).sort()).toEqual(["entityType", "jurisdiction", "source"]);
  expect(Object.keys(parsed.terms).sort()).toEqual(["hash", "textId", "textStatus", "textVersion"]);

  // No name, no filing number, no agentId: the name is committed through the terms hash.
  expect(a.manifest).not.toContain("Example Holdings");
  expect(a.manifest).not.toContain("TEST-0001");
  expect(a.manifest).not.toMatch(/agentId/i);
  expect(a.termsDoc).toContain("Example Holdings LLC");
});

test("the hash is keccak256 of the manifest bytes, trailing newline included", () => {
  const a = build();
  expect(a.manifestHash).toBe(manifestHash(a.manifestBytes));
  expect(a.manifestHash).toBe(keccak256(toHex(a.manifest)));
  // Without its newline the string does not hash to the anchor.
  expect(keccak256(toHex(a.manifest.slice(0, -1)))).not.toBe(a.manifestHash);
  // The terms hash is over the stored terms bytes.
  expect(keccak256(Buffer.from(a.termsDoc, "utf8"))).toBe(computeOaHash(a.termsDoc));
});

test("the manifest carries the status of the text it was built from", () => {
  const approved = { ...LEGAL_BODY_OPERATING_AGREEMENT, status: "approved" as const };
  const a = buildAgreement(FIELDS, approved);
  expect(JSON.parse(a.manifest).terms.textStatus).toBe("approved");
  // The approved copy renders the same text, so only the status moves the hash.
  expect(a.termsDoc).toBe(build().termsDoc);
  expect(a.manifestHash).not.toBe(build().manifestHash);
});

// ── storing and reading back ────────────────────────────────────────────────────────────────

test("the files are named by the order id and version 1", () => {
  expect(agreementDocNames(LEGAL_BODY_ID)).toEqual({
    terms: `legal-body-terms-${LEGAL_BODY_ID}-v1.md`,
    manifest: `legal-body-manifest-${LEGAL_BODY_ID}-v1.json`,
  });
});

test("storeAgreement then readVerifiedAgreement round-trips", () => {
  const store = new MemoryDocumentStore();
  const a = build();
  storeAgreement(store, LEGAL_BODY_ID, a);

  const names = agreementDocNames(LEGAL_BODY_ID);
  // The buffer that was hashed is the buffer that was written.
  expect(Buffer.compare(store.getBytes(names.manifest), a.manifestBytes)).toBe(0);
  expect(store.get(names.terms)).toBe(a.termsDoc);

  const back = readVerifiedAgreement(store, LEGAL_BODY_ID, a.manifestHash);
  expect(back).toBeDefined();
  expect(back?.termsDoc).toBe(a.termsDoc);
  expect(back?.manifest).toBe(a.manifest);
  expect(Buffer.compare(back?.manifestBytes ?? Buffer.alloc(0), a.manifestBytes)).toBe(0);
  expect(back?.terms).toEqual({
    textId: "legal-body-operating-agreement",
    textVersion: "2026-10-draft-1",
    textStatus: "draft",
  });
  // A hash written in upper case is the same hash.
  expect(
    readVerifiedAgreement(store, LEGAL_BODY_ID, `0x${a.manifestHash.slice(2).toUpperCase()}`),
  ).toBeDefined();
  expect(logLines).toEqual([]);
});

/** The error lines written while reading: exactly one, naming the order and nothing it holds. */
function expectOneErrorLine(a: BuiltAgreement, reason: string): void {
  expect(logLines).toHaveLength(1);
  const line = logLines[0] ?? "";
  const entry = JSON.parse(line);
  expect(entry.level).toBe("error");
  expect(entry.legalBodyId).toBe(LEGAL_BODY_ID);
  expect(entry.reason).toBe(reason);
  expect(line).not.toContain("Example Holdings");
  expect(line).not.toContain("TEST-0001");
  expect(line).not.toContain(GUARDIAN);
  expect(line).not.toContain(a.manifestHash);
  expect(line).not.toContain("Manager");
}

function flipByte(store: MemoryDocumentStore, name: string, at: number): void {
  const bytes = Buffer.from(store.getBytes(name));
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  store.files.set(name, bytes);
}

test("a flipped byte in the stored manifest reads back as nothing", () => {
  const store = new MemoryDocumentStore();
  const a = build();
  storeAgreement(store, LEGAL_BODY_ID, a);
  flipByte(store, agreementDocNames(LEGAL_BODY_ID).manifest, 10);
  expect(readVerifiedAgreement(store, LEGAL_BODY_ID, a.manifestHash)).toBeUndefined();
  expectOneErrorLine(a, "manifest_rehash");
});

test("a flipped byte in the stored terms reads back as nothing", () => {
  const store = new MemoryDocumentStore();
  const a = build();
  storeAgreement(store, LEGAL_BODY_ID, a);
  const name = agreementDocNames(LEGAL_BODY_ID).terms;
  flipByte(store, name, a.termsDoc.indexOf("Example Holdings"));
  expect(readVerifiedAgreement(store, LEGAL_BODY_ID, a.manifestHash)).toBeUndefined();
  expectOneErrorLine(a, "terms_rehash");
});

test("a missing terms file or a missing manifest reads back as nothing", () => {
  const a = build();
  for (const missing of ["terms", "manifest"] as const) {
    logLines = [];
    const store = new MemoryDocumentStore();
    storeAgreement(store, LEGAL_BODY_ID, a);
    store.files.delete(agreementDocNames(LEGAL_BODY_ID)[missing]);
    expect(readVerifiedAgreement(store, LEGAL_BODY_ID, a.manifestHash), missing).toBeUndefined();
    expectOneErrorLine(a, "unreadable");
  }
  // Nothing stored at all.
  logLines = [];
  expect(
    readVerifiedAgreement(new MemoryDocumentStore(), LEGAL_BODY_ID, a.manifestHash),
  ).toBeUndefined();
  expectOneErrorLine(a, "unreadable");
});

test("a wrong expected hash reads back as nothing", () => {
  const store = new MemoryDocumentStore();
  const a = build();
  storeAgreement(store, LEGAL_BODY_ID, a);
  const other = build({ ...FIELDS, chainId: 31_338 });
  expect(readVerifiedAgreement(store, LEGAL_BODY_ID, other.manifestHash)).toBeUndefined();
  expectOneErrorLine(a, "manifest_rehash");
});
