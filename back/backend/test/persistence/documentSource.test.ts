import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { type Hex, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type CompanyCheckResult,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import {
  type CompanyStatus,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate } from "../../src/persistence/db";
import {
  type NewDocumentIndexRecord,
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";

const TENANT = getAddress("0x00000000000000000000000000000000000000a1");
/** The sweep's clock, unix seconds. */
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const RETENTION = 30 * DAY;
/**
 * When an upload below arrives unless a test says otherwise: 40 days ago, so its 30 days are over.
 * Every check a test records is later, because a check takes the database's own clock.
 */
const UPLOADED = NOW - 40 * DAY;
const PDF = Buffer.from("%PDF-1.7\n% a test file\n");
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** A 32-byte value: one byte, written as two hex digits, repeated. */
const H = (byte: string) => `0x${byte.repeat(32)}` as Hex;

let db: Database.Database;
let documents: SqliteDocumentIndexRepository;
let companies: SqliteCompanyRepository;
let checks: SqliteCompanyCheckRepository;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  documents = new SqliteDocumentIndexRepository(db);
  companies = new SqliteCompanyRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
});
afterEach(() => db.close());

/** A customer company, created as the application creates one, then moved to `status`. */
function company(companyId: string, status: CompanyStatus = "draft"): void {
  companies.create({
    companyId,
    tenantId: TENANT,
    status: "draft",
    provider: "customer",
    environment: "sandbox",
    synthetic: false,
    nameOptions: [{ name: "Example Holdings", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "placeholder",
    industryLabel: "placeholder",
    intakeSynthesized: false,
  });
  if (status !== "draft") expect(companies.setStatus(companyId, "draft", status)).toBe(true);
}

/** A document record shaped the way every existing caller writes one: no source, no expiry. */
function providerRecord(companyId: string, providerDocId: string) {
  return {
    id: documentIndexId(companyId, providerDocId),
    companyId,
    docType: "ArticlesOfOrganization",
    sha256: "a".repeat(64),
    contentType: "application/pdf",
    size: 1234,
    providerDocId,
    path: documentStoreName(companyId, "ArticlesOfOrganization", providerDocId),
  };
}

/** Moves a row's `created_at`, which is what orders an upload against a company's checks. */
function setCreatedAt(id: string, seconds: number): void {
  expect(
    db
      .prepare("UPDATE documents SET created_at = ? WHERE id = ?")
      .run(sqliteUtcTimestamp(seconds * 1000), id).changes,
  ).toBe(1);
}

/** A customer's upload: indexed with `source` customer and an expiry 30 days after it arrived. */
function upload(
  companyId: string,
  label: string,
  opts: { uploadedAt?: number; expiresAt?: number | null } = {},
): string {
  const uploadedAt = opts.uploadedAt ?? UPLOADED;
  const providerDocId = `upload-${label}`;
  const rec: NewDocumentIndexRecord = {
    id: documentIndexId(companyId, providerDocId),
    companyId,
    docType: "Evidence",
    sha256: "b".repeat(64),
    contentType: "application/pdf",
    size: PDF.length,
    providerDocId,
    path: documentStoreName(companyId, "Evidence", providerDocId),
    source: "customer",
    expiresAt: opts.expiresAt === undefined ? uploadedAt + RETENTION : opts.expiresAt,
  };
  expect(documents.insert(rec)).toBe(true);
  setCreatedAt(rec.id, uploadedAt);
  return rec.id;
}

/** Appends a check with this result: a passed one carries what the operator found in the
 *  registry, any other one a reason. */
function check(companyId: string, result: CompanyCheckResult): void {
  const common = {
    companyId,
    result,
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: NOW,
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
          existenceEvidenceSha256: H("e1"),
          controlEvidenceSha256: H("c1"),
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

/** The ids the expiry sweep would be handed. */
const expired = (nowSeconds = NOW, limit = 50) =>
  documents.listExpiredCustomerUploads(nowSeconds, limit).map((d) => d.id);

describe("the three columns", () => {
  test("an upgraded database gains them, and a row written before them reads as a provider document", () => {
    for (const column of ["source", "expires_at", "bytes_deleted_at"])
      db.exec(`ALTER TABLE documents DROP COLUMN ${column}`);
    db.prepare(
      `INSERT INTO documents (id, company_id, doc_type, sha256, content_type, size,
                              provider_doc_id, path)
       VALUES ('doc-old', 'co_old', 'ArticlesOfOrganization', ?, 'application/pdf', 1234, 'd1',
               'doc-old.pdf')`,
    ).run("a".repeat(64));

    migrate(db);

    const columns = new Map(
      (
        db.prepare("PRAGMA table_info(documents)").all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }[]
      ).map((c) => [c.name, { type: c.type, notnull: c.notnull, dflt_value: c.dflt_value }]),
    );
    expect(columns.get("source")).toEqual({ type: "TEXT", notnull: 1, dflt_value: "'provider'" });
    expect(columns.get("expires_at")).toEqual({ type: "INTEGER", notnull: 0, dflt_value: null });
    expect(columns.get("bytes_deleted_at")).toEqual({
      type: "INTEGER",
      notnull: 0,
      dflt_value: null,
    });
    expect(
      db
        .prepare("SELECT source, expires_at, bytes_deleted_at FROM documents WHERE id = 'doc-old'")
        .get(),
    ).toEqual({ source: "provider", expires_at: null, bytes_deleted_at: null });
    expect(new SqliteDocumentIndexRepository(db).findOwned("co_old", "doc-old")).toMatchObject({
      source: "provider",
      expiresAt: null,
      bytesDeletedAt: null,
    });
  });

  test("an insert written the way every existing caller writes one stores a provider document", () => {
    const rec = providerRecord("co_1", "d1");
    expect(documents.insert(rec)).toBe(true);
    expect(documents.findOwned("co_1", rec.id)).toEqual({
      ...rec,
      entityKey: null,
      source: "provider",
      expiresAt: null,
      bytesDeletedAt: null,
      createdAt: expect.stringMatching(SQLITE_UTC),
    });
    expect(db.prepare("SELECT source FROM documents WHERE id = ?").get(rec.id)).toEqual({
      source: "provider",
    });
  });

  test("a customer upload stores its source and its expiry, with its bytes present", () => {
    company("co_1");
    const id = upload("co_1", "a", { uploadedAt: NOW });
    expect(documents.findOwned("co_1", id)).toMatchObject({
      source: "customer",
      expiresAt: NOW + RETENTION,
      bytesDeletedAt: null,
    });
  });
});

describe("FileDocumentStore.delete", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docstore-delete-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("removes the file and nothing else", () => {
    const store = new FileDocumentStore(dir);
    store.putBytes("upload-a.pdf", PDF);
    store.putBytes("upload-b.pdf", PDF);
    store.delete("upload-a.pdf");
    expect(existsSync(join(dir, "upload-a.pdf"))).toBe(false);
    expect(() => store.getBytes("upload-a.pdf")).toThrow();
    expect(readdirSync(dir)).toEqual(["upload-b.pdf"]);
  });

  test("tolerates a missing file, whether it never existed or is already gone", () => {
    const store = new FileDocumentStore(dir);
    expect(() => store.delete("never-written.pdf")).not.toThrow();
    store.putBytes("upload-a.pdf", PDF);
    store.delete("upload-a.pdf");
    expect(() => store.delete("upload-a.pdf")).not.toThrow();
  });

  test("refuses a name that escapes the store's directory, and leaves the file outside alone", () => {
    const store = new FileDocumentStore(join(dir, "store"));
    const outside = join(dir, "outside.pdf");
    writeFileSync(outside, PDF);
    expect(() => store.delete("../outside.pdf")).toThrow(/escapes the store root/);
    expect(() => store.delete("nested/../../outside.pdf")).toThrow(/escapes the store root/);
    expect(existsSync(outside)).toBe(true);
  });
});

test("the memory document store for tests deletes the same way", () => {
  const store = new DeletableMemoryDocumentStore();
  store.putBytes("upload-a.pdf", PDF);
  store.delete("upload-a.pdf");
  expect(() => store.getBytes("upload-a.pdf")).toThrow();
  expect(() => store.delete("upload-a.pdf")).not.toThrow();
});

describe("listExpiredCustomerUploads", () => {
  test("an expired upload on an abandoned company qualifies, with no check at all", () => {
    company("co_abandoned", "abandoned");
    const id = upload("co_abandoned", "a");
    expect(expired()).toEqual([id]);
  });

  test("an expired upload qualifies at the first sweep after a check recorded after it, whatever the check found", () => {
    company("co_passed");
    company("co_failed");
    const passed = upload("co_passed", "a");
    const failed = upload("co_failed", "a");
    // 40 days old and never checked: still waiting.
    expect(expired()).toEqual([]);
    check("co_passed", "passed");
    check("co_failed", "failed");
    expect(expired().sort()).toEqual([passed, failed].sort());
  });

  test("an upload never checked, or checked only before it arrived, does not qualify", () => {
    company("co_never");
    upload("co_never", "a");
    company("co_before");
    check("co_before", "passed");
    // Arrives after the check, and is 30 days old by the time the sweep runs.
    upload("co_before", "late", { uploadedAt: NOW + DAY });
    // A check recorded in the same second as the upload is not after it.
    company("co_same_second");
    const same = upload("co_same_second", "a");
    check("co_same_second", "passed");
    const { created_at } = db
      .prepare("SELECT created_at FROM company_checks WHERE company_id = 'co_same_second'")
      .get() as { created_at: string };
    db.prepare("UPDATE documents SET created_at = ? WHERE id = ?").run(created_at, same);
    expect(expired(NOW + 60 * DAY)).toEqual([]);
  });

  test("an upload on a company whose latest check is revoked or reinstated does not qualify", () => {
    company("co_1");
    const id = upload("co_1", "a");
    check("co_1", "passed");
    expect(expired()).toEqual([id]);
    check("co_1", "revoked");
    expect(expired()).toEqual([]);
    check("co_1", "reinstated");
    expect(expired()).toEqual([]);
    check("co_1", "passed");
    expect(expired()).toEqual([id]);
  });

  test("a provider document never qualifies, even expired on an abandoned company checked after it", () => {
    company("co_abandoned", "abandoned");
    const rec = { ...providerRecord("co_abandoned", "d1"), expiresAt: NOW - DAY };
    expect(documents.insert(rec)).toBe(true);
    setCreatedAt(rec.id, UPLOADED);
    check("co_abandoned", "passed");
    expect(expired()).toEqual([]);
  });

  test("an upload whose expiry is still ahead, that has no expiry, or whose bytes are gone does not qualify", () => {
    company("co_abandoned", "abandoned");
    const due = upload("co_abandoned", "due", { expiresAt: NOW });
    upload("co_abandoned", "ahead", { expiresAt: NOW + 1 });
    upload("co_abandoned", "none", { expiresAt: null });
    const gone = upload("co_abandoned", "gone");
    expect(documents.markBytesDeleted(gone, NOW)).toBe(true);
    expect(expired()).toEqual([due]);
  });

  test("rows that can never qualify do not take up the limit; the most overdue come first", () => {
    company("co_waiting");
    for (let i = 0; i < 5; i++)
      upload("co_waiting", `w${i}`, { uploadedAt: UPLOADED, expiresAt: NOW - 20 * DAY });
    company("co_abandoned", "abandoned");
    const later = upload("co_abandoned", "later", { expiresAt: NOW - 1 });
    const sooner = upload("co_abandoned", "sooner", { expiresAt: NOW - DAY });
    expect(expired(NOW, 1)).toEqual([sooner]);
    expect(expired(NOW, 2)).toEqual([sooner, later]);
  });
});

describe("the bytes of an upload", () => {
  test("markBytesDeleted then restoreBytes round-trips, and each moves only the row it describes", () => {
    company("co_1");
    const id = upload("co_1", "a");
    expect(documents.markBytesDeleted(id, NOW)).toBe(true);
    expect(documents.findOwned("co_1", id)).toMatchObject({
      bytesDeletedAt: NOW,
      expiresAt: UPLOADED + RETENTION,
    });
    // Already gone: the first deletion time stands.
    expect(documents.markBytesDeleted(id, NOW + 60)).toBe(false);
    expect(documents.findOwned("co_1", id)?.bytesDeletedAt).toBe(NOW);

    expect(documents.restoreBytes(id, NOW + RETENTION)).toBe(true);
    expect(documents.findOwned("co_1", id)).toMatchObject({
      bytesDeletedAt: null,
      expiresAt: NOW + RETENTION,
    });
    // Present: there is nothing to restore, and the expiry stays.
    expect(documents.restoreBytes(id, NOW + 2 * RETENTION)).toBe(false);
    expect(documents.findOwned("co_1", id)?.expiresAt).toBe(NOW + RETENTION);

    // A provider document's bytes are never marked, and an unknown id moves nothing.
    const provider = providerRecord("co_1", "d1");
    expect(documents.insert(provider)).toBe(true);
    expect(documents.markBytesDeleted(provider.id, NOW)).toBe(false);
    expect(documents.findOwned("co_1", provider.id)?.bytesDeletedAt).toBeNull();
    expect(documents.markBytesDeleted("no-such-document", NOW)).toBe(false);
    expect(documents.restoreBytes("no-such-document", NOW)).toBe(false);
  });

  test("countCustomerUploads counts the uploads with bytes present and all uploads, separately", () => {
    company("co_1");
    company("co_2");
    const a = upload("co_1", "a");
    upload("co_1", "b");
    upload("co_1", "c");
    expect(documents.markBytesDeleted(a, NOW)).toBe(true);
    expect(documents.insert(providerRecord("co_1", "d1"))).toBe(true);
    upload("co_2", "a");
    expect(documents.countCustomerUploads("co_1")).toEqual({ present: 2, all: 3 });
    expect(documents.countCustomerUploads("co_2")).toEqual({ present: 1, all: 1 });
    expect(documents.countCustomerUploads("co_none")).toEqual({ present: 0, all: 0 });
  });

  test("times are whole unix seconds, and the limit is a positive whole number", () => {
    company("co_1");
    const id = upload("co_1", "a");
    const inMs = Date.now();
    expect(() => documents.listExpiredCustomerUploads(inMs, 10)).toThrow(/seconds/);
    expect(() => documents.listExpiredCustomerUploads(NOW + 0.5, 10)).toThrow(/seconds/);
    expect(() => documents.listExpiredCustomerUploads(NOW, 0)).toThrow(/limit/);
    expect(() => documents.listExpiredCustomerUploads(NOW, -1)).toThrow(/limit/);
    expect(() => documents.markBytesDeleted(id, inMs)).toThrow(/seconds/);
    expect(() => documents.restoreBytes(id, inMs)).toThrow(/seconds/);
    expect(() =>
      documents.insert({ ...providerRecord("co_1", "d2"), source: "customer", expiresAt: inMs }),
    ).toThrow(/seconds/);
    expect(() =>
      documents.insert({ ...providerRecord("co_1", "d3"), source: "other" as "customer" }),
    ).toThrow(/source/);
    // Nothing was written by a refused call.
    expect(documents.findOwned("co_1", id)).toMatchObject({
      bytesDeletedAt: null,
      expiresAt: UPLOADED + RETENTION,
    });
    expect(documents.countCustomerUploads("co_1")).toEqual({ present: 1, all: 1 });
  });
});
