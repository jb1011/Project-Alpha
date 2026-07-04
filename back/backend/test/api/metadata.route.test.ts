import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

const PUBLIC_ID = "22222222-2222-2222-2222-222222222222";
const KEY = "0xAAA:agent";
let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;

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
  return buildApiApp({ webOrigin: "https://app.example.com", repo, docStore } as never);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
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
