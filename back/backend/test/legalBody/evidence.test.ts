/**
 * A customer's evidence uploads: the PDFs a tenant sends for the operator to check its declaration
 * against. An upload is accepted only when it is not empty, not over the size cap, hashes to the
 * value the tenant named and starts with the five bytes every PDF starts with; a company holds a
 * bounded number of them; their bytes are deleted once the expiry rule allows, while their rows and
 * hashes stay; and none of them ever reaches an anchored manifest.
 *
 * Every company here is an invention.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { type Hex, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_CONCURRENT,
  EVIDENCE_MAX_PRESENT_PER_COMPANY,
  EVIDENCE_MAX_ROWS_PER_COMPANY,
  EVIDENCE_RETENTION_SECONDS,
  type EvidenceDeps,
  type EvidenceKind,
  acceptEvidence,
  expireEvidenceBytes,
} from "../../src/legalBody/evidence";
import { CUSTOMER_PROVIDER } from "../../src/legalBody/provider";
import {
  buildManifestV1,
  manifestDocName,
  manifestHash,
  parseManifest,
  serializeManifestBytes,
} from "../../src/oa/manifest";
import {
  type CompanyCheckResult,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentIndexId,
} from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteOaAnchorRepository } from "../../src/persistence/oaAnchorRepository";
import { parseAgentSpec } from "../../src/policy/agentSpec";
import { translate } from "../../src/policy/translator";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import {
  type AnchorLoopDeps,
  advanceAnchor,
  deriveLegalBlock,
  newAnchorReadCache,
} from "../../src/workflow/anchorLoop";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import {
  COMPANY_ID,
  COMPANY_KEY,
  ENTITY_KEY,
  fakeAnchorChain,
  formedEntity,
  seedCompany,
} from "../helpers/formationFakes";

const TENANT = getAddress("0x00000000000000000000000000000000000000a1");
const DAY = 86_400;

let db: Database.Database;
let documents: SqliteDocumentIndexRepository;
let companies: SqliteCompanyRepository;
let checks: SqliteCompanyCheckRepository;
let docStore: DeletableMemoryDocumentStore;
/** The functions' clock, in milliseconds. It starts at the real time, because an upload's
 *  `created_at` is the database's own clock. */
let nowMs: number;
let logs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  documents = new SqliteDocumentIndexRepository(db);
  companies = new SqliteCompanyRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  docStore = new DeletableMemoryDocumentStore();
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  // An accepted upload writes an ops line: the tests read it here rather than on stdout.
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const nowSeconds = (): number => Math.floor(nowMs / 1000);
const passTime = (seconds: number): void => {
  nowMs += seconds * 1000;
};
const deps = (): EvidenceDeps => ({ documents, docStore, now: () => nowMs });

