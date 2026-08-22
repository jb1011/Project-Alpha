import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * The hash-pinned index over the real legal PDFs (design 2026-08-19 §3/§8).
 *
 * The BYTES live in the `DocumentStore` (and, as system of record, at doola — every row keeps its
 * `provider_doc_id` so the file is re-fetchable). What lives here is the thing the bytes alone
 * cannot prove: which entity a document belongs to, what kind of document it is, and the sha256
 * that the OA bundle manifest will commit to in PR 3. A row is written only after the bytes are
 * durably on disk, so an index entry never points at a file that is not there.
 *
 * Documents are IMMUTABLE once indexed: doola may re-issue a document, and when it does it gets a
 * new provider document id, which is a new row. Nothing here updates.
 */
export interface DocumentIndexRecord {
  /** Our stable, URL-safe id — see `documentIndexId`. This is what the download route takes. */
  id: string;
  entityKey: string;
  /** doola's `documentType`, e.g. "ArticlesOfOrganization" | "OperatingAgreement" | "EinLetter". */
  docType: string;
  sha256: string;
  contentType: string;
  size: number;
  /** doola's own document id — the handle that makes the bytes re-fetchable. */
  providerDocId: string;
  /** Name inside the DocumentStore (not a filesystem path the caller may dictate). */
  path: string;
  createdAt: string | null;
}

interface Row {
  id: string;
  entity_key: string | null;
  doc_type: string | null;
  sha256: string | null;
  content_type: string | null;
  size: number | null;
  provider_doc_id: string | null;
  path: string;
  created_at: string | null;
}

function toRecord(r: Row): DocumentIndexRecord {
  return {
    id: r.id,
    entityKey: r.entity_key ?? "",
    docType: r.doc_type ?? "",
    sha256: r.sha256 ?? "",
    contentType: r.content_type ?? "",
    size: r.size ?? 0,
    providerDocId: r.provider_doc_id ?? "",
    path: r.path,
    createdAt: r.created_at,
  };
}

/**
 * The document's public id: `sha256(entityKey \0 providerDocId)`, truncated to 32 hex chars.
 *
 * DETERMINISTIC on purpose. A random uuid would make "have we already stored this document?" a
 * question only a lookup could answer, and the answer would change if the lookup ever raced
 * itself — two rows for one doola document, two copies of the bytes, and a manifest that has to
 * choose. Derived from both halves so one entity's document id can never collide with another's,
 * whatever doola's id space does. URL-safe by construction, which is what the download route
 * needs (the entity key contains a `:`).
 */
export function documentIndexId(entityKey: string, providerDocId: string): string {
  return createHash("sha256").update(`${entityKey}\0${providerDocId}`).digest("hex").slice(0, 32);
}

/**
 * The DocumentStore name for a stored legal PDF.
 *
 * Both provider-supplied components are reduced to `[A-Za-z0-9._-]` before they reach a filename.
 * The store's own containment guard is the backstop, not the plan: a `documentType` of `../..` is
 * a partner-controlled string, and the first place to stop it is before it is a path at all.
 */
export function documentStoreName(
  entityKey: string,
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
  return `doc-${safe(entityKey)}-${safe(docType)}-${safe(providerDocId)}.pdf`;
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
  /** Index a stored document. Returns false when the row already existed (idempotent re-fetch). */
  insert(rec: Omit<DocumentIndexRecord, "createdAt">): boolean;
  listByEntity(entityKey: string): DocumentIndexRecord[];
  /** The same rows for MANY entities, in ONE statement — the list routes' N+1 (M5). */
  listByEntities(entityKeys: string[]): Map<string, DocumentIndexRecord[]>;
  /** Ownership is enforced by the caller against `entities`; the entity key is re-asserted here
   *  so a document id from one entity can never be read through another entity's route. */
  findOwned(entityKey: string, id: string): DocumentIndexRecord | undefined;
  findByProviderDocId(entityKey: string, providerDocId: string): DocumentIndexRecord | undefined;
  /** The doc types already stored for an entity — what "are the required documents in?" reads. */
  storedTypes(entityKey: string): string[];
}

export class SqliteDocumentIndexRepository implements DocumentIndexRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT OR IGNORE INTO documents
           (id, entity_key, doc_type, sha256, content_type, size, provider_doc_id, path)
         VALUES (@id, @entity_key, @doc_type, @sha256, @content_type, @size, @provider_doc_id, @path)`,
      ),
      listByEntity: db.prepare(
        "SELECT * FROM documents WHERE entity_key = ? ORDER BY created_at, doc_type, id",
      ),
      findOwned: db.prepare("SELECT * FROM documents WHERE entity_key = ? AND id = ?"),
      findByProvider: db.prepare(
        "SELECT * FROM documents WHERE entity_key = ? AND provider_doc_id = ?",
      ),
      storedTypes: db.prepare(
        "SELECT DISTINCT doc_type AS t FROM documents WHERE entity_key = ? AND doc_type IS NOT NULL",
      ),
    };
  }

  insert(rec: Omit<DocumentIndexRecord, "createdAt">): boolean {
    return (
      this.stmts.insert.run({
        id: rec.id,
        entity_key: rec.entityKey,
        doc_type: rec.docType,
        sha256: rec.sha256,
        content_type: rec.contentType,
        size: rec.size,
        provider_doc_id: rec.providerDocId,
        path: rec.path,
      }).changes === 1
    );
  }

  listByEntity(entityKey: string): DocumentIndexRecord[] {
    return (this.stmts.listByEntity.all(entityKey) as Row[]).map(toRecord);
  }

  listByEntities(entityKeys: string[]): Map<string, DocumentIndexRecord[]> {
    const out = new Map<string, DocumentIndexRecord[]>();
    if (entityKeys.length === 0) return out;
    for (let i = 0; i < entityKeys.length; i += 400) {
      const chunk = entityKeys.slice(i, i + 400);
      const rows = this.db
        .prepare(
          `SELECT * FROM documents WHERE entity_key IN (${chunk.map(() => "?").join(",")})
            ORDER BY created_at, doc_type, id`,
        )
        .all(...chunk) as Row[];
      for (const r of rows) {
        const key = r.entity_key ?? "";
        const list = out.get(key);
        if (list) list.push(toRecord(r));
        else out.set(key, [toRecord(r)]);
      }
    }
    return out;
  }

  findOwned(entityKey: string, id: string): DocumentIndexRecord | undefined {
    const r = this.stmts.findOwned.get(entityKey, id) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findByProviderDocId(entityKey: string, providerDocId: string): DocumentIndexRecord | undefined {
    const r = this.stmts.findByProvider.get(entityKey, providerDocId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  storedTypes(entityKey: string): string[] {
    return (this.stmts.storedTypes.all(entityKey) as { t: string }[]).map((r) => r.t);
  }
}
