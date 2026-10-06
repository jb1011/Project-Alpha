/**
 * The doors for a customer's own company on REST, and the company view that describes one.
 *
 * Three doors, mounted only where the deployment wires their dependencies: ask for the statement
 * of authority to sign, create the company from the signed statement, and abandon it. Each takes a
 * body of at most 8 KiB. Asking for the statement runs the human, wording, synthetic and field
 * checks before anything is rendered, and writes nothing.
 *
 * The view of a customer's company carries three keys more than a formation company's: `provider`,
 * `declared` (what was declared, without the declarant) and `verification` (the operator's latest
 * verdict). A formation company's view keeps exactly the keys it has always had, and the two
 * surfaces, REST and MCP, render the same body.
 *
 * Every name, company and filing number here is an invention, and the keys are anvil's published
 * test accounts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { toCompanyView } from "../../src/api/views";
import { signSession } from "../../src/auth/session";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { CustomerCompanyDeps } from "../../src/legalBody/customerCompany";
import type { LegalText } from "../../src/legalBody/texts/index";
import {
  STATEMENT_OF_AUTHORITY,
  type StatementFields,
} from "../../src/legalBody/texts/statementOfAuthority";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  APPROVED,
  CHAIN_ID,
  FACTORY,
  FORMATION_PROVIDER,
  SANDBOX_TYPED,
  type Signer,
  customerCompanyDeps,
  recordHuman as recordHumanIn,
  sandboxCustomerCompanyDeps,
} from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import { startMcpTestClient } from "../mcp/helpers";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. */
const owner = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
/** The largest body the doors read, in bytes. */
const MAX_BODY = 8 * 1024;

const STATEMENT_MESSAGE = "/companies/customer/statement-message";
const CREATE = "/companies/customer";
const abandonPath = (companyId: string) => `/companies/${companyId}/abandon`;

/** A declaration as a production caller types it. */
const TYPED = {
  declarantName: "Ada Example",
  declarantTitle: "Authorised Signatory",
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
};

/** A formation company's list row, key for key: the set the formation tests pin. */
const LIST_KEYS = [
  "agents",
  "businessPurpose",
  "companyId",
  "createdAt",
  "environment",
  "filedAt",
  "filingNumber",
  "industryLabel",
  "legalNameFiled",
  "nameOptions",
  "state",
];
/** A formation company's detail view, key for key. */
const DETAIL_KEYS = [
  ...LIST_KEYS,
  "status",
  "synthetic",
  "formationStatus",
  "paying",
  "attachedAgents",
  "documents",
  "ein",
  "intakeSynthesized",
  "park",
  "providerRef",
  "requiredActions",
].sort();
/** The three keys a customer's company carries besides. */
const CUSTOMER_KEYS = ["declared", "provider", "verification"];

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let store: SqliteWorldStore;
let apiKeys: SqliteApiKeyStore;
/** The doors' clock, in milliseconds: the real time, so the database's own clock agrees with it. */
let nowMs: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  store = new SqliteWorldStore(db);
  apiKeys = new SqliteApiKeyStore(db);
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  // A created company writes an ops line: kept off stdout here.
  vi.spyOn(console, "log").mockImplementation(() => {});
  recordHuman(owner.address, "1001");
  recordHuman(stranger.address, "1002");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const nowSeconds = (): number => Math.floor(nowMs / 1000);

/** A verification row, recorded as the verify route records one, at the doors' clock. */
function recordHuman(tenantId: Address, nullifier: string, credential?: string): void {
  recordHumanIn(store, tenantId, nullifier, nowMs, credential);
}

const stores = () => ({ db, companies, declarations, checks, store });

/** The doors of a production deployment that charges, serving the approved wording. */
function doors(over: Partial<CustomerCompanyDeps> = {}): CustomerCompanyDeps {
  return customerCompanyDeps(stores(), () => nowMs, over);
}

/** The doors of a sandbox deployment: the draft wording, and a World configuration that is not
 *  production. */
function sandboxDoors(over: Partial<CustomerCompanyDeps> = {}): CustomerCompanyDeps {
  return sandboxCustomerCompanyDeps(stores(), () => nowMs, over);
}

