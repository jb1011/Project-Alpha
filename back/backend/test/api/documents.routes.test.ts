/**
 * The tenant's legal-document surfaces (design §8).
 *
 * Two properties, and the ownership one is the reason this route exists as a bytes endpoint at
 * all: a signed doola URL handed to a browser would be an unrevocable bearer capability, whereas
 * this route re-checks who is asking on every single request.
 */
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentFileName,
  documentIndexId,
  documentStoreName,
} from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { ENTITY_KEY, MemoryDocumentStore, formedEntity } from "../helpers/formationFakes";

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const PDF = Buffer.from("%PDF-1.7\nArticles\n");

let db: Database.Database;
let repo: SqliteEntityRepository;
let documents: SqliteDocumentIndexRepository;
let requests: SqliteFormationRepository;
let docStore: MemoryDocumentStore;

/** The tenant id IS the controller wallet address, checksummed — `signSession` enforces it. */
const OWNER = getAddress("0x000000000000000000000000000000000000000a");
const OTHER = getAddress("0x000000000000000000000000000000000000000b");

async function token(tenantId: string): Promise<string> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

function app() {
  return buildApiApp({
    webOrigin: "https://app.example.com",
    jwtSecret: JWT_SECRET,
    repo,
    docStore,
    documents,
    formationSteps: (k: string) => requests.stepsOf(k),
    formationDocuments: (k: string) => documents.listByEntity(k),
  } as never);
}

const get = async (path: string, tenantId?: string) =>
  app().request(path, {
    headers: tenantId ? { authorization: `Bearer ${await token(tenantId)}` } : {},
  });

/** Index one stored document and put its bytes in the store. */
function storeDoc(entityKey: string, docId: string, docType: string, bytes = PDF) {
  const path = documentStoreName(entityKey, docType, docId);
  docStore.putBytes(path, bytes);
  documents.insert({
    id: documentIndexId(entityKey, docId),
    entityKey,
    docType,
    sha256: "a".repeat(64),
    contentType: "application/pdf",
    size: bytes.length,
    providerDocId: docId,
    path,
  });
  return documentIndexId(entityKey, docId);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  requests = new SqliteFormationRepository(db);
  docStore = new MemoryDocumentStore();
  repo.upsert(formedEntity({ ownerTenantId: OWNER }));
});
afterEach(() => db.close());

// ── the list ───────────────────────────────────────────────────────────────────────────────

test("the owner sees the index: id, type, derived name, size, sha256", async () => {
  storeDoc(ENTITY_KEY, "d-aoo", "ArticlesOfOrganization");
  const res = await get(`/entities/${encodeURIComponent(ENTITY_KEY)}/documents`, OWNER);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { documents: Record<string, unknown>[] };
  expect(body.documents).toHaveLength(1);
  expect(body.documents[0]).toMatchObject({
    type: "ArticlesOfOrganization",
    name: "ArticlesOfOrganization.pdf",
    size: PDF.length,
    sha256: "a".repeat(64),
  });
});

test("an entity with no documents lists an empty array, not an error", async () => {
  const res = await get(`/entities/${encodeURIComponent(ENTITY_KEY)}/documents`, OWNER);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ documents: [] });
});

// ── ownership ──────────────────────────────────────────────────────────────────────────────

test("another tenant gets the SAME 404 as a caller asking for an entity that does not exist", async () => {
  storeDoc(ENTITY_KEY, "d-aoo", "ArticlesOfOrganization");
  const mine = await get(`/entities/${encodeURIComponent(ENTITY_KEY)}/documents`, OTHER);
  const missing = await get("/entities/nope/documents", OTHER);
  expect(mine.status).toBe(404);
  expect(missing.status).toBe(404);
  // Identical bodies: the route is not an existence oracle over other tenants' entity ids.
  expect(await mine.text()).toBe(await missing.text());
});

test("both routes require authentication", async () => {
  const list = await get(`/entities/${encodeURIComponent(ENTITY_KEY)}/documents`);
  expect(list.status).toBe(401);
  const one = await get(`/entities/${encodeURIComponent(ENTITY_KEY)}/documents/whatever`);
  expect(one.status).toBe(401);
});

test("a document id belonging to ANOTHER entity is a 404 even for its rightful owner", async () => {
  repo.upsert(
    formedEntity({ idempotencyKey: "tenant-a:agent-2", publicId: undefined, ownerTenantId: OWNER }),
  );
  const theirs = storeDoc("tenant-a:agent-2", "d-oa", "OperatingAgreement");
  // Same tenant, same valid document id — but asked for through the wrong entity.
  const res = await get(`/entities/${encodeURIComponent(ENTITY_KEY)}/documents/${theirs}`, OWNER);
  expect(res.status).toBe(404);
});

// ── the bytes ──────────────────────────────────────────────────────────────────────────────

test("the download serves the bytes with the headers a PDF download needs", async () => {
  const id = storeDoc(ENTITY_KEY, "d-aoo", "ArticlesOfOrganization");
  const res = await get(`/entities/${encodeURIComponent(ENTITY_KEY)}/documents/${id}`, OWNER);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  expect(res.headers.get("content-disposition")).toBe(
    'attachment; filename="ArticlesOfOrganization.pdf"',
  );
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  // A legal document belonging to one tenant must not sit in a shared cache.
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
});

test("the served content type is always application/pdf, whatever doola stored it as", async () => {
  const path = documentStoreName(ENTITY_KEY, "EinLetter", "d-ein");
  docStore.putBytes(path, PDF);
  documents.insert({
    id: documentIndexId(ENTITY_KEY, "d-ein"),
    entityKey: ENTITY_KEY,
    docType: "EinLetter",
    sha256: "b".repeat(64),
    // doola sometimes serves a PDF as octet-stream; echoing that back makes browsers guess.
    contentType: "application/octet-stream",
    size: PDF.length,
    providerDocId: "d-ein",
    path,
  });
  const res = await get(
    `/entities/${encodeURIComponent(ENTITY_KEY)}/documents/${documentIndexId(ENTITY_KEY, "d-ein")}`,
    OWNER,
  );
  expect(res.headers.get("content-type")).toBe("application/pdf");
});

test("an indexed document whose bytes are missing is a 404, never a 500", async () => {
  // A restore that missed `data/documents/`. The bytes are re-fetchable from doola via
  // provider_doc_id, so this is a gap to fix, not a crash to serve.
  const id = documentIndexId(ENTITY_KEY, "d-gone");
  documents.insert({
    id,
    entityKey: ENTITY_KEY,
    docType: "OperatingAgreement",
    sha256: "c".repeat(64),
    contentType: "application/pdf",
    size: 10,
    providerDocId: "d-gone",
    path: "doc-does-not-exist.pdf",
  });
  const res = await get(`/entities/${encodeURIComponent(ENTITY_KEY)}/documents/${id}`, OWNER);
  expect(res.status).toBe(404);
});

test("the filename is DERIVED, so a provider-controlled type cannot inject a header", () => {
  // doola supplies `documentType`. A quote or a newline in a Content-Disposition value is a
  // header-injection primitive, and the first place to stop it is before it is a header.
  const name = documentFileName('evil"\r\nSet-Cookie: a=b');
  expect(name).not.toContain('"');
  expect(name).not.toContain("\r");
  expect(name).not.toContain("\n");
  expect(name.endsWith(".pdf")).toBe(true);
  expect(documentFileName("")).toBe("document.pdf");
});
