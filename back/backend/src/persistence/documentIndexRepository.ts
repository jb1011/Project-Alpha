import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * The hash-pinned index over the real legal PDFs (design 2026-08-19 §3/§8).
 *
 * The BYTES live in the `DocumentStore` (and, as system of record, at doola — every row keeps its
 * `provider_doc_id` so the file is re-fetchable). What lives here is the thing the bytes alone
 * cannot prove: which COMPANY a document belongs to, what kind of document it is, and the sha256
 * that the OA bundle manifest commits to. A row is written only after the bytes are durably on
 * disk, so an index entry never points at a file that is not there.
 *
 * Keyed by the COMPANY since 2026-08-26 §2: a company can be filed and have its documents fetched
 * BEFORE any agent attaches to it, so the entity key was never a key at all. Rows written before
 * the re-key keep their entity-derived index id and file path as OPAQUE LOCATORS — the manifest
 * commits to those bytes and their hashes, so nothing may be re-derived — and are found through
 * the backfilled `company_id` COLUMN, never by recomputing an id.
 *
 * A provider's documents are IMMUTABLE once indexed: doola may re-issue a document, and when it
 * does it gets a new provider document id, which is a new row. The one update is to a customer's
 * evidence upload (`source = 'customer'`), whose bytes expire: its row records when they were
 * deleted, and when the same bytes come back it takes a new expiry and a new `created_at`, as the
 * new upload it then is. Its other columns never change, and its hash stays after its bytes have
 * gone.
 */
export interface DocumentIndexRecord {
  /** Our stable, URL-safe id — see `documentIndexId`. This is what the download route takes. */
  id: string;
  companyId: string;
  /** Legacy locator on a pre-2026-08-26 row (the id and path embed it). Never written any more. */
  entityKey: string | null;
  /** doola's `documentType`, e.g. "ArticlesOfOrganization" | "OperatingAgreement" | "EinLetter". */
  docType: string;
  /**
   * Two spellings, by source: a customer's upload keeps `0x` and 64 lower-case hex digits (the
   * form the operator's checks store), a provider's document 64 hex digits with no `0x`. Compare
   * in the spelling of the row's source.
   */
  sha256: string;
  contentType: string;
  size: number;
  /** doola's own document id — the handle that makes the bytes re-fetchable. */
  providerDocId: string;
  /** Name inside the DocumentStore (not a filesystem path the caller may dictate). */
  path: string;
  createdAt: string | null;
  /** Who supplied the bytes: the formation provider, or the customer as evidence for the
   *  operator. A customer's upload has no provider to re-fetch it from. */
  source: "provider" | "customer";
  /** Unix seconds from which a customer upload's bytes may be deleted. Null on a provider's
   *  document, whose bytes never expire. */
  expiresAt: number | null;
  /** Unix seconds the bytes were deleted, null while they are present. */
  bytesDeletedAt: number | null;
}

/** What `insert` takes. Without `source` the row is a provider's document with no expiry, which is
 *  how every caller that predates customer uploads writes one. */
export type NewDocumentIndexRecord = Omit<
  DocumentIndexRecord,
  "createdAt" | "entityKey" | "source" | "expiresAt" | "bytesDeletedAt"
> & { entityKey?: null; source?: "provider" | "customer"; expiresAt?: number | null };

interface Row {
  id: string;
  company_id: string | null;
  entity_key: string | null;
  doc_type: string | null;
  sha256: string | null;
  content_type: string | null;
  size: number | null;
  provider_doc_id: string | null;
  path: string;
  created_at: string | null;
  source: DocumentIndexRecord["source"];
  expires_at: number | null;
  bytes_deleted_at: number | null;
}

function toRecord(r: Row): DocumentIndexRecord {
  return {
    id: r.id,
    companyId: r.company_id ?? "",
    entityKey: r.entity_key,
    docType: r.doc_type ?? "",
    sha256: r.sha256 ?? "",
    contentType: r.content_type ?? "",
    size: r.size ?? 0,
    providerDocId: r.provider_doc_id ?? "",
    path: r.path,
    createdAt: r.created_at,
    source: r.source,
    expiresAt: r.expires_at,
    bytesDeletedAt: r.bytes_deleted_at,
  };
}