/** A wording that counts how often it is rendered, so a refusal can be shown to come first. */
function counting(base: LegalText<StatementFields>): {
  text: LegalText<StatementFields>;
  renders: () => number;
} {
  let renders = 0;
  return {
    text: {
      ...base,
      render: (fields: StatementFields) => {
        renders += 1;
        return base.render(fields);
      },
    },
    renders: () => renders,
  };
}

/**
 * The API over this test's database. The customer facts are wired whatever the doors, as the
 * composition root wires them; the doors only when `customerCompanies` is given, with the document
 * index and store the document routes read. The MCP surface reads the same object.
 */
function makeApp(customerCompanies?: CustomerCompanyDeps) {
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new DeletableMemoryDocumentStore();
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo,
    companies,
    documents,
    docStore,
    customerFacts: { declarations, checks },
    customerCompanies: customerCompanies && { ...customerCompanies, documents, docStore },
    apiKeys,
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
type App = ReturnType<typeof makeApp>;

async function sessionOf(who: Signer): Promise<string> {
  const { token } = await signSession(who.address, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

async function post(
  app: App,
  path: string,
  token: string | undefined,
  body?: string | object,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function get(app: App, path: string, token: string): Promise<Response> {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

/** What the owner's client does: ask for the statement, have the guardian's wallet sign the typed
 *  data as it arrived, and send the declaration back with the signature. Answers the new id. */
async function declared(app: App, token: string, typed: object = TYPED): Promise<string> {
  const asked = await post(app, STATEMENT_MESSAGE, token, typed);
  expect(asked.status).toBe(200);
  const { typedData } = await asked.json();
  const signature = await owner.signTypedData(typedData);
  const res = await post(app, CREATE, token, {
    ...typed,
    issuedAt: typedData.message.issuedAt,
    signature,
  });
  expect(res.status).toBe(201);
  return (await res.json()).companyId;
}

/** The refusal envelope, and the raw text, to show what it does not carry. */
async function refusalOf(
  res: Response,
): Promise<{ status: number; code: string; details: unknown; text: string; body: object }> {
  const text = await res.text();
  const body = JSON.parse(text);
  return { status: res.status, code: body.error?.code, details: body.error?.details, text, body };
}

const countRows = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const textOf = (res: unknown) => (res as { content: { text: string }[] }).content[0]?.text ?? "";

// ── where the doors exist ──────────────────────────────────────────────────────────────────────

describe("the doors are mounted only with their dependencies", () => {
  test("without them the three doors are 404, and a customer company declared earlier keeps its view", async () => {
    const token = await sessionOf(owner);
    // Declared while the doors were on...
    const companyId = await declared(makeApp(doors()), token);

    // ...then served by an app over the same database with the doors switched off.
    const off = makeApp();
    expect((await post(off, STATEMENT_MESSAGE, token, TYPED)).status).toBe(404);
    expect((await post(off, CREATE, token, TYPED)).status).toBe(404);
    expect((await post(off, abandonPath(companyId), token)).status).toBe(404);
    expect(companies.find(companyId)?.status).toBe("draft");

    const res = await get(off, `/companies/${companyId}`, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: "customer",
      declared: {
        companyName: "Example Holdings LLC",
        filingNumber: "TEST-0001",
        wordingVersion: APPROVED.version,
      },
      verification: { state: "awaiting_check", checkedAt: null, reasonCode: null },
    });
  });

  test("each door answers a caller with no session with 401", async () => {
    const app = makeApp(doors());
    for (const path of [STATEMENT_MESSAGE, CREATE, abandonPath("any-company")])
      expect((await post(app, path, undefined, TYPED)).status, path).toBe(401);
  });

  /**
   * The composition root has no injectable seam for its own wiring (it boots against a chain), so
   * this reads the file, as the boot-order guard does. What it protects: the view facts are built
   * whatever the configuration, so a customer company keeps its view with the legal-body feature
   * off, and the doors exist only behind their one predicate. The two legal-body reads (is one of
   * the company's bodies linked, is one open) come from the legal-body store, which exists only
   * where the feature is on.
   */
  test("the composition root wires the view facts always, and the doors only behind customerDoorsEnabled; the legal-body reads come from the legal-body store", () => {
    const main = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "api", "main.ts"),
      "utf8",
    );
    // Built in the body of the boot function, under no condition.
    expect(main).toMatch(
      /^ {2}const companyDeclarations = new SqliteCompanyDeclarationRepository\(db\);$/m,
    );
    expect(main).toMatch(/^ {2}const companyChecks = new SqliteCompanyCheckRepository\(db\);$/m);
    const viewDepsAt = main.indexOf("const entityViewDeps = {");
    expect(viewDepsAt, "the view dependencies were not found").toBeGreaterThan(0);
    const viewDeps = main.slice(viewDepsAt, main.indexOf("};", viewDepsAt));
    // A property of the view dependencies in its own right, not a branch of a condition, with its
    // declarations and checks as its first two members.
    expect(viewDeps).toMatch(
      /^ {4}customerFacts: \{\n {6}declarations: companyDeclarations,\n {6}checks: companyChecks,$/m,
    );
    // Its linked-body read, only where the legal-body store is.
    expect(viewDeps).toMatch(
      /^ {6}\.\.\.\(legalBodies\n\s+\? \{ hasLinkedLegalBody: \(companyId: string\) => legalBodies\.hasLinkedForCompany\(companyId\) \}\n\s+: \{\}\),$/m,
    );
    // The store: only with the legal-body factory and the controller.
    expect(main).toMatch(
      /^ {2}const legalBodies =\s+cfg\.legalBodyFactory && cfg\.controllerAddress \? new SqliteLegalBodyRepository\(db\) : undefined;$/m,
    );
    expect(main).toMatch(
      /const customerCompanies =\s+cfg\.legalBodyFactory && customerDoorsEnabled\(cfg\)/,
    );
    // The doors ask the store whether a company stands behind an open legal body.
    const doorsAt = main.indexOf("const customerCompanies =");
    expect(main.slice(doorsAt, main.indexOf(": undefined;", doorsAt))).toMatch(
      /hasOpenLegalBody: \(companyId: string\) =>\s+legalBodies === undefined \|\| legalBodies\.hasOpenForCompany\(companyId, Date\.now\(\)\),/,
    );
  });
});

// ── asking for the statement, and creating the company from it ────────────────────────────────

describe("asking for the statement, signing it and creating the company", () => {
  test("on production: the signed statement creates the company (201), and the same body again answers the same id (200)", async () => {
    const app = makeApp(doors());
    const token = await sessionOf(owner);

    const asked = await post(app, STATEMENT_MESSAGE, token, TYPED);
    expect(asked.status).toBe(200);
    const served = await asked.json();
    expect(Object.keys(served).sort()).toEqual(["textStatus", "typedData", "wordingVersion"]);
    expect(served.wordingVersion).toBe(APPROVED.version);
    expect(served.textStatus).toBe("approved");
    // Exactly what the wallet is asked to sign, written out here on its own.
    const fields: StatementFields = { ...TYPED, jurisdiction: "WY", guardian: owner.address };
    expect(served.typedData).toEqual({
      domain: {
        name: "Novi Corpus Statement of Authority",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: FACTORY,
      },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        StatementOfAuthority: [
          { name: "statement", type: "string" },
          { name: "declarantName", type: "string" },
          { name: "declarantTitle", type: "string" },
          { name: "companyName", type: "string" },
          { name: "jurisdiction", type: "string" },
          { name: "filingNumber", type: "string" },
          { name: "guardian", type: "address" },
          { name: "wordingVersion", type: "string" },
          { name: "issuedAt", type: "uint256" },
        ],
      },
      primaryType: "StatementOfAuthority",
      message: {
        ...fields,
        statement: APPROVED.render(fields),
        wordingVersion: APPROVED.version,
        issuedAt: String(nowSeconds()),
      },
    });
    // JSON-safe: the time is decimal text and the chain id a number. A bigint anywhere in it could
    // not have been serialised into this response at all.
    expect(typeof served.typedData.message.issuedAt).toBe("string");
    expect(typeof served.typedData.domain.chainId).toBe("number");
    // Asking writes nothing.
    expect(countRows("companies")).toBe(0);
    expect(countRows("company_declarations")).toBe(0);

    // The guardian's wallet signs the typed data exactly as it arrived.
    const signature = await owner.signTypedData(served.typedData);
    const body = { ...TYPED, issuedAt: served.typedData.message.issuedAt, signature };
    const created = await post(app, CREATE, token, body);
    expect(created.status).toBe(201);
    const first = await created.json();
    expect(Object.keys(first)).toEqual(["companyId"]);

    // A retry after a lost response: the same statement and signature answer the same company.
    const again = await post(app, CREATE, token, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(companies.listByTenant(owner.address).map((c) => c.companyId)).toEqual([
      first.companyId,
    ]);
    expect(declarations.find(first.companyId)?.signature).toBe(signature);
    expect(companies.find(first.companyId)).toMatchObject({
      provider: "customer",
      status: "draft",
    });
  });

  test("on a sandbox: the draft wording is served, the declarant is the sandbox fixture, and the company is created", async () => {
    const app = makeApp(sandboxDoors({ paymentRequired: false }));
    const token = await sessionOf(owner);

    const served = await (await post(app, STATEMENT_MESSAGE, token, SANDBOX_TYPED)).json();
    expect(served.textStatus).toBe("draft");
    expect(served.wordingVersion).toBe(STATEMENT_OF_AUTHORITY.version);
    expect(served.typedData.message).toMatchObject({
      declarantName: "Novi Sandbox Declarant",
      declarantTitle: "Manager",
      companyName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
    });

    const companyId = await declared(app, token, SANDBOX_TYPED);
    expect(companies.find(companyId)).toMatchObject({
      provider: "customer",
      environment: "sandbox",
      synthetic: true,
      status: "ready",
    });
  });

  test("the create door answers a draft wording on production as legal_text_not_approved (503)", async () => {
    const app = makeApp(doors({ text: STATEMENT_OF_AUTHORITY }));
    const refused = await refusalOf(
      await post(app, CREATE, await sessionOf(owner), {
        ...TYPED,
        issuedAt: String(nowSeconds()),
        signature: `0x${"ab".repeat(65)}`,
      }),
    );
    expect(refused).toMatchObject({ status: 503, code: "legal_text_not_approved" });
    expect(countRows("companies")).toBe(0);
  });

  test("a body that is not JSON is a validation error on both doors that read one", async () => {
    const app = makeApp(doors());
    const token = await sessionOf(owner);
    for (const path of [STATEMENT_MESSAGE, CREATE]) {
      const refused = await refusalOf(await post(app, path, token, "{not json"));
      expect(refused, path).toMatchObject({ status: 400, code: "validation_error" });
    }
  });
});

// ── what the statement door refuses, before rendering anything ─────────────────────────────────

describe("asking for the statement refuses before anything is rendered", () => {
  test("a guardian verified by a waiver", async () => {
    recordHuman(waived.address, "1003", "waiver");
    const wording = counting(APPROVED);
    const app = makeApp(doors({ text: wording.text }));
    const refused = await refusalOf(
      await post(app, STATEMENT_MESSAGE, await sessionOf(waived), TYPED),
    );
    expect(refused).toMatchObject({ status: 403, code: "waiver_not_accepted" });
    expect(refused.body).not.toHaveProperty("typedData");
    expect(wording.renders()).toBe(0);
  });

  test("a draft wording on production", async () => {
    const wording = counting(STATEMENT_OF_AUTHORITY);
    const app = makeApp(doors({ text: wording.text }));
    const refused = await refusalOf(
      await post(app, STATEMENT_MESSAGE, await sessionOf(owner), TYPED),
    );
    expect(refused).toMatchObject({ status: 503, code: "legal_text_not_approved" });
    expect(refused.body).not.toHaveProperty("typedData");
    expect(wording.renders()).toBe(0);
  });

  test("a sandbox declaration that does not say synthetic", async () => {
    const wording = counting(STATEMENT_OF_AUTHORITY);
    const app = makeApp(sandboxDoors({ text: wording.text }));
    const { synthetic: _left, ...unsaid } = SANDBOX_TYPED;
    const refused = await refusalOf(
      await post(app, STATEMENT_MESSAGE, await sessionOf(owner), unsaid),
    );
    expect(refused).toMatchObject({ status: 400, code: "synthetic_rule" });
    expect(refused.body).not.toHaveProperty("typedData");
    expect(wording.renders()).toBe(0);
  });

  test("a field that breaks its rule, named without its value; a valid request then renders once", async () => {
    const wording = counting(APPROVED);
    const app = makeApp(doors({ text: wording.text }));
    const token = await sessionOf(owner);
    const refused = await refusalOf(
      await post(app, STATEMENT_MESSAGE, token, { ...TYPED, filingNumber: "TEST 4242" }),
    );
    expect(refused).toMatchObject({ status: 400, code: "validation_error" });
    expect(refused.details).toEqual([{ field: "filingNumber", problem: expect.any(String) }]);
    expect(refused.text).not.toContain("4242");
    expect(refused.body).not.toHaveProperty("typedData");
    expect(wording.renders()).toBe(0);

    expect((await post(app, STATEMENT_MESSAGE, token, TYPED)).status).toBe(200);
    expect(wording.renders()).toBe(1);
    expect(countRows("companies")).toBe(0);
    expect(countRows("company_declarations")).toBe(0);
  });
});

// ── the body limit ─────────────────────────────────────────────────────────────────────────────

describe("each door takes a body of at most 8 KiB", () => {
  test("a 9 KiB body is refused on every door, by its declared length or by what arrives; 8 KiB is read", async () => {
    const app = makeApp(doors());
    const token = await sessionOf(owner);
    const nine = JSON.stringify({ ...TYPED, padding: "x".repeat(9 * 1024) });
    for (const path of [STATEMENT_MESSAGE, CREATE, abandonPath("any-company")]) {
      const refused = await refusalOf(await post(app, path, token, nine));
      expect(refused, path).toMatchObject({ status: 413, code: "payload_too_large" });
    }
    const declaredLength = await refusalOf(
      await post(app, STATEMENT_MESSAGE, token, nine, {
        "content-length": String(Buffer.byteLength(nine)),
      }),
    );
    expect(declaredLength).toMatchObject({ status: 413, code: "payload_too_large" });

    const room = MAX_BODY - Buffer.byteLength(JSON.stringify({ ...TYPED, padding: "" }));
    const exact = JSON.stringify({ ...TYPED, padding: "x".repeat(room) });
    expect(Buffer.byteLength(exact)).toBe(MAX_BODY);
    expect((await post(app, STATEMENT_MESSAGE, token, exact)).status).toBe(200);
    expect(countRows("companies")).toBe(0);
  });
});

// ── the view ───────────────────────────────────────────────────────────────────────────────────

describe("the company view", () => {
  test("another tenant's read of a customer company is the same 404 as an unknown id", async () => {
    const app = makeApp(doors());
    const companyId = await declared(app, await sessionOf(owner));
    const theirs = await get(app, `/companies/${companyId}`, await sessionOf(stranger));
    const unknown = await get(app, "/companies/no-such-company", await sessionOf(stranger));
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await theirs.json()).toEqual(await unknown.json());
    const listed = await (await get(app, "/companies", await sessionOf(stranger))).json();
    expect(listed.companies).toEqual([]);
  });

  test("the tenant's own view shows provider, declared and a verification awaiting its check, and no declarant; MCP answers the same", async () => {
    const app = makeApp(doors());
    const token = await sessionOf(owner);
    const companyId = await declared(app, token);

    const res = await get(app, `/companies/${companyId}`, token);
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(Object.keys(view).sort()).toEqual([...DETAIL_KEYS, ...CUSTOMER_KEYS].sort());
    expect(view.provider).toBe("customer");
    expect(view.declared).toEqual({
      companyName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
      wordingVersion: APPROVED.version,
    });
    expect(view.verification).toEqual({
      state: "awaiting_check",
      checkedAt: null,
      reasonCode: null,
    });
    const printed = JSON.stringify(view);
    for (const personal of [TYPED.declarantName, TYPED.declarantTitle, "declarant"])
      expect(printed).not.toContain(personal);

    // The list row carries the same three keys.
    const list = await (await get(app, "/companies", token)).json();
    expect(list.companies).toHaveLength(1);
    expect(Object.keys(list.companies[0]).sort()).toEqual([...LIST_KEYS, ...CUSTOMER_KEYS].sort());
    expect(list.companies[0]).toMatchObject({
      provider: "customer",
      declared: view.declared,
      verification: view.verification,
    });

    // The agent surface renders the same bodies.
    const { key } = apiKeys.mint(owner.address, { capability: "read" });
    const { client, close } = await startMcpTestClient(app, key);
    try {
      const overMcp = await client.callTool({ name: "get_company", arguments: { companyId } });
      expect(JSON.parse(textOf(overMcp))).toEqual(view);
      const listed = await client.callTool({ name: "list_companies", arguments: {} });
      expect(JSON.parse(textOf(listed))).toEqual(list);
    } finally {
      await close();
    }
  });

  test("the operator's latest check shows as its state, its time and its reason code, never its free text", async () => {
    const app = makeApp(doors());
    const token = await sessionOf(owner);
    const companyId = await declared(app, token);
    const reason = "the registry holds the name in another spelling";
    checks.append({
      companyId,
      result: "failed",
      operator: "operator.example",
      operatorOsUser: "operator",
      checkedAt: nowSeconds(),
      registryName: null,
      registryFilingId: null,
      registryStatus: null,
      formationDate: null,
      registeredAgent: null,
      existenceEvidenceSha256: null,
      controlEvidenceSha256: null,
      controlEvidenceKind: null,
      reasonCode: "name_mismatch",
      reason,
    });

    const view = await (await get(app, `/companies/${companyId}`, token)).json();
    expect(view.verification).toEqual({
      state: "failed",
      checkedAt: nowSeconds(),
      reasonCode: "name_mismatch",
    });
    expect(JSON.stringify(view)).not.toContain(reason);
    const list = await (await get(app, "/companies", token)).json();
    expect(list.companies[0].verification).toEqual(view.verification);
  });

  test("a formation company keeps exactly its keys, with the customer facts wired", async () => {
    const app = makeApp(doors());
    const token = await sessionOf(owner);
    const companyId = companies.create({
      tenantId: owner.address,
      status: "ready",
      provider: FORMATION_PROVIDER,
      environment: "sandbox",
      synthetic: false,
      nameOptions: [{ name: "Example Robotics", entityTypeEnding: "LLC", position: 1 }],
      businessPurpose: "Operating autonomous software agents.",
      industryLabel: "Software development",
      intakeSynthesized: false,
    });

    const view = await (await get(app, `/companies/${companyId}`, token)).json();
    expect(Object.keys(view).sort()).toEqual(DETAIL_KEYS);
    const list = await (await get(app, "/companies", token)).json();
    expect(Object.keys(list.companies[0]).sort()).toEqual(LIST_KEYS);
  });

  test("the three keys follow the company's provider: facts never add them, and their absence reads as null", async () => {
    const companyId = await declared(makeApp(doors()), await sessionOf(owner));
    const customer = companies.find(companyId)!;
    const formation = { ...customer, provider: FORMATION_PROVIDER };
    const facts = { declaration: declarations.find(companyId), latestCheck: undefined };

    // A formation company, even handed a customer's facts, keeps its key set.
    expect(Object.keys(toCompanyView(formation, [], false, 0, facts)).sort()).toEqual(LIST_KEYS);
    // A customer company with no facts still says what it is, and claims nothing about its check.
    expect(toCompanyView(customer, [], false, 0)).toMatchObject({
      provider: "customer",
      declared: null,
      verification: null,
    });
    // With them, the declaration and a check not made yet.
    expect(toCompanyView(customer, [], false, 0, facts)).toMatchObject({
      provider: "customer",
      declared: { companyName: "Example Holdings LLC" },
      verification: { state: "awaiting_check" },
    });
  });
});

// ── abandoning ─────────────────────────────────────────────────────────────────────────────────

describe("abandoning through the door", () => {
  test("answers 204, and a second call 409; another tenant gets the uniform 404", async () => {
    const app = makeApp(doors());
    const token = await sessionOf(owner);
    const companyId = await declared(app, token);

    const theirs = await refusalOf(
      await post(app, abandonPath(companyId), await sessionOf(stranger)),
    );
    const unknown = await refusalOf(await post(app, abandonPath("no-such-company"), token));
    expect(theirs).toMatchObject({ status: 404, code: "not_found" });
    expect(theirs.body).toEqual(unknown.body);
    expect(companies.find(companyId)?.status).toBe("draft");

    const first = await post(app, abandonPath(companyId), token);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    const second = await refusalOf(await post(app, abandonPath(companyId), token));
    expect(second).toMatchObject({ status: 409, code: "conflict" });

    expect(companies.find(companyId)?.status).toBe("abandoned");
    expect(declarations.find(companyId)?.declarantName).toBeNull();
    const view = await (await get(app, `/companies/${companyId}`, token)).json();
    expect(view.state).toBe("abandoned");
    expect(view.declared).toEqual({
      companyName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
      wordingVersion: APPROVED.version,
    });
  });
});
