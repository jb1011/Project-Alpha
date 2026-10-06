import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { opsLog } from "../observability/opsLog";
import {
  type DocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../persistence/documentIndexRepository";
import type { DeletableDocumentStore } from "../persistence/documentStore";

/**
 * A CUSTOMER'S EVIDENCE: the PDFs a tenant uploads for the operator to check its declaration
 * against, one kind showing that the company exists and the other that the declarant controls it.
 *
 * An upload is inert. It is accepted when it is not empty, not over the size cap, hashes to the
 * sha256 the tenant named and starts with the five bytes every PDF starts with; it is never parsed,
 * rendered or inspected beyond those five bytes and its hash. It is served to its own tenant only,
 * through the document routes; the anchor loop selects the provider's documents only, so it is
 * never anchored; and it confirms nothing by itself: only the operator's check does.
 *
 * It shares the `documents` index with the provider's documents, as a row with `source = 'customer'`
 * and an expiry. Its bytes are deleted once the expiry rule allows (the rule is the SQL of
 * `listExpiredCustomerUploads`); its row and its hash stay.
 */

/** The largest upload, in bytes: 4 MiB. */
export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
/** A company's uploads with their bytes present. */
export const EVIDENCE_MAX_PRESENT_PER_COMPANY = 6;
/** A company's uploads in all, with their bytes or without. */
export const EVIDENCE_MAX_ROWS_PER_COMPANY = 24;
/** How long an upload's bytes are kept at least, from its upload: 30 days. */
export const EVIDENCE_RETENTION_SECONDS = 30 * 24 * 3600;
/** Uploads being read at once in the process. */
export const EVIDENCE_MAX_CONCURRENT = 4;

export type EvidenceKind = "existence" | "control";

export interface EvidenceDeps {
  documents: DocumentIndexRepository;
  docStore: DeletableDocumentStore;
  now?: () => number;
}

export type AcceptEvidenceResult =
  | { ok: true; docId: string; sha256: Hex; size: number; duplicate: boolean }
  | { ok: false; problem: "not_pdf" | "too_large" | "empty" | "too_many" | "content_mismatch" };

/** The five bytes every PDF starts with. */
const PDF_SIGNATURE = Buffer.from("%PDF-", "latin1");

/** The sha256 in the one spelling the index and the operator's checks keep: 0x, lower-case hex. */
function sha256Of(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function startsAsPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PDF_SIGNATURE.length && PDF_SIGNATURE.every((byte, i) => bytes[i] === byte)
  );
}

/**
 * Accepts an upload for a company, or says why not. The caller has already decided that the
 * company may take one (its tenant's own, declared by its customer, not abandoned).
 *
 * The checks, in order: empty; over the cap; the hash (before the PDF signature, so a body changed
 * on the way is reported as that, and not as a file that is not a PDF); the signature. Then:
 *  - the same file under the same kind with its bytes present is a duplicate, and nothing is
 *    written, whatever the caps say: a client that retries must not be refused by its own upload;
 *  - the same file under the same kind whose bytes were deleted takes them back in its own row,
 *    with a new expiry and a new upload time;
 *  - otherwise the file is a new row.
 * A file that would hold its bytes is refused when the company already holds
 * EVIDENCE_MAX_PRESENT_PER_COMPANY with theirs, and a new row when it already has
 * EVIDENCE_MAX_ROWS_PER_COMPANY. The bytes always go to the store before the index is written,
 * so a row never points at a file that is not there.
 *
 * Synchronous from the counts to the writes, so nothing else in this process runs in between and
 * two uploads cannot both pass a cap.
 */
export function acceptEvidence(
  deps: EvidenceDeps,
  p: { companyId: string; kind: EvidenceKind; expectedSha256: Hex; bytes: Uint8Array },
): AcceptEvidenceResult {
  const { companyId, kind, bytes } = p;
  if (bytes.length === 0) return { ok: false, problem: "empty" };
  if (bytes.length > EVIDENCE_MAX_BYTES) return { ok: false, problem: "too_large" };
  const sha256 = sha256Of(bytes);
  if (sha256 !== p.expectedSha256.toLowerCase()) return { ok: false, problem: "content_mismatch" };
  if (!startsAsPdf(bytes)) return { ok: false, problem: "not_pdf" };

  const providerDocId = `upload:${kind}:${sha256}`;
  const docId = documentIndexId(companyId, providerDocId);
  const size = bytes.length;
  const expiresAt = Math.floor((deps.now ?? Date.now)() / 1000) + EVIDENCE_RETENTION_SECONDS;
  const accepted = (duplicate: boolean): AcceptEvidenceResult => {
    opsLog("company_evidence_uploaded", { companyId, kind, size, duplicate });
    return { ok: true, docId, sha256, size, duplicate };
  };

  const existing = deps.documents.findByProviderDocId(companyId, providerDocId);
  if (existing !== undefined && existing.bytesDeletedAt === null) return accepted(true);

  const held = deps.documents.countCustomerUploads(companyId);
  if (held.present >= EVIDENCE_MAX_PRESENT_PER_COMPANY) return { ok: false, problem: "too_many" };
  if (existing === undefined && held.all >= EVIDENCE_MAX_ROWS_PER_COMPANY)
    return { ok: false, problem: "too_many" };

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (existing !== undefined) {
    deps.docStore.putBytes(existing.path, buffer);
    // Unreachable while nothing runs between the lookup above and this line.
    if (!deps.documents.restoreBytes(existing.id, expiresAt))
      throw new Error(`document index: upload ${existing.id} could not take its bytes back`);
    return accepted(false);
  }

  const docType = `evidence_${kind}`;
  // The whole hash in the name, without its 0x: the provider document id would be cut short, and
  // the company, the kind and the hash are what make an upload unique.
  const path = documentStoreName(companyId, docType, sha256.slice(2));
  deps.docStore.putBytes(path, buffer);
  const inserted = deps.documents.insert({
    id: docId,
    companyId,
    docType,
    sha256,
    contentType: "application/pdf",
    size,
    providerDocId,
    path,
    source: "customer",
    expiresAt,
  });
  // Unreachable for the same reason: the lookup above found no row.
  if (!inserted) throw new Error(`document index: upload ${docId} was indexed twice`);
  return accepted(false);
}

/**
 * Deletes the bytes of the customer uploads the expiry rule allows, at most `limit` of them, the
 * most overdue first, and returns how many. For each: the file, then the row. A file that is
 * already gone is not an error, so its row is marked all the same. A file that cannot be deleted
 * leaves its row unmarked, for the next run to try again, and is named in an ops line: it does not
 * hold back the others.
 *
 * Nothing calls it on a schedule yet: a periodic sweep is to.
 */
export function expireEvidenceBytes(deps: EvidenceDeps, limit: number): number {
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  let deleted = 0;
  for (const doc of deps.documents.listExpiredCustomerUploads(nowSeconds, limit)) {
    try {
      deps.docStore.delete(doc.path);
    } catch (err) {
      opsLog("company_evidence_expiry_failed", {
        companyId: doc.companyId,
        docId: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (deps.documents.markBytesDeleted(doc.id, nowSeconds)) deleted += 1;
  }
  return deleted;
}