const SOURCES: readonly DocumentIndexRecord["source"][] = ["provider", "customer"];
/** The largest time in unix seconds accepted. A time in milliseconds is past it for centuries. */
const MAX_UNIX_SECONDS = 99_999_999_999;

/** A refusal names the argument and the rule, never the value. */
function assertUnixSeconds(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_UNIX_SECONDS)
    throw new Error(
      `document index: ${field} must be a whole number of unix seconds (1 to ${MAX_UNIX_SECONDS})`,
    );
}

/**
 * The document's public id: `sha256(companyId \0 providerDocId)`, truncated to 32 hex chars.
 *
 * DETERMINISTIC on purpose. A random uuid would make "have we already stored this document?" a
 * question only a lookup could answer, and the answer would change if the lookup ever raced
 * itself — two rows for one doola document, two copies of the bytes, and a manifest that has to
 * choose. Derived from both halves so one company's document id can never collide with another's,
 * whatever doola's id space does. URL-safe by construction.
 *
 * ⚠ Existing rows keep the id this function USED to produce (it hashed the entity key). They are
 * never re-derived — the manifest commits to `{type, sha256, name}` and the download route
 * resolves an id by lookup, not by recomputation.
 */
export function documentIndexId(companyId: string, providerDocId: string): string {
  return createHash("sha256").update(`${companyId}\0${providerDocId}`).digest("hex").slice(0, 32);
}

/**
 * The DocumentStore name for a stored legal PDF.
 *
 * Both provider-supplied components are reduced to `[A-Za-z0-9._-]` before they reach a filename.
 * The store's own containment guard is the backstop, not the plan: a `documentType` of `../..` is
 * a partner-controlled string, and the first place to stop it is before it is a path at all.
 */
export function documentStoreName(
  companyId: string,
  docType: string,
  providerDocId: string,
): string {
  // Two passes, both load-bearing: the first removes every character that could be a path
  // separator (or anything else a filesystem gives meaning to), the second collapses runs of dots
  // so no `..` survives the first pass to sit inside the name.
  const safe = (s: string) =>
    s
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .slice(0, 64) || "unknown";
  return `doc-${safe(companyId)}-${safe(docType)}-${safe(providerDocId)}.pdf`;
}

/**
 * The name a downloaded document is offered under.
 *
 * DERIVED from the doc type, never echoed from doola's `name` field. Two reasons, and the second
 * is the one that matters: a provider-controlled string would land verbatim in a
 * `Content-Disposition` header, where quotes and newlines are header-injection primitives; and
 * "ArticlesOfOrganization.pdf" is a better filename than whatever doola happens to call it.
 */
export function documentFileName(docType: string): string {
  const safe = (docType || "document").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".");
  return `${safe.slice(0, 64) || "document"}.pdf`;
}

