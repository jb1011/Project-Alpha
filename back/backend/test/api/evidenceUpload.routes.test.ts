/**
 * The evidence upload door, `POST /companies/:companyId/evidence`, and what the tenant's document
 * routes answer for an upload.
 *
 * The door takes the raw PDF as its body, with its kind and its sha256 in the query. Before it
 * reads a byte it checks, in order: the session, that the company is the tenant's own, that it was
 * declared by its customer, that it is not abandoned, the content type, the kind and the hash, and
 * a declared length over the cap; then one upload at a time per tenant and four in the process.
 * The body is read under the cap, and stored only when it hashes to the value named.
 *
 * Every company and file here is an invention, and the keys are anvil's published test accounts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_CONCURRENT,
  EVIDENCE_MAX_PRESENT_PER_COMPANY,
  EVIDENCE_RETENTION_SECONDS,
  expireEvidenceBytes,
} from "../../src/legalBody/evidence";
import { CUSTOMER_PROVIDER } from "../../src/legalBody/provider";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentIndexId,
} from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  CHAIN_ID,
  FORMATION_PROVIDER,
  customerCompanyDeps,
} from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";

const owner = ANVIL_ACCOUNT_2.address;
const stranger = ANVIL_ACCOUNT_3.address;
/** More tenants, for the process-wide limit: invented addresses, no wallet behind them. */
const others = ["b1", "b2", "b3", "b4"].map((tail) => getAddress(`0x${"0".repeat(38)}${tail}`));

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const MIB = 1024 * 1024;
const DAY = 86_400;

let db: Database.Database;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let documents: SqliteDocumentIndexRepository;
let docStore: DeletableMemoryDocumentStore;
let app: ReturnType<typeof buildApiApp>;
/** The doors' clock, in milliseconds: the real time, so the database's own clock agrees with it. */
let nowMs: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  docStore = new DeletableMemoryDocumentStore();
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  // An accepted upload writes an ops line: kept off stdout here.
  vi.spyOn(console, "log").mockImplementation(() => {});
  app = makeApp();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/**
 * The API over this test's database, with the customer doors on unless `doorsOn` is false. ONE
 * memory store, and one index, in both places: the doors write through them and the document routes
 * read through them, as the composition root wires the same instances.
 */
function makeApp(doorsOn = true) {
  const stores = { db, companies, declarations, checks, store: new SqliteWorldStore(db) };
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo: new SqliteEntityRepository(db),
    companies,
    documents,
    docStore,
    customerFacts: { declarations, checks },
    customerCompanies: doorsOn
      ? { ...customerCompanyDeps(stores, () => nowMs), documents, docStore }
      : undefined,
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}

