/**
 * C8: the two read surfaces describe the same entity the same way.
 *
 * `GET /entities/:id` and the MCP `get_entity` tool render the SAME projection, and they used to
 * be wired separately: `ApiDeps` carried the document lookup, `mountMcpRoute` listed the view
 * deps one by one, and it forgot that one. Nothing errored. An agent reading its own legal body
 * over MCP was simply told it had no legal documents, while a browser reading the same entity
 * over REST was shown two — and the agent surface is the one nobody watches.
 *
 * The fix is structural (both dep types now extend `EntityViewDeps`, and the composition root
 * builds one object), and this is the behavioural half of it.
 */
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import {
  COMPANY_KEY,
  ENTITY_KEY,
  MemoryDocumentStore,
  formedEntity,
  seedCompany,
} from "../helpers/formationFakes";
import { startMcpTestClient } from "./helpers";

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const OWNER = getAddress("0x000000000000000000000000000000000000000a");
const PDF = Buffer.from("%PDF-1.7\nArticles\n");

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let documents: SqliteDocumentIndexRepository;
let requests: SqliteFormationRepository;
let apiKeys: SqliteApiKeyStore;
let docStore: MemoryDocumentStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  seedCompany(companies);
  documents = new SqliteDocumentIndexRepository(db);
  requests = new SqliteFormationRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  docStore = new MemoryDocumentStore();
});
afterEach(() => db.close());

function app() {
  // The composition root builds these ONCE and hands the same object to both surfaces; this is
  // the same object, spread the same way.
  const entityViewDeps = {
    formationSteps: (companyId: string) => requests.stepsOf(companyId),
    company: (companyId: string) => companies.find(companyId),
    companies,
    // §7's sharing label: the SAME store, narrowed by `EntityViewDeps` to the two counting reads.
    companyAgents: companies,
    documents,
  };
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    docStore,
    apiKeys,
    ...entityViewDeps,
  } as never);
}

function storeDoc(docId: string, docType: string) {
  const path = documentStoreName(COMPANY_KEY, docType, docId);
  docStore.putBytes(path, PDF);
  documents.insert({
    id: documentIndexId(COMPANY_KEY, docId),
    companyId: COMPANY_KEY,
    docType,
    sha256: "a".repeat(64),
    contentType: "application/pdf",
    size: PDF.length,
    providerDocId: docId,
    path,
  });
}

test("C8: MCP get_entity lists the SAME documents as REST", async () => {
  repo.upsert(formedEntity({ ownerTenantId: OWNER }));
  requests.claimAllSteps(COMPANY_KEY);
  requests.transition(COMPANY_KEY, "create_provider", "pending", "confirmed", {
    providerRef: "cmp-1",
  });
  storeDoc("d-aoo", "ArticlesOfOrganization");
  storeDoc("d-oa", "OperatingAgreement");

  const a = app();

  const { token } = await signSession(OWNER, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  const rest = await (
    await a.request(`/entities/${encodeURIComponent(ENTITY_KEY)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();

  const { key } = apiKeys.mint(OWNER, { capability: "read" });
  const mcp = await startMcpTestClient(a, key);
  try {
    const out = await mcp.client.callTool({
      name: "get_entity",
      arguments: { id: ENTITY_KEY },
    });
    const text = (out as { content: { text: string }[] }).content[0]!.text;
    const view = JSON.parse(text);

    // Both actually SAW the documents — an assertion that both returned `[]` would pass on the
    // bug this test exists for.
    expect(rest.formation.documents.map((d: { type: string }) => d.type).sort()).toEqual([
      "ArticlesOfOrganization",
      "OperatingAgreement",
    ]);
    // …and byte-for-byte the same projection on both surfaces.
    expect(view.formation.documents).toEqual(rest.formation.documents);
    expect(view.formation.status).toBe(rest.formation.status);
    expect(view.formation.providerRef).toBe(rest.formation.providerRef);
  } finally {
    await mcp.close();
  }
});

test("§7 SHARING LABELS: `sharedWith` is on BOTH read surfaces, and it is the TOTAL", async () => {
  // The three MCP entity tools mirror `EntityView`, which is the whole point of one projection
  // over one dependency object — the asymmetry this file exists for was a MISSING field on the
  // agent surface, and a label the browser has and an agent does not is the same bug again.
  repo.upsert(formedEntity({ ownerTenantId: OWNER }));
  repo.upsert(
    formedEntity({
      idempotencyKey: "tenant-a:agent-2",
      publicId: "44444444-4444-4444-4444-444444444444",
      ownerTenantId: OWNER,
    }),
  );

  const a = app();
  const { token } = await signSession(OWNER, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  const one = await (
    await a.request(`/entities/${encodeURIComponent(ENTITY_KEY)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  // TWO agents share this filing, and the field is the TOTAL including the one being read —
  // "shared with 1 other" is a subtraction a renderer makes once, at the edge, where the
  // sentence is written. An off-by-one in the FIELD is one every renderer inherits.
  expect(one.formation.sharedWith).toBe(2);
  expect(one.formation.companyId).toBe(COMPANY_KEY);

  // …and the LIST path, which counts in one grouped scan rather than per row.
  const list = await (
    await a.request("/entities", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(list.map((e: { formation: { sharedWith: number } }) => e.formation.sharedWith)).toEqual([
    2, 2,
  ]);

  const { key } = apiKeys.mint(OWNER, { capability: "read" });
  const mcp = await startMcpTestClient(a, key);
  try {
    for (const [tool, args] of [
      ["get_entity", { id: ENTITY_KEY }],
      ["list_entities", {}],
    ] as const) {
      const out = await mcp.client.callTool({ name: tool, arguments: args });
      const parsed = JSON.parse((out as { content: { text: string }[] }).content[0]!.text);
      const view = Array.isArray(parsed) ? parsed[0] : parsed;
      expect(view.formation.sharedWith, tool).toBe(2);
    }
  } finally {
    await mcp.close();
  }
});