export interface DocumentIndexRepository {
  /**
   * Index a stored document. Returns false when the row already existed (idempotent re-fetch).
   * `source` defaults to `provider` and `expiresAt` to none; a customer's upload passes both.
   */
  insert(rec: NewDocumentIndexRecord): boolean;
  listByCompany(companyId: string): DocumentIndexRecord[];
  /**
   * The same rows for MANY COMPANIES, in ONE statement — the list routes' N+1 (M5).
   *
   * COMPANY-keyed, and deliberately no join. The entity-shaped version went
   * entity → `entities.company_id` → documents and back, which cost a join per page and, worse,
   * could not answer for a company with no agent attached to it — a shape the re-key made
   * ordinary, since a company can be filed and have its documents fetched before anyone onboards.
   * The caller already knows each row's company; asking by that is both cheaper and total.
   */
  listByCompanies(companyIds: string[]): Map<string, DocumentIndexRecord[]>;
  /** Ownership is enforced by the caller against `companies`; the company id is re-asserted here
   *  so a document id from one company can never be read through another company's route. */
  findOwned(companyId: string, id: string): DocumentIndexRecord | undefined;
  findByProviderDocId(companyId: string, providerDocId: string): DocumentIndexRecord | undefined;
  /** The doc types already stored for a company — what "are the required documents in?" reads. */
  storedTypes(companyId: string): string[];
  /**
   * The customer uploads whose bytes may be deleted now: at most `limit`, the most overdue first.
   *
   * The whole rule is in the SQL, so a row that cannot qualify never takes a place under the
   * limit. An upload qualifies when
   *  - its expiry has passed (`expires_at <= nowSeconds`) and its bytes are present;
   *  - its company is abandoned, or a check of its company was recorded after the upload;
   *  - and the company's latest check, if it has one, is neither `revoked` (the bytes are evidence
   *    in a dispute) nor `reinstated` (the re-check needs them). This holds on an abandoned
   *    company too: an operator can revoke one.
   * So on a company that is not abandoned, an upload no check has followed waits however old it
   * is, and one checked after its expiry goes at the next sweep. A check's time is its
   * `created_at`, compared with the upload's (for restored bytes, the time of the restore) at
   * one-second resolution: a check recorded in the same second as the upload is not after it.
   *
   * Reads `company_checks` and `companies`, so it runs only on a migrated database.
   */
  listExpiredCustomerUploads(nowSeconds: number, limit: number): DocumentIndexRecord[];
  /** Records that a customer upload's bytes were deleted. False unless the id is a customer upload
   *  with its bytes present: a deletion time, once written, stands, and a provider's document is
   *  never marked. */
  markBytesDeleted(id: string, atSeconds: number): boolean;
  /**
   * The bytes of a customer upload are back: clears `bytes_deleted_at`, sets a new expiry, and
   * moves `created_at` to the database's clock. The file then counts as a new upload, which waits
   * for a check recorded after it, however old the first upload was. False unless the id is a
   * customer upload whose bytes were deleted.
   */
  restoreBytes(id: string, expiresAt: number): boolean;
  /** A company's customer uploads: those with their bytes present, and all of them. */
  countCustomerUploads(companyId: string): { present: number; all: number };
}

