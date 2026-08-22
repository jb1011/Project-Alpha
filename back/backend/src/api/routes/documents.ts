import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { documentFileName } from "../../persistence/documentIndexRepository";
import type { ApiDeps } from "../app";
import { ApiError, requireOwnedEntity } from "../errors";
import { toDocumentView } from "../views";

/**
 * The tenant's legal documents (design §8).
 *
 * `GET /entities/:id/documents`         — the index (hashes, sizes, types)
 * `GET /entities/:id/documents/:docId`  — the PDF bytes
 *
 * Mounted after the `/entities/*` `requireAuth` line, so both inherit authentication, and
 * ownership is the two-line house idiom: look the entity up by key, compare `ownerTenantId`, and
 * answer a UNIFORM 404 for unknown-and-not-yours alike. Distinguishing them would turn the route
 * into an existence oracle over other tenants' entity ids.
 *
 * The download is deliberately a bytes route rather than a signed redirect. doola's own URLs
 * expire in about an hour and are not single-use, so handing one to a browser would be handing
 * out a bearer capability we cannot revoke; serving the bytes we already hashed also means what
 * the tenant downloads is provably the artifact the manifest commits to.
 *
 * The browser side cannot be an `<a href>` — that cannot carry a Bearer token — so the interface
 * fetches to a blob (`downloadDocument` in the api client) and creates an object URL.
 */
export function mountDocumentRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/entities/:id/documents", (c) => {
    const rec = requireOwnedEntity(deps, c);
    // No lookup wired (a deployment that has never formed anything) reads as "no documents",
    // which is the truth, rather than as an error.
    const docs = deps.formationDocuments?.(rec.idempotencyKey) ?? [];
    return c.json({
      // The SAME projection the entity view renders (M4) — `sha256` is the hash a verifier
      // re-computes from the bytes below, and from PR 3 the one the OA bundle manifest commits
      // to on-chain — plus the one field only this index carries.
      documents: docs.map((d) => ({ ...toDocumentView(d), createdAt: d.createdAt })),
    });
  });

  app.get("/entities/:id/documents/:docId", async (c) => {
    const rec = requireOwnedEntity(deps, c);
    // `findOwned` re-asserts the entity key, so a document id belonging to another entity is a
    // 404 here even though it is a perfectly valid id somewhere else.
    const doc = deps.documents?.findOwned(rec.idempotencyKey, c.req.param("docId"));
    if (!doc) throw new ApiError("not_found", 404, "document not found");

    let bytes: Buffer;
    try {
      // Off the event loop: a legal PDF is hundreds of kilobytes and `readFileSync` here would
      // stall every other request in the process for the length of the disk read.
      bytes = await deps.docStore.getBytesAsync(doc.path);
    } catch {
      // Indexed but not on disk: a restore that missed `data/documents/`, or a hand-deleted file.
      // The bytes are re-fetchable from doola (that is what `provider_doc_id` is for), so this is
      // a 404 and an ops line, not a 500.
      throw new ApiError("not_found", 404, "document not found");
    }

    // Always application/pdf, never the stored content type: doola sometimes serves a PDF as
    // `application/octet-stream`, and echoing that back would make browsers guess. `nosniff`
    // then stops them guessing anything else.
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `attachment; filename="${documentFileName(doc.docType)}"`);
    c.header("X-Content-Type-Options", "nosniff");
    // A legal document belonging to one tenant must not sit in a shared cache.
    c.header("Cache-Control", "private, no-store");
    // From the INDEX row, not from the buffer: it is the size the tenant was told the document
    // has, and a mismatch between the two is a fact worth surfacing rather than papering over.
    c.header("Content-Length", String(doc.size));
    // A VIEW over the same memory, not `new Uint8Array(bytes)` — that constructor COPIES the
    // whole PDF for nothing.
    return c.body(new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength));
  });
}