/** A small PDF, different for every label. Only its first five bytes make it one. */
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF\n`, "latin1");
const sha256Of = (bytes: Uint8Array): Hex =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;

/** A customer company, created as the application creates one. */
function customerCompany(companyId: string): void {
  companies.create({
    companyId,
    tenantId: TENANT,
    status: "draft",
    provider: CUSTOMER_PROVIDER,
    environment: "production",
    synthetic: false,
    nameOptions: [{ name: "Example Holdings LLC", entityTypeEnding: "", position: 1 }],
    businessPurpose: "not applicable: an existing company",
    industryLabel: "not applicable: an existing company",
    intakeSynthesized: false,
  });
}

function accept(companyId: string, kind: EvidenceKind, bytes: Uint8Array, expected?: Hex) {
  return acceptEvidence(deps(), {
    companyId,
    kind,
    expectedSha256: expected ?? sha256Of(bytes),
    bytes,
  });
}

/** An upload that must be accepted, narrowed to its success. */
function accepted(companyId: string, kind: EvidenceKind, bytes: Uint8Array) {
  const result = accept(companyId, kind, bytes);
  if (!result.ok) throw new Error(`the upload was refused: ${result.problem}`);
  return result;
}

const rowsOf = (companyId: string) =>
  documents.listByCompany(companyId).filter((d) => d.source === "customer");

/** Moves every customer upload of a company back in time: the order of an upload and a check is
 *  their `created_at`, at one-second resolution, so a test sets it rather than sleeps. */
function backdateUploads(companyId: string, secondsAgo: number): void {
  db.prepare(
    "UPDATE documents SET created_at = ? WHERE company_id = ? AND source = 'customer'",
  ).run(sqliteUtcTimestamp(Date.now() - secondsAgo * 1000), companyId);
}

/** Appends a check with this result, as the operator records one. */
function check(companyId: string, result: CompanyCheckResult): void {
  const common = {
    companyId,
    result,
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: nowSeconds(),
  };
  checks.append(
    result === "passed"
      ? {
          ...common,
          registryName: "Example Holdings LLC",
          registryFilingId: "TEST-0001",
          registryStatus: "Active",
          formationDate: "2024-02-29",
          registeredAgent: "Example Registered Agent LLC",
          existenceEvidenceSha256: `0x${"e1".repeat(32)}`,
          controlEvidenceSha256: `0x${"c1".repeat(32)}`,
          controlEvidenceKind: "ein_letter",
          reasonCode: null,
          reason: null,
        }
      : {
          ...common,
          registryName: null,
          registryFilingId: null,
          registryStatus: null,
          formationDate: null,
          registeredAgent: null,
          existenceEvidenceSha256: null,
          controlEvidenceSha256: null,
          controlEvidenceKind: null,
          reasonCode: result === "failed" ? "filing_not_found" : null,
          reason: "Recorded for a test.",
        },
  );
}

const opsLines = (event: string): Record<string, unknown>[] =>
  logs.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes(`"opslog":"${event}"`))
    .map((line) => JSON.parse(line));

test("the exact limits: 4 MiB a file, 6 files with their bytes and 24 in all per company, 30 days, 4 at once", () => {
  expect(EVIDENCE_MAX_BYTES).toBe(4 * 1024 * 1024);
  expect(EVIDENCE_MAX_PRESENT_PER_COMPANY).toBe(6);
  expect(EVIDENCE_MAX_ROWS_PER_COMPANY).toBe(24);
  expect(EVIDENCE_RETENTION_SECONDS).toBe(30 * 24 * 3600);
  expect(EVIDENCE_MAX_CONCURRENT).toBe(4);
});

describe("accepting an upload", () => {
  test("a small valid PDF with its own hash is stored: a customer row with the kind in its id, the size, the sha256 and an expiry", () => {
    customerCompany("co_1");
    const bytes = pdf("certificate of good standing");
    const sha256 = sha256Of(bytes);

    const result = accept("co_1", "existence", bytes);

    const providerDocId = `upload:existence:${sha256}`;
    expect(result).toEqual({
      ok: true,
      docId: documentIndexId("co_1", providerDocId),
      sha256,
      size: bytes.length,
      duplicate: false,
    });
    const row = documents.findOwned("co_1", documentIndexId("co_1", providerDocId));
    expect(row).toMatchObject({
      companyId: "co_1",
      source: "customer",
      providerDocId,
      docType: "evidence_existence",
      contentType: "application/pdf",
      size: bytes.length,
      sha256,
      expiresAt: nowSeconds() + EVIDENCE_RETENTION_SECONDS,
      bytesDeletedAt: null,
    });
    // The hash in one spelling: 0x and lower-case hex, as the operator's checks store one.
    expect(row?.sha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(docStore.getBytes(row!.path).equals(bytes)).toBe(true);

    // One ops line: ids, the kind, the size and the flag, nothing else.
    const lines = opsLines("company_evidence_uploaded");
    expect(lines).toHaveLength(1);
    const { at: _at, ...fields } = lines[0]!;
    expect(fields).toEqual({
      opslog: "company_evidence_uploaded",
      companyId: "co_1",
      kind: "existence",
      size: bytes.length,
      duplicate: false,
    });
  });

  test("the expected hash is compared without regard to case", () => {
    customerCompany("co_1");
    const bytes = pdf("articles");
    const upper = `0x${sha256Of(bytes).slice(2).toUpperCase()}` as Hex;
    expect(accept("co_1", "control", bytes, upper)).toMatchObject({
      ok: true,
      sha256: sha256Of(bytes),
    });
  });

  test("the same file and kind again is a duplicate and writes nothing; under the other kind it is a second row", () => {
    customerCompany("co_1");
    const bytes = pdf("letter");
    const first = accepted("co_1", "control", bytes);
    const row = documents.findOwned("co_1", first.docId);

    passTime(DAY);
    const writes = vi.spyOn(docStore, "putBytes");
    expect(accept("co_1", "control", bytes)).toEqual({ ...first, duplicate: true });
    expect(writes).not.toHaveBeenCalled();
    // The row as it was: neither a new expiry nor a new upload time.
    expect(documents.findOwned("co_1", first.docId)).toEqual(row);
    expect(rowsOf("co_1")).toHaveLength(1);
    expect(opsLines("company_evidence_uploaded").map((l) => l.duplicate)).toEqual([false, true]);
    writes.mockRestore();

    const other = accepted("co_1", "existence", bytes);
    expect(other.duplicate).toBe(false);
    expect(other.docId).not.toBe(first.docId);
    expect(other.sha256).toBe(first.sha256);
    expect(
      rowsOf("co_1")
        .map((d) => d.docType)
        .sort(),
    ).toEqual(["evidence_control", "evidence_existence"]);
  });

  test("a body whose hash differs from the expected one is refused with content_mismatch, and nothing is stored", () => {
    customerCompany("co_1");
    const sent = pdf("what the tenant hashed");
    // What arrived: the same opening bytes, something else after them.
    const arrived = pdf("what a proxy delivered");
    expect(accept("co_1", "existence", arrived, sha256Of(sent))).toEqual({
      ok: false,
      problem: "content_mismatch",
    });
    expect(rowsOf("co_1")).toEqual([]);
    expect(docStore.files.size).toBe(0);
    expect(opsLines("company_evidence_uploaded")).toEqual([]);
  });

  test("an empty body, bytes that are not a PDF and a body over the cap are refused, each with its own hash, and nothing is stored", () => {
    customerCompany("co_1");
    expect(accept("co_1", "existence", Buffer.alloc(0))).toEqual({ ok: false, problem: "empty" });
    for (const notPdf of [
      Buffer.from("\x89PNG\r\n\x1a\n not a pdf", "latin1"),
      Buffer.from("PDF-1.7 without its percent sign", "latin1"),
      Buffer.from(" %PDF-1.7 after a space", "latin1"),
      Buffer.from("%PDF", "latin1"),
    ])
      expect(accept("co_1", "existence", notPdf)).toEqual({ ok: false, problem: "not_pdf" });
    const over = Buffer.alloc(EVIDENCE_MAX_BYTES + 1, 0x20);
    over.write("%PDF-", 0, "latin1");
    expect(accept("co_1", "existence", over)).toEqual({ ok: false, problem: "too_large" });

    expect(rowsOf("co_1")).toEqual([]);
    expect(docStore.files.size).toBe(0);

    // At the cap exactly, the file is taken.
    const atCap = over.subarray(0, EVIDENCE_MAX_BYTES);
    expect(accept("co_1", "existence", atCap)).toMatchObject({
      ok: true,
      size: EVIDENCE_MAX_BYTES,
    });
  });

  test("the bytes go to the store before the row: a store that cannot write leaves no row", () => {
    customerCompany("co_1");
    const failing = new DeletableMemoryDocumentStore();
    failing.putBytes = () => {
      throw new Error("the store refused the write");
    };
    const bytes = pdf("articles");
    expect(() =>
      acceptEvidence(
        { documents, docStore: failing, now: () => nowMs },
        { companyId: "co_1", kind: "existence", expectedSha256: sha256Of(bytes), bytes },
      ),
    ).toThrow("the store refused the write");
    expect(rowsOf("co_1")).toEqual([]);
  });
});

describe("the limits per company", () => {
  test("the seventh file with its bytes present is refused; once expiry has deleted the six, it is stored, and one of the six comes back to its own row", () => {
    customerCompany("co_1");
    const six = Array.from({ length: 6 }, (_, i) => pdf(`file ${i}`));
    const ids = six.map((bytes) => accepted("co_1", "existence", bytes).docId);
    const seventh = pdf("file 6");

    expect(accept("co_1", "control", seventh)).toEqual({ ok: false, problem: "too_many" });
    // At the cap, the same file again is still the duplicate it is, not a refusal.
    expect(accept("co_1", "existence", six[0]!)).toMatchObject({ ok: true, duplicate: true });
    expect(rowsOf("co_1")).toHaveLength(6);

    // Checked after the six arrived, and 30 days on: the sweep deletes their bytes.
    backdateUploads("co_1", 40 * DAY);
    check("co_1", "failed");
    passTime(EVIDENCE_RETENTION_SECONDS);
    expect(expireEvidenceBytes(deps(), 50)).toBe(6);

    expect(accept("co_1", "control", seventh)).toMatchObject({ ok: true, duplicate: false });
    const before = documents.findOwned("co_1", ids[0]!)!;
    expect(accept("co_1", "existence", six[0]!)).toEqual({
      ok: true,
      docId: ids[0],
      sha256: sha256Of(six[0]!),
      size: six[0]!.length,
      duplicate: false,
    });
    const after = documents.findOwned("co_1", ids[0]!)!;
    expect(after).toMatchObject({
      bytesDeletedAt: null,
      expiresAt: nowSeconds() + EVIDENCE_RETENTION_SECONDS,
      path: before.path,
    });
    // A new upload, waiting for a check recorded after it.
    expect(after.createdAt! > before.createdAt!).toBe(true);
    expect(docStore.getBytes(after.path).equals(six[0]!)).toBe(true);
    expect(documents.countCustomerUploads("co_1")).toEqual({ present: 2, all: 7 });
  });

  test("at most 24 uploads in all: a deleted one still counts, and one that comes back takes no new row", () => {
    customerCompany("co_1");
    // Recorded first, so it is after every upload below once they are moved back in time.
    check("co_1", "failed");
    let n = 0;
    for (let round = 0; round < 4; round += 1) {
      for (let i = 0; i < EVIDENCE_MAX_PRESENT_PER_COMPANY; i += 1)
        accepted("co_1", "existence", pdf(`file ${n++}`));
      backdateUploads("co_1", 40 * DAY);
      passTime(EVIDENCE_RETENTION_SECONDS);
      expect(expireEvidenceBytes(deps(), 50)).toBe(EVIDENCE_MAX_PRESENT_PER_COMPANY);
    }
    expect(documents.countCustomerUploads("co_1")).toEqual({ present: 0, all: 24 });

    expect(accept("co_1", "existence", pdf(`file ${n}`))).toEqual({
      ok: false,
      problem: "too_many",
    });
    expect(accept("co_1", "existence", pdf("file 0"))).toMatchObject({
      ok: true,
      duplicate: false,
    });
    expect(documents.countCustomerUploads("co_1")).toEqual({ present: 1, all: 24 });
  });
});

describe("expireEvidenceBytes", () => {
  test("deletes on an abandoned company and on a company checked after the upload; keeps an unchecked upload and those of a revoked or a reinstated company", () => {
    const names = ["abandoned", "checked", "unchecked", "revoked", "reinstated"] as const;
    const ids = new Map<string, string>();
    for (const name of names) {
      customerCompany(`co_${name}`);
      ids.set(name, accepted(`co_${name}`, "control", pdf(name)).docId);
      // Every upload arrived before any check below.
      backdateUploads(`co_${name}`, 40 * DAY);
    }
    expect(companies.setStatus("co_abandoned", "draft", "abandoned")).toBe(true);
    check("co_checked", "failed");
    for (const result of ["passed", "revoked"] as const) check("co_revoked", result);
    for (const result of ["passed", "revoked", "reinstated"] as const)
      check("co_reinstated", result);
    // The checked upload's file has gone already: its row is marked all the same.
    const checkedRow = documents.findOwned("co_checked", ids.get("checked")!)!;
    docStore.delete(checkedRow.path);

    // Not yet expired: nothing qualifies.
    passTime(EVIDENCE_RETENTION_SECONDS - 1);
    expect(expireEvidenceBytes(deps(), 50)).toBe(0);

    passTime(1);
    expect(expireEvidenceBytes(deps(), 50)).toBe(2);
    for (const name of names) {
      const row = documents.findOwned(`co_${name}`, ids.get(name)!)!;
      const gone = name === "abandoned" || name === "checked";
      expect(row.bytesDeletedAt, name).toBe(gone ? nowSeconds() : null);
      expect(docStore.files.has(row.path), name).toBe(!gone);
      // The row and its hash stay either way.
      expect(row.sha256, name).toBe(sha256Of(pdf(name)));
    }

    // Run again: nothing left that the rule allows.
    expect(expireEvidenceBytes(deps(), 50)).toBe(0);
  });

  test("takes at most `limit` uploads, the most overdue first", () => {
    customerCompany("co_1");
    const first = accepted("co_1", "existence", pdf("first")).docId;
    passTime(DAY);
    const second = accepted("co_1", "existence", pdf("second")).docId;
    expect(companies.setStatus("co_1", "draft", "abandoned")).toBe(true);
    passTime(EVIDENCE_RETENTION_SECONDS);

    expect(expireEvidenceBytes(deps(), 1)).toBe(1);
    expect(documents.findOwned("co_1", first)?.bytesDeletedAt).not.toBeNull();
    expect(documents.findOwned("co_1", second)?.bytesDeletedAt).toBeNull();
    expect(expireEvidenceBytes(deps(), 1)).toBe(1);
    expect(documents.findOwned("co_1", second)?.bytesDeletedAt).not.toBeNull();
  });

  test("a file that cannot be deleted is left marked present and named in an ops line, and does not hold back the others", () => {
    customerCompany("co_1");
    const stuck = accepted("co_1", "existence", pdf("stuck")).docId;
    passTime(DAY);
    const other = accepted("co_1", "existence", pdf("other")).docId;
    expect(companies.setStatus("co_1", "draft", "abandoned")).toBe(true);
    passTime(EVIDENCE_RETENTION_SECONDS);
    const stuckPath = documents.findOwned("co_1", stuck)!.path;
    const refusing = new DeletableMemoryDocumentStore();
    refusing.delete = (name: string) => {
      if (name === stuckPath) throw new Error("the file is busy");
      docStore.delete(name);
    };

    expect(expireEvidenceBytes({ documents, docStore: refusing, now: () => nowMs }, 50)).toBe(1);
    expect(documents.findOwned("co_1", stuck)?.bytesDeletedAt).toBeNull();
    expect(documents.findOwned("co_1", other)?.bytesDeletedAt).toBe(nowSeconds());
    expect(opsLines("company_evidence_expiry_failed")).toEqual([
      expect.objectContaining({ companyId: "co_1", docId: stuck }),
    ]);

    // The next run, with a store that can delete it, finishes the job.
    expect(expireEvidenceBytes(deps(), 50)).toBe(1);
    expect(documents.findOwned("co_1", stuck)?.bytesDeletedAt).toBe(nowSeconds());
    expect(docStore.files.has(stuckPath)).toBe(false);
  });
});

// ── never anchored ─────────────────────────────────────────────────────────────────────────────

describe("a customer upload is never anchored", () => {
  /** The anchor loop's clock: before the database's, so its settling gate never holds a pass. */
  const ANCHOR_NOW = Date.parse("2026-08-21T12:00:00Z");
  const ANCHOR_CHAIN_ID = 5042002;
  const SPEC = parseAgentSpec({
    name: "Anchor Agent",
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
  });

  test("the anchor loop's document selection takes the provider's documents only, so a manifest never lists an upload", async () => {
    const repo = new SqliteEntityRepository(db);
    const requests = new SqliteFormationRepository(db);
    const chain = fakeAnchorChain({ nowSeconds: Math.floor(ANCHOR_NOW / 1000) });
    const d: AnchorLoopDeps = {
      repo,
      companies,
      requests,
      documents,
      docStore,
      anchors: new SqliteOaAnchorRepository(db),
      arc: chain.chain,
      chainId: ANCHOR_CHAIN_ID,
      environment: "sandbox",
      now: () => ANCHOR_NOW,
    };

    // An entity anchored at v1 on a filed company, its filing confirmed.
    const v1 = buildManifestV1(
      SPEC,
      translate(SPEC, { usdc: "0x3600000000000000000000000000000000000000" }),
      "pub-anchor",
      { chainId: ANCHOR_CHAIN_ID, entityKey: ENTITY_KEY },
      "# Operating Agreement\n",
    );
    const v1Bytes = serializeManifestBytes(v1);
    const v1Hash = manifestHash(v1Bytes);
    docStore.putBytes(manifestDocName(ENTITY_KEY, 1), v1Bytes);
    seedCompany(companies);
    repo.upsert(
      formedEntity({ oaHash: v1Hash, oaManifestVersion: 1, oaManifestAnchoredHash: v1Hash }),
    );
    requests.claimAllSteps(COMPANY_KEY);
    requests.transition(COMPANY_KEY, "create_provider", "pending", "confirmed", {
      providerRef: COMPANY_ID,
    });
    requests.transition(COMPANY_KEY, "await_filing", "pending", "confirmed");
    requests.transition(COMPANY_KEY, "fetch_documents", "pending", "confirmed");
    companies.recordFilingFacts(COMPANY_KEY, { filedAt: 1_755_600_000, filingNumber: "TEST-0002" });
    chain.state.current = v1Hash;

    // An upload in the company's index, and no document from the provider yet: nothing to anchor.
    const upload = accepted(COMPANY_KEY, "existence", pdf("an upload"));
    const entity = () => repo.findByIdempotencyKey(ENTITY_KEY)!;
    expect(deriveLegalBlock(d, entity())).toBeNull();

    for (const [type, sha] of [
      ["ArticlesOfOrganization", "a".repeat(64)],
      ["OperatingAgreement", "b".repeat(64)],
    ] as const)
      documents.insert({
        id: documentIndexId(COMPANY_KEY, type),
        companyId: COMPANY_KEY,
        docType: type,
        sha256: sha,
        contentType: "application/pdf",
        size: 1024,
        providerDocId: type,
        path: `doc-${type}.pdf`,
      });
    expect(documents.listByCompany(COMPANY_KEY).map((r) => r.source)).toContain("customer");

    // Read directly, and through the sweep's per-tick cache: the provider's two documents only.
    expect(deriveLegalBlock(d, entity())?.documents.map((doc) => doc.type)).toEqual([
      "ArticlesOfOrganization",
      "OperatingAgreement",
    ]);
    expect(await advanceAnchor(d, ENTITY_KEY, newAnchorReadCache())).toMatchObject({
      advanced: true,
      version: 2,
      state: "scheduled",
    });
    const v2Bytes = docStore.getBytes(manifestDocName(ENTITY_KEY, 2));
    expect(parseManifest(v2Bytes).legal?.documents.map((doc) => doc.type)).toEqual([
      "ArticlesOfOrganization",
      "OperatingAgreement",
    ]);
    expect(v2Bytes.toString("utf8")).not.toContain(upload.sha256.slice(2));
    expect(v2Bytes.toString("utf8")).not.toContain("evidence_");
  });
});
