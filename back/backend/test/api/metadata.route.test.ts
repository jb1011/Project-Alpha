import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { EntityRecord } from "../../src/types";

const PUBLIC_ID = "22222222-2222-2222-2222-222222222222";
const KEY = "0xAAA:agent";
let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
let requests: SqliteFormationRepository;

const rec: EntityRecord = {
  idempotencyKey: KEY,
  name: "A",
  status: "bound",
  manager: "0x0000000000000000000000000000000000000001",
  guardian: "0x0000000000000000000000000000000000000002",
  operator: null,
  amendmentDelay: "0",
  ein: "",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: null,
  proxy: null,
  treasury: null,
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  publicId: PUBLIC_ID,
};

function app() {
  return buildApiApp({
    webOrigin: "https://app.example.com",
    repo,
    docStore,
    formationSteps: (k: string) => requests.stepsOf(k),
  } as never);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  requests = new SqliteFormationRepository(db);
  docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "meta-")));
  repo.upsert(rec);
  docStore.put(
    `meta-${KEY}.json`,
    JSON.stringify({ name: "A", legalBody: { jurisdiction: "WY" } }),
  );
});
afterEach(() => db.close());

test("serves the metadata JSON with NO auth header", async () => {
  const res = await app().request(`/metadata/${PUBLIC_ID}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = await res.json();
  expect(body).toMatchObject({ name: "A" });
  expect(body).not.toHaveProperty("ein");
});

test("unknown + malformed ids both 404", async () => {
  expect((await app().request("/metadata/33333333-3333-3333-3333-333333333333")).status).toBe(404);
  expect((await app().request("/metadata/not-a-uuid")).status).toBe(404);
});

test("a record whose file is missing 404s (not 500)", async () => {
  repo.upsert({
    ...rec,
    idempotencyKey: "0xBBB:agent",
    publicId: "44444444-4444-4444-4444-444444444444",
  });
  expect((await app().request("/metadata/44444444-4444-4444-4444-444444444444")).status).toBe(404);
});

test("cross-origin OPTIONS preflight to /metadata gets ACAO: *", async () => {
  const res = await app().request(`/metadata/${PUBLIC_ID}`, {
    method: "OPTIONS",
    headers: { Origin: "https://other.example.com", "Access-Control-Request-Method": "GET" },
  });
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});

test("the served metadata NEVER carries the EIN or anything about the natural person (§8)", async () => {
  // The record holds the real EIN and the filing facts, and a party row holds real PII…
  repo.upsert({
    ...rec,
    formationProvider: "doola",
    formationEnvironment: "sandbox",
    einReal: "98-7654321",
    formationFilingNumber: "2026-123456",
  });
  db.prepare(
    `INSERT INTO formation_parties (party_id, entity_key, tenant_id, legal_first_name,
       legal_last_name, email, line1, city, postal_code, country)
     VALUES ('p1', ?, '0xAAA', 'Ada', 'Lovelace', 'ada@example.com', '1 Analytical Way',
             'Cheyenne', '82001', 'USA')`,
  ).run(KEY);
  docStore.put(`meta-${KEY}.json`, JSON.stringify({ name: "A", type: "agent" }));

  // …and this route is UNAUTHENTICATED, so none of it may appear.
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).text();
  for (const forbidden of [
    "98-7654321",
    "2026-123456",
    "Ada",
    "Lovelace",
    "ada@example.com",
    "Analytical",
    "82001",
    "p1",
  ])
    expect(body).not.toContain(forbidden);
});

// ── serve-time layering (design §8, audit M10) ─────────────────────────────────────────────

test("formation status is layered from the DB at SERVE time, not frozen at translate", async () => {
  repo.upsert({ ...rec, formationProvider: "doola", formationEnvironment: "sandbox" });
  // The stored JSON was written during translate and knows nothing about any of this.
  docStore.put(
    `meta-${KEY}.json`,
    JSON.stringify({ name: "A", legalBody: { jurisdiction: "WY" } }),
  );

  const before = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(before.formation).toEqual({ environment: "sandbox", status: "none" });

  // Time passes; the state files the company.
  requests.claimAllSteps(KEY);
  requests.transition(KEY, "create_provider", "pending", "confirmed", { providerRef: "cmp-1" });
  requests.transition(KEY, "await_filing", "pending", "confirmed");

  const after = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(after.formation).toEqual({ environment: "sandbox", status: "filed" });
});

test("the formation block carries the environment and NOTHING that could identify anyone", async () => {
  repo.upsert({
    ...rec,
    formationProvider: "doola",
    formationEnvironment: "sandbox",
    einReal: "98-7654321",
    formationFilingNumber: "2026-123456",
  });
  requests.claimAllSteps(KEY);
  requests.transition(KEY, "create_provider", "pending", "confirmed", {
    providerRef: "cmp-secret",
  });

  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  // Exactly two keys. A sandbox filing can never be published without its qualifier, and no
  // provider reference, EIN or filing number reaches an unauthenticated surface.
  expect(Object.keys(body.formation).sort()).toEqual(["environment", "status"]);
  expect(JSON.stringify(body)).not.toContain("cmp-secret");
});

test("a legacy/stub entity gets NO formation block at all", async () => {
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body).not.toHaveProperty("formation");
});

test("a manifest-scheme entity serves the CURRENT anchor, not the one translate rendered", async () => {
  repo.upsert({ ...rec, oaHash: "0xv2hash", oaManifestVersion: 2 });
  // What translate wrote, months and one timelocked amendment ago.
  docStore.put(
    `meta-${KEY}.json`,
    JSON.stringify({ name: "A", legalBody: { jurisdiction: "WY", oaHash: "0xv1hash" } }),
  );

  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  // A verifier compares this against LegalManager.meta.operatingAgreementHash. Serving the stale
  // value would publish an anchor the chain has already moved past.
  expect(body.legalBody.oaHash).toBe("0xv2hash");
  expect(body.legalBody.manifestVersion).toBe(2);
  expect(JSON.stringify(body)).not.toContain("0xv1hash");
});

test("a LEGACY (document-scheme) entity's stored oaHash is left exactly as it was", async () => {
  // The legacy anchor commits to the OA document and nothing ever amends it, so there is nothing
  // to track — and rewriting it would be inventing a manifest version that does not exist.
  repo.upsert({ ...rec, oaHash: "0xdochash" });
  docStore.put(
    `meta-${KEY}.json`,
    JSON.stringify({ name: "A", legalBody: { jurisdiction: "WY", oaHash: "0xdochash" } }),
  );
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body.legalBody.oaHash).toBe("0xdochash");
  expect(body.legalBody).not.toHaveProperty("manifestVersion");
});

test("a stored body with no legalBody object is served without one being invented", async () => {
  repo.upsert({ ...rec, oaHash: "0xv2hash", oaManifestVersion: 2 });
  docStore.put(`meta-${KEY}.json`, JSON.stringify({ name: "A" }));
  const res = await app().request(`/metadata/${PUBLIC_ID}`);
  expect(res.status).toBe(200);
  expect(await res.json()).not.toHaveProperty("legalBody");
});