export class SqliteDocumentIndexRepository implements DocumentIndexRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      // `entity_key` is deliberately not written: a new document may belong to a company that no
      // agent has attached to yet, and inventing an entity for it would be a fact we do not have.
      insert: db.prepare(
        `INSERT OR IGNORE INTO documents
           (id, company_id, doc_type, sha256, content_type, size, provider_doc_id, path, source,
            expires_at)
         VALUES (@id, @company_id, @doc_type, @sha256, @content_type, @size, @provider_doc_id, @path,
                 @source, @expires_at)`,
      ),
      listByCompany: db.prepare(
        "SELECT * FROM documents WHERE company_id = ? ORDER BY created_at, doc_type, id",
      ),
      findOwned: db.prepare("SELECT * FROM documents WHERE company_id = ? AND id = ?"),
      findByProvider: db.prepare(
        "SELECT * FROM documents WHERE company_id = ? AND provider_doc_id = ?",
      ),
      storedTypes: db.prepare(
        "SELECT DISTINCT doc_type AS t FROM documents WHERE company_id = ? AND doc_type IS NOT NULL",
      ),
      // The rule, clause by clause, is on the interface. The latest check is the one with the
      // highest id, as everywhere else that reads `company_checks`; a company with no check has
      // none to hold its uploads, hence the IFNULL.
      listExpiredCustomerUploads: db.prepare(
        `SELECT d.* FROM documents d
           JOIN companies c ON c.company_id = d.company_id
          WHERE d.source = 'customer'
            AND d.bytes_deleted_at IS NULL
            AND d.expires_at IS NOT NULL AND d.expires_at <= @now
            AND (c.status = 'abandoned'
                 OR EXISTS (SELECT 1 FROM company_checks k
                             WHERE k.company_id = d.company_id
                               AND k.created_at > d.created_at))
            AND IFNULL((SELECT l.result FROM company_checks l
                         WHERE l.company_id = d.company_id
                         ORDER BY l.check_id DESC LIMIT 1), '') NOT IN ('revoked', 'reinstated')
          ORDER BY d.expires_at, d.id
          LIMIT @limit`,
      ),
      markBytesDeleted: db.prepare(
        `UPDATE documents SET bytes_deleted_at = @at
          WHERE id = @id AND source = 'customer' AND bytes_deleted_at IS NULL`,
      ),
      // CURRENT_TIMESTAMP is what the column defaults to, so a restored row reads like a new one.
      restoreBytes: db.prepare(
        `UPDATE documents
            SET bytes_deleted_at = NULL, expires_at = @expires_at, created_at = CURRENT_TIMESTAMP
          WHERE id = @id AND source = 'customer' AND bytes_deleted_at IS NOT NULL`,
      ),
      countCustomerUploads: db.prepare(
        `SELECT COUNT(CASE WHEN bytes_deleted_at IS NULL THEN 1 END) AS present,
                COUNT(*) AS all_rows
           FROM documents
          WHERE company_id = ? AND source = 'customer'`,
      ),
    };
  }

  insert(rec: NewDocumentIndexRecord): boolean {
    const source = rec.source ?? "provider";
    if (!SOURCES.includes(source))
      throw new Error(`document index: source must be one of ${SOURCES.join(", ")}`);
    const expiresAt = rec.expiresAt ?? null;
    if (expiresAt !== null) assertUnixSeconds("expiresAt", expiresAt);
    return (
      this.stmts.insert.run({
        id: rec.id,
        company_id: rec.companyId,
        doc_type: rec.docType,
        sha256: rec.sha256,
        content_type: rec.contentType,
        size: rec.size,
        provider_doc_id: rec.providerDocId,
        path: rec.path,
        source,
        expires_at: expiresAt,
      }).changes === 1
    );
  }

  listByCompany(companyId: string): DocumentIndexRecord[] {
    return (this.stmts.listByCompany.all(companyId) as Row[]).map(toRecord);
  }

  listByCompanies(companyIds: string[]): Map<string, DocumentIndexRecord[]> {
    const out = new Map<string, DocumentIndexRecord[]>();
    if (companyIds.length === 0) return out;
    // Chunked at 400, clear of SQLITE_MAX_VARIABLE_NUMBER — the `stepsOfMany` idiom.
    for (let i = 0; i < companyIds.length; i += 400) {
      const chunk = companyIds.slice(i, i + 400);
      const rows = this.db
        .prepare(
          `SELECT * FROM documents
            WHERE company_id IN (${chunk.map(() => "?").join(",")})
            ORDER BY created_at, doc_type, id`,
        )
        .all(...chunk) as Row[];
      for (const r of rows) {
        const key = r.company_id;
        if (!key) continue; // a legacy row the backfill could not place has no company to key on
        const list = out.get(key);
        if (list) list.push(toRecord(r));
        else out.set(key, [toRecord(r)]);
      }
    }
    return out;
  }

  findOwned(companyId: string, id: string): DocumentIndexRecord | undefined {
    const r = this.stmts.findOwned.get(companyId, id) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findByProviderDocId(companyId: string, providerDocId: string): DocumentIndexRecord | undefined {
    const r = this.stmts.findByProvider.get(companyId, providerDocId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  storedTypes(companyId: string): string[] {
    return (this.stmts.storedTypes.all(companyId) as { t: string }[]).map((r) => r.t);
  }

  listExpiredCustomerUploads(nowSeconds: number, limit: number): DocumentIndexRecord[] {
    assertUnixSeconds("nowSeconds", nowSeconds);
    // Checked here because SQLite reads a negative LIMIT as no limit at all.
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("document index: limit must be a positive whole number");
    return (this.stmts.listExpiredCustomerUploads.all({ now: nowSeconds, limit }) as Row[]).map(
      toRecord,
    );
  }

  markBytesDeleted(id: string, atSeconds: number): boolean {
    assertUnixSeconds("atSeconds", atSeconds);
    return this.stmts.markBytesDeleted.run({ id, at: atSeconds }).changes === 1;
  }

  restoreBytes(id: string, expiresAt: number): boolean {
    assertUnixSeconds("expiresAt", expiresAt);
    return this.stmts.restoreBytes.run({ id, expires_at: expiresAt }).changes === 1;
  }

  countCustomerUploads(companyId: string): { present: number; all: number } {
    const r = this.stmts.countCustomerUploads.get(companyId) as {
      present: number;
      all_rows: number;
    };
    return { present: r.present, all: r.all_rows };
  }
}