/** A company declared by its customer, owned by `tenantId`. */
function customerCompany(companyId: string, tenantId: Address = owner): string {
  return companies.create({
    companyId,
    tenantId,
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

/** A company filed through formation, owned by `tenantId`. */
function formationCompany(companyId: string, tenantId: Address = owner): string {
  return companies.create({
    companyId,
    tenantId,
    status: "ready",
    provider: FORMATION_PROVIDER,
    environment: "production",
    synthetic: false,
    nameOptions: [{ name: "Example Robotics", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
}

/** A small PDF, different for every label. Only its first five bytes make it one. */
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF\n`, "latin1");
/** A PDF of exactly `size` bytes. */
function pdfOfSize(size: number): Buffer {
  const bytes = Buffer.alloc(size, 0x20);
  bytes.write("%PDF-", 0, "latin1");
  return bytes;
}
/** The sha256 as a client writes it on the wire: 64 hexadecimal digits. */
const hexOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function sessionOf(tenantId: Address): Promise<string> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

interface UploadOptions {
  kind?: string;
  /** The sha256 parameter. Required with a stream body, whose bytes the helper cannot hash. */
  sha256?: string;
  /** The whole query string, instead of `kind` and `sha256`. */
  query?: string;
  /** The content type; `null` sends none. */
  contentType?: string | null;
  headers?: Record<string, string>;
  /** Send no session. */
  anonymous?: boolean;
}

async function upload(
  who: Address,
  companyId: string,
  body: Uint8Array | ReadableStream<Uint8Array>,
  opts: UploadOptions = {},
): Promise<Response> {
  const query =
    opts.query ??
    new URLSearchParams({
      kind: opts.kind ?? "existence",
      sha256: opts.sha256 ?? (body instanceof Uint8Array ? hexOf(body) : ""),
    }).toString();
  const headers: Record<string, string> = { ...opts.headers };
  if (!opts.anonymous) headers.authorization = `Bearer ${await sessionOf(who)}`;
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/pdf";
  // `duplex` is what lets a stream be a request body; the DOM typing does not know it yet.
  const init = { method: "POST", headers, body, duplex: "half" } as RequestInit;
  return app.request(`/companies/${companyId}/evidence?${query}`, init);
}

async function get(who: Address, path: string): Promise<Response> {
  return app.request(path, { headers: { authorization: `Bearer ${await sessionOf(who)}` } });
}

/** The refusal envelope, and the raw text, to show what it does not carry. */
async function refusalOf(
  res: Response,
): Promise<{ status: number; code: string; details: unknown; text: string; body: object }> {
  const text = await res.text();
  const body = JSON.parse(text);
  return { status: res.status, code: body.error?.code, details: body.error?.details, text, body };
}

/**
 * A body that sends its first bytes, then waits until the test lets the rest go. `reading`
 * resolves once the door has started to read it, which is after every check that comes first.
 */
function heldBody(bytes: Uint8Array) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReading!: () => void;
  const reading = new Promise<void>((resolve) => {
    markReading = resolve;
  });
  let started = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!started) {
          started = true;
          markReading();
          controller.enqueue(bytes.slice(0, 8));
          return;
        }
        await released;
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    },
    // Nothing is pulled until the door reads.
    { highWaterMark: 0 },
  );
  return { stream, reading, release };
}

/** A body that records whether anything read from it. */
function watchedBody(bytes: Uint8Array) {
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled };
}

const uploadRows = () =>
  db.prepare("SELECT * FROM documents WHERE source = 'customer'").all() as {
    id: string;
    company_id: string;
  }[];

/** Moves every customer upload of a company back in time, so a check recorded now is after it. */
function backdateUploads(companyId: string, secondsAgo: number): void {
  db.prepare(
    "UPDATE documents SET created_at = ? WHERE company_id = ? AND source = 'customer'",
  ).run(sqliteUtcTimestamp(Date.now() - secondsAgo * 1000), companyId);
}

/** A failed check, as the operator records one. */
function failedCheck(companyId: string): void {
  checks.append({
    companyId,
    result: "failed",
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: Math.floor(nowMs / 1000),
    registryName: null,
    registryFilingId: null,
    registryStatus: null,
    formationDate: null,
    registeredAgent: null,
    existenceEvidenceSha256: null,
    controlEvidenceSha256: null,
    controlEvidenceKind: null,
    reasonCode: "filing_not_found",
    reason: "Recorded for a test.",
  });
}

const expire = (): number => expireEvidenceBytes({ documents, docStore, now: () => nowMs }, 50);

// ── storing ────────────────────────────────────────────────────────────────────────────────────

describe("an upload that is accepted", () => {
  test("is stored and answered 201 with its id, hash and size; the tenant lists it and downloads the same bytes", async () => {
    customerCompany("co_1");
    const file = pdf("certificate of good standing");

    const res = await upload(owner, "co_1", file);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["docId", "sha256", "size"]);
    const sha256 = `0x${hexOf(file)}`;
    expect(body).toEqual({
      docId: documentIndexId("co_1", `upload:existence:${sha256}`),
      sha256,
      size: file.length,
    });
    expect(documents.findOwned("co_1", body.docId)).toMatchObject({
      source: "customer",
      docType: "evidence_existence",
      sha256,
      size: file.length,
      expiresAt: Math.floor(nowMs / 1000) + EVIDENCE_RETENTION_SECONDS,
      bytesDeletedAt: null,
    });

    const listed = await (await get(owner, "/companies/co_1/documents")).json();
    expect(listed.documents).toEqual([
      expect.objectContaining({ id: body.docId, type: "evidence_existence", sha256 }),
    ]);
    const download = await get(owner, `/companies/co_1/documents/${body.docId}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await download.arrayBuffer()).equals(file)).toBe(true);
  });

  test("takes a file far larger than the 8 KiB the JSON doors read, and a sha256 written with 0x or in capitals", async () => {
    customerCompany("co_1");
    const large = pdfOfSize(256 * 1024);
    expect((await upload(owner, "co_1", large)).status).toBe(201);

    const file = pdf("articles");
    const res = await upload(owner, "co_1", file, {
      kind: "control",
      sha256: `0x${hexOf(file).toUpperCase()}`,
    });
    expect(res.status).toBe(201);
    // Answered in the one spelling the index keeps.
    expect((await res.json()).sha256).toBe(`0x${hexOf(file)}`);
  });

  test("the same file and kind again answers 200 with the same body and writes nothing; under the other kind it is a second row", async () => {
    customerCompany("co_1");
    const file = pdf("letter");
    const first = await upload(owner, "co_1", file, { kind: "control" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const row = documents.findOwned("co_1", firstBody.docId);

    nowMs += DAY * 1000;
    const writes = vi.spyOn(docStore, "putBytes");
    const again = await upload(owner, "co_1", file, { kind: "control" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    expect(writes).not.toHaveBeenCalled();
    expect(documents.findOwned("co_1", firstBody.docId)).toEqual(row);
    writes.mockRestore();

    const other = await upload(owner, "co_1", file, { kind: "existence" });
    expect(other.status).toBe(201);
    expect((await other.json()).docId).not.toBe(firstBody.docId);
    expect(uploadRows()).toHaveLength(2);
  });
});

// ── refusing ───────────────────────────────────────────────────────────────────────────────────

describe("an upload that is refused stores nothing", () => {
  test("a body whose hash differs from the sha256 parameter is content_mismatch", async () => {
    customerCompany("co_1");
    const refused = await refusalOf(
      await upload(owner, "co_1", pdf("what arrived"), { sha256: hexOf(pdf("what was sent")) }),
    );
    expect(refused).toMatchObject({ status: 400, code: "content_mismatch" });
    expect(uploadRows()).toEqual([]);
    expect(docStore.files.size).toBe(0);
  });

  test("not a PDF, or an empty body: a validation_error naming the body", async () => {
    customerCompany("co_1");
    for (const body of [Buffer.from("GIF89a, not a pdf", "latin1"), Buffer.alloc(0)]) {
      const refused = await refusalOf(await upload(owner, "co_1", body));
      expect(refused).toMatchObject({ status: 400, code: "validation_error" });
      expect(refused.details).toEqual([{ field: "body", problem: expect.any(String) }]);
    }
    expect(uploadRows()).toEqual([]);
    expect(docStore.files.size).toBe(0);
  });

  test("a content type other than application/pdf, or none: 415", async () => {
    customerCompany("co_1");
    for (const contentType of [
      "text/plain",
      "application/octet-stream",
      "application/json",
      null,
    ]) {
      const refused = await refusalOf(await upload(owner, "co_1", pdf("x"), { contentType }));
      expect(refused, String(contentType)).toMatchObject({
        status: 415,
        code: "unsupported_media_type",
      });
    }
    expect(uploadRows()).toEqual([]);
    // The media type is read as HTTP defines it: its case and its parameters do not change it.
    expect(
      (await upload(owner, "co_1", pdf("y"), { contentType: "Application/PDF; name=y.pdf" }))
        .status,
    ).toBe(201);
  });

  test("a kind or a sha256 that is not well-formed: a validation_error naming each, never echoing it", async () => {
    customerCompany("co_1");
    const cases: [string, string[]][] = [
      [`sha256=${"a".repeat(64)}`, ["kind"]],
      ["kind=existence", ["sha256"]],
      [`kind=passport&sha256=${"a".repeat(64)}`, ["kind"]],
      [`kind=existence&sha256=${"a".repeat(63)}`, ["sha256"]],
      [`kind=existence&sha256=${"g".repeat(64)}`, ["sha256"]],
      ["kind=Existence&sha256=0x1234", ["kind", "sha256"]],
    ];
    for (const [query, fields] of cases) {
      const refused = await refusalOf(await upload(owner, "co_1", pdf("x"), { query }));
      expect(refused, query).toMatchObject({ status: 400, code: "validation_error" });
      expect(
        (refused.details as { field: string }[]).map((d) => d.field),
        query,
      ).toEqual(fields);
      expect(refused.text, query).not.toContain("passport");
    }
    expect(uploadRows()).toEqual([]);
  });

  test("a body one byte over the limit is 413; a body that keeps coming is cut off, never buffered whole; the limit itself is taken", async () => {
    customerCompany("co_1");
    const over = pdfOfSize(EVIDENCE_MAX_BYTES + 1);
    expect(await refusalOf(await upload(owner, "co_1", over))).toMatchObject({
      status: 413,
      code: "payload_too_large",
    });

    // Eight chunks of 1 MiB, sent only as they are read.
    let sent = 0;
    let cancelled = false;
    const chunk = pdfOfSize(MIB);
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent >= 8 * MIB) return controller.close();
          sent += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const refused = await refusalOf(
      await upload(owner, "co_1", endless, { sha256: "a".repeat(64) }),
    );
    expect(refused).toMatchObject({ status: 413, code: "payload_too_large" });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES + MIB);
    expect(uploadRows()).toEqual([]);
    expect(docStore.files.size).toBe(0);

    expect((await upload(owner, "co_1", over.subarray(0, EVIDENCE_MAX_BYTES))).status).toBe(201);
  });

  test("a declared Content-Length over the limit is 413 before a byte is read", async () => {
    customerCompany("co_1");
    const file = pdf("small, but declared large");
    const body = watchedBody(file);
    const refused = await refusalOf(
      await upload(owner, "co_1", body.stream, {
        sha256: hexOf(file),
        // `app.request` sends no length for a byte body: the test declares one itself.
        headers: { "content-length": String(EVIDENCE_MAX_BYTES + 1) },
      }),
    );
    expect(refused).toMatchObject({ status: 413, code: "payload_too_large" });
    expect(body.pulled()).toBe(false);
    expect(uploadRows()).toEqual([]);

    // The same body without the declared length is read, and taken.
    const control = watchedBody(file);
    expect((await upload(owner, "co_1", control.stream, { sha256: hexOf(file) })).status).toBe(201);
    expect(control.pulled()).toBe(true);
  });

  test(`the file after ${EVIDENCE_MAX_PRESENT_PER_COMPANY} with their bytes present is a 409; after expiry it is stored, and an expired one comes back`, async () => {
    customerCompany("co_1");
    const six = Array.from({ length: EVIDENCE_MAX_PRESENT_PER_COMPANY }, (_, i) => pdf(`f${i}`));
    for (const file of six) expect((await upload(owner, "co_1", file)).status).toBe(201);
    const seventh = pdf("f6");
    expect(await refusalOf(await upload(owner, "co_1", seventh))).toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(uploadRows()).toHaveLength(6);

    backdateUploads("co_1", 40 * DAY);
    failedCheck("co_1");
    nowMs += EVIDENCE_RETENTION_SECONDS * 1000;
    expect(expire()).toBe(6);

    expect((await upload(owner, "co_1", seventh)).status).toBe(201);
    const back = await upload(owner, "co_1", six[0]!);
    expect(back.status).toBe(201);
    const { docId } = await back.json();
    const download = await get(owner, `/companies/co_1/documents/${docId}`);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(six[0]!)).toBe(true);
  });
});

// ── whose company ──────────────────────────────────────────────────────────────────────────────

describe("whose company", () => {
  test("no session is a 401", async () => {
    customerCompany("co_1");
    expect((await upload(owner, "co_1", pdf("x"), { anonymous: true })).status).toBe(401);
  });

  test("on a deployment without the customer doors there is no upload door, and an upload made earlier is still served", async () => {
    customerCompany("co_1");
    const file = pdf("made while the doors were on");
    const { docId } = await (await upload(owner, "co_1", file)).json();

    app = makeApp(false);
    expect((await upload(owner, "co_1", pdf("x"))).status).toBe(404);
    const download = await get(owner, `/companies/co_1/documents/${docId}`);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(file)).toBe(true);
    expect(uploadRows()).toHaveLength(1);
  });

  test("another tenant, an unknown company and an abandoned one get the same 404; a formation company gets a 409", async () => {
    customerCompany("co_1");
    customerCompany("co_abandoned");
    expect(companies.setStatus("co_abandoned", "draft", "abandoned")).toBe(true);
    formationCompany("co_formation");

    const theirs = await refusalOf(await upload(stranger, "co_1", pdf("x")));
    const unknown = await refusalOf(await upload(stranger, "no-such-company", pdf("x")));
    const abandoned = await refusalOf(await upload(owner, "co_abandoned", pdf("x")));
    expect(theirs).toMatchObject({ status: 404, code: "not_found" });
    expect(theirs.body).toEqual(unknown.body);
    expect(abandoned.body).toEqual(unknown.body);
    expect(await refusalOf(await upload(owner, "co_formation", pdf("x")))).toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(uploadRows()).toEqual([]);
  });

  test("a company abandoned while its upload is being read stores nothing", async () => {
    customerCompany("co_1");
    const file = pdf("arrives late");
    const held = heldBody(file);
    const pending = upload(owner, "co_1", held.stream, { sha256: hexOf(file) });
    await held.reading;
    expect(companies.setStatus("co_1", "draft", "abandoned")).toBe(true);
    held.release();
    expect(await refusalOf(await pending)).toMatchObject({ status: 404, code: "not_found" });
    expect(uploadRows()).toEqual([]);
    expect(docStore.files.size).toBe(0);
  });
});

// ── one at a time ──────────────────────────────────────────────────────────────────────────────

describe("uploads in flight", () => {
  test("a second upload from the same tenant while the first is being read is a 429; another tenant is not held back; the first finishing frees the tenant", async () => {
    customerCompany("co_1");
    customerCompany("co_2", stranger);
    const file = pdf("first");
    const held = heldBody(file);
    const first = upload(owner, "co_1", held.stream, { sha256: hexOf(file) });
    await held.reading;

    expect(await refusalOf(await upload(owner, "co_1", pdf("second")))).toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    expect((await upload(stranger, "co_2", pdf("theirs"))).status).toBe(201);

    held.release();
    expect((await first).status).toBe(201);
    expect((await upload(owner, "co_1", pdf("second"))).status).toBe(201);
    // A refusal frees the tenant too.
    expect((await upload(owner, "co_1", pdf("third"), { sha256: hexOf(pdf("x")) })).status).toBe(
      400,
    );
    expect((await upload(owner, "co_1", pdf("third"))).status).toBe(201);
  });

  test(`at most ${EVIDENCE_MAX_CONCURRENT} uploads are read at once in the process: another tenant's is a 503 meanwhile`, async () => {
    const tenants = [owner, ...others];
    tenants.forEach((tenant, i) => customerCompany(`co_${i}`, tenant));
    const inFlight = tenants.slice(0, EVIDENCE_MAX_CONCURRENT).map((tenant, i) => {
      const file = pdf(`file ${i}`);
      const held = heldBody(file);
      return { held, response: upload(tenant, `co_${i}`, held.stream, { sha256: hexOf(file) }) };
    });
    await Promise.all(inFlight.map((u) => u.held.reading));

    const last = tenants.length - 1;
    expect(
      await refusalOf(await upload(tenants[last]!, `co_${last}`, pdf("one more"))),
    ).toMatchObject({ status: 503, code: "unavailable" });

    for (const u of inFlight) u.held.release();
    for (const u of inFlight) expect((await u.response).status).toBe(201);
    expect((await upload(tenants[last]!, `co_${last}`, pdf("one more"))).status).toBe(201);
  });

  test("before any byte is read, each check refuses in its order, ahead of every later one", async () => {
    // The owner and three more tenants each have an upload being read: the owner is busy, and the
    // process is full.
    const tenants = [owner, ...others.slice(0, EVIDENCE_MAX_CONCURRENT - 1)];
    tenants.forEach((tenant, i) => customerCompany(`co_${i}`, tenant));
    const inFlight = tenants.map((tenant, i) => {
      const file = pdf(`file ${i}`);
      const held = heldBody(file);
      return { held, response: upload(tenant, `co_${i}`, held.stream, { sha256: hexOf(file) }) };
    });
    await Promise.all(inFlight.map((u) => u.held.reading));

    // A company that fails every company check: another tenant's, filed through formation, and
    // abandoned. And the owner's own formation company and abandoned customer company.
    formationCompany("co_theirs", stranger);
    expect(companies.setStatus("co_theirs", "ready", "abandoned")).toBe(true);
    formationCompany("co_formation");
    expect(companies.setStatus("co_formation", "ready", "abandoned")).toBe(true);
    customerCompany("co_abandoned");
    expect(companies.setStatus("co_abandoned", "draft", "abandoned")).toBe(true);

    const tooLong = { "content-length": String(EVIDENCE_MAX_BYTES + 1) };
    const badQuery = `kind=passport&sha256=${"z".repeat(64)}`;
    const file = pdf("never read");
    const steps: [string, string, UploadOptions, number, string][] = [
      [
        "ownership",
        "co_theirs",
        { contentType: "text/plain", query: badQuery, headers: tooLong },
        404,
        "not_found",
      ],
      [
        "provider",
        "co_formation",
        { contentType: "text/plain", query: badQuery, headers: tooLong },
        409,
        "conflict",
      ],
      [
        "status",
        "co_abandoned",
        { contentType: "text/plain", query: badQuery, headers: tooLong },
        404,
        "not_found",
      ],
      [
        "content type",
        "co_0",
        { contentType: "text/plain", query: badQuery, headers: tooLong },
        415,
        "unsupported_media_type",
      ],
      ["kind and sha256", "co_0", { query: badQuery, headers: tooLong }, 400, "validation_error"],
      [
        "declared length",
        "co_0",
        { sha256: hexOf(file), headers: tooLong },
        413,
        "payload_too_large",
      ],
      ["one per tenant", "co_0", { sha256: hexOf(file) }, 429, "rate_limited"],
    ];
    for (const [step, companyId, opts, status, code] of steps) {
      const body = watchedBody(file);
      const refused = await refusalOf(await upload(owner, companyId, body.stream, opts));
      expect(refused, step).toMatchObject({ status, code });
      expect(body.pulled(), step).toBe(false);
    }
    // The process limit, for a tenant with nothing in flight.
    customerCompany("co_free", stranger);
    const body = watchedBody(file);
    expect(
      await refusalOf(await upload(stranger, "co_free", body.stream, { sha256: hexOf(file) })),
    ).toMatchObject({ status: 503, code: "unavailable" });
    expect(body.pulled()).toBe(false);

    for (const u of inFlight) u.held.release();
    for (const u of inFlight) expect((await u.response).status).toBe(201);
    expect(
      uploadRows()
        .map((r) => r.company_id)
        .sort(),
    ).toEqual(["co_0", "co_1", "co_2", "co_3"]);
  });
});

// ── the download of an upload ──────────────────────────────────────────────────────────────────

describe("the document routes", () => {
  test("a download of an expired upload is a 410, decided before the store is read; it is still listed with its hash; a provider document's missing file is still a 404", async () => {
    customerCompany("co_1");
    const file = pdf("expires");
    const { docId } = await (await upload(owner, "co_1", file)).json();
    expect(companies.setStatus("co_1", "draft", "abandoned")).toBe(true);
    nowMs += EVIDENCE_RETENTION_SECONDS * 1000;
    expect(expire()).toBe(1);

    expect(await refusalOf(await get(owner, `/companies/co_1/documents/${docId}`))).toMatchObject({
      status: 410,
      code: "gone",
    });
    const listed = await (await get(owner, "/companies/co_1/documents")).json();
    expect(listed.documents).toEqual([
      expect.objectContaining({ id: docId, sha256: `0x${hexOf(file)}` }),
    ]);

    // Marked deleted while its file is still in the store: gone all the same, the row decides.
    customerCompany("co_2");
    const second = await (await upload(owner, "co_2", pdf("marked"))).json();
    expect(documents.markBytesDeleted(second.docId, Math.floor(nowMs / 1000))).toBe(true);
    const path = documents.findOwned("co_2", second.docId)!.path;
    expect(docStore.files.has(path)).toBe(true);
    const reads = vi.spyOn(docStore, "getBytesAsync");
    expect(
      await refusalOf(await get(owner, `/companies/co_2/documents/${second.docId}`)),
    ).toMatchObject({ status: 410, code: "gone" });
    expect(reads).not.toHaveBeenCalled();

    // A provider's document whose file is missing keeps its 404.
    formationCompany("co_formation");
    const id = documentIndexId("co_formation", "d-gone");
    documents.insert({
      id,
      companyId: "co_formation",
      docType: "OperatingAgreement",
      sha256: "c".repeat(64),
      contentType: "application/pdf",
      size: 10,
      providerDocId: "d-gone",
      path: "doc-does-not-exist.pdf",
    });
    expect(
      await refusalOf(await get(owner, `/companies/co_formation/documents/${id}`)),
    ).toMatchObject({ status: 404, code: "not_found" });
  });
});

// ── the composition ────────────────────────────────────────────────────────────────────────────

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file.
 * What it protects: the doors write uploads through the SAME index and file store the document
 * routes read, so a tenant downloads its upload through the route that serves every document.
 */
test("the composition root hands the doors the index and the file store it gives the document routes", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  expect(main).toMatch(/^ {2}const docStore = new FileDocumentStore\(cfg\.docStoreDir\);$/m);
  expect(main).toMatch(
    /^ {2}const formationDocuments = new SqliteDocumentIndexRepository\(db\);$/m,
  );
  const doorsAt = main.indexOf("const customerCompanies =");
  expect(doorsAt, "the doors' dependencies were not found").toBeGreaterThan(0);
  const doors = main.slice(doorsAt, main.indexOf(": undefined;", doorsAt));
  expect(doors).toMatch(/^ {10}documents: formationDocuments,$/m);
  expect(doors).toMatch(/^ {10}docStore,$/m);
  const viewDepsAt = main.indexOf("const entityViewDeps = {");
  expect(main.slice(viewDepsAt, main.indexOf("};", viewDepsAt))).toMatch(
    /^ {4}documents: formationDocuments,$/m,
  );
});
