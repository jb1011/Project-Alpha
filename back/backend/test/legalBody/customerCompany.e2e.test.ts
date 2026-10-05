/**
 * A customer's own company, end to end: declared, uploaded and paid for through the API's doors,
 * shown, checked, revoked and reinstated through the operator's commands. In each test the app and
 * the commands open ONE database file and ONE document store directory, both under a temporary
 * data directory, so every fact a command reads is one a door wrote, and the other way round.
 *
 * Two deployments, one per test:
 *  - a production deployment that charges, serving an approved wording under a production World ID
 *    configuration. Its declarant types a name and a title, so this is where the run shows where
 *    they go: into the declaration's table, the typed data the declarant asked to sign and the
 *    operator's `company:show`, and into no other answer, table, ops line or output;
 *  - a sandbox deployment that does not charge, where a passed check makes a company active at
 *    once. Its declarant is the sandbox fixture, never a name a caller typed.
 *
 * Every name, company and filing number is an invention, and the guardian's key is one of anvil's
 * published test accounts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { buildCli } from "../../src/cli/index";
import { companyUnavailableMessage } from "../../src/formation";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { attestationFactsFor, deriveAttestationState } from "../../src/legalBody/attestation";
import {
  type CustomerCompanyDeps,
  STALE_CUSTOMER_SECONDS,
  SYNTHETIC_DECLARANT,
  expireStaleCustomerCompanies,
} from "../../src/legalBody/customerCompany";
import { EVIDENCE_RETENTION_SECONDS, expireEvidenceBytes } from "../../src/legalBody/evidence";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import {
  SqliteCompanyDeclarationRepository,
  filingKeyOf,
} from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Hex } from "../../src/types";
import { OnboardingRunner } from "../../src/workflow/runner";
import {
  ANVIL_ACCOUNT_2,
  FORMATION_PROVIDER,
  SANDBOX_TYPED,
  customerCompanyDeps,
  recordHuman,
  sandboxCustomerCompanyDeps,
} from "../helpers/customerCompanyFixtures";
import { CHAIN_ID, fakeChain, paymentCfg } from "../helpers/formationPayment";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";

/** The guardian: anvil's published account #2, a test key, never a real wallet. */
const guardian = ANVIL_ACCOUNT_2;

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
/** An invented fee for a customer's company, in atomic USDC (6 decimals). */
const CUSTOMER_FEE = 7_000_000n;

/** The declarant's own words: typed on the production deployment, and nowhere else in this file. */
const DECLARANT_NAME = "Ada Example";
const DECLARANT_TITLE = "Example Managing Member";
const COMPANY_NAME = "Example Holdings LLC";
const FILING_NUMBER = "TEST-0001";
const TYPED = {
  declarantName: DECLARANT_NAME,
  declarantTitle: DECLARANT_TITLE,
  companyName: COMPANY_NAME,
  filingNumber: FILING_NUMBER,
};

const STATEMENT_MESSAGE = "/companies/customer/statement-message";
const CREATE = "/companies/customer";
const companyPath = (companyId: string) => `/companies/${companyId}`;
const requotePath = (companyId: string) => `/companies/${companyId}/payment/requote`;
const settlePath = (companyId: string) => `/companies/${companyId}/payment/settle`;

const OPERATOR = "ops.example";
/** The sha256 of the operator's own registry printout: any 64 hexadecimal digits. */
const PRINTOUT = `0x${"ab".repeat(32)}`;
/** What a customer's company is told while its latest check is anything but a pass. */
const NOT_CHECKED = "this company has not passed its check yet";
const DAY_SECONDS = 24 * 3600;

/** An agent of the full product, as an onboarding client asks for one. */
const AGENT_SPEC = {
  name: "Example Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {},
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000dDdd",
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
  legal: {},
  metadata: {},
};
const PASSKEY = { attestation: { credentialId: "cred-1" } };

/** A small PDF, different for every label. Only its first five bytes make it one. */
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF\n`, "latin1");
/** The sha256 as a client writes it on the wire: 64 hexadecimal digits. */
const hexOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

let dir: string;
let db: Database.Database;
/** Every answer the app gave, in order. */
let answers: { method: string; path: string; status: number; text: string }[];
/** Every console line written in the process (ops lines, warnings, and the commands' output). */
let printed: string[];
/** The positions in `printed` of the output of `company:show`. */
let shownAt: Set<number>;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "customer-company-e2e-"));
  // The commands find the database and the document store through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  answers = [];
  printed = [];
  shownAt = new Set();
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── The deployment ────────────────────────────────────────────────────────────────────────────

/**
 * One deployment over this test's database: the API app with the customer doors, the payment
 * doors and the onboarding door, as the composition root wires them, and the stores the test reads
 * the facts through. The document index and the file store are the same instances in the doors and
 * in the document routes, and the store is a directory the commands open too.
 */
function deploy(charging: boolean) {
  const companies = new SqliteCompanyRepository(db);
  const declarations = new SqliteCompanyDeclarationRepository(db);
  const checks = new SqliteCompanyCheckRepository(db);
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new FileDocumentStore(join(dir, "documents"));
  const payments = new SqliteFormationPaymentRepository(db);
  const requests = new SqliteFormationRepository(db);
  const parties = new SqliteFormationPartyRepository(db);
  const repo = new SqliteEntityRepository(db);
  const store = new SqliteWorldStore(db);
  const chain = fakeChain();
  const stores = { db, companies, declarations, checks, store };
  // Production: the approved wording and a production World ID configuration (the fixture's
  // defaults). Sandbox: the draft wording and a staging one. One chain id for the whole deployment.
  const doors: CustomerCompanyDeps = charging
    ? customerCompanyDeps(stores, Date.now, { chainId: CHAIN_ID })
    : sandboxCustomerCompanyDeps(stores, Date.now, { chainId: CHAIN_ID, paymentRequired: false });
  const payment = charging
    ? paymentCfg(payments, { byoFeeAtomic: CUSTOMER_FEE })
    : paymentCfg(payments, { required: false });
  const pin = {
    provider: FORMATION_PROVIDER,
    environment: charging ? "production" : "sandbox",
  } as const;
  /** The agents the onboarding runner was asked to build. None may ever be. */
  const sagas: string[] = [];
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => {
      sagas.push(i.idempotencyKey);
      return repo.findByIdempotencyKey(i.idempotencyKey)!;
    },
    fundCaps: TEST_FUND_CAPS,
    formation: { companies, requests, maxAgentsPerCompany: 10 },
  });
  const formationLimits = { sandboxSyntheticPii: false, maxPerTenant: 3, dailyCeiling: 10 };
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo,
    companies,
    documents,
    docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: { declarations, checks },
    customerCompanies: { ...doors, documents, docStore },
    formation: {
      environment: pin.environment,
      required: true,
      ...formationLimits,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin,
      companyDeps: { companies, parties, requests, pin, ...formationLimits, payment },
      payment,
      feeUsdc: payment.feeUsdc,
      // Only a deployment that charges has a settle path at all.
      paymentExecutor: charging ? chain.executor : undefined,
    },
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return {
    app: buildApiApp(deps as ApiDeps),
    companies,
    declarations,
    checks,
    documents,
    docStore,
    payments,
    requests,
    repo,
    store,
    chain,
    sagas,
  };
}
type Deployment = ReturnType<typeof deploy>;

// ── The API, as a client calls it ─────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: a JSON answer, read field by field
type Json = any;

async function sessionOf(): Promise<string> {
  const { token } = await signSession(
    guardian.address,
    JWT_SECRET,
    3600,
    Math.floor(Date.now() / 1000),
  );
  return token;
}

/** One request to the app, recorded with its answer. A JSON body is sent as JSON, bytes as a PDF. */
async function call(
  d: Deployment,
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: { json: unknown } | { pdf: Uint8Array },
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: unknown;
  if (body && "json" in body) {
    headers["content-type"] = "application/json";
    payload = typeof body.json === "string" ? body.json : JSON.stringify(body.json);
  } else if (body) {
    headers["content-type"] = "application/pdf";
    payload = body.pdf;
  }
  const res = await d.app.request(path, { method, headers, body: payload } as RequestInit);
  const text = await res.text();
  answers.push({ method, path, status: res.status, text });
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * The guardian's client asks for the statement and its wallet signs the typed data as served.
 * Answers the typed data, and the body the client then sends to the create door.
 */
async function signedStatement(
  d: Deployment,
  token: string,
  typed: object,
): Promise<{ typedData: Json; body: string }> {
  const asked = await call(d, "POST", STATEMENT_MESSAGE, token, { json: typed });
  expect(asked.status).toBe(200);
  const { typedData } = asked.body;
  const signature = await guardian.signTypedData(typedData);
  return {
    typedData,
    body: JSON.stringify({ ...typed, issuedAt: typedData.message.issuedAt, signature }),
  };
}

/** The tenant uploads a PDF with the sha256 of `hashed`, which is the same bytes unless the body
 *  changed on the way. */
function upload(
  d: Deployment,
  token: string,
  companyId: string,
  kind: string,
  body: Uint8Array,
  hashed: Uint8Array = body,
) {
  const query = new URLSearchParams({ kind, sha256: hexOf(hashed) });
  return call(d, "POST", `/companies/${companyId}/evidence?${query}`, token, { pdf: body });
}

/** What the tenant's own view says of the operator's check. */
async function verificationSeen(d: Deployment, token: string, companyId: string) {
  const res = await call(d, "GET", companyPath(companyId), token);
  expect(res.status).toBe(200);
  return res.body.verification;
}

/** A served quote, as the guardian's client receives it over the wire. */
interface ServedQuote {
  amountUsdc: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, string>;
  };
}

/** The guardian's wallet signs the served payment authorization, converting only the three
 *  uint256 strings viem wants as bigints, as a browser client does. */
async function signServedQuote(td: ServedQuote["typedData"]): Promise<Hex> {
  return guardian.signTypedData({
    // biome-ignore lint/suspicious/noExplicitAny: a served EIP-712 request, typed at the wire
    domain: td.domain as any,
    // biome-ignore lint/suspicious/noExplicitAny: as above
    types: td.types as any,
    // biome-ignore lint/suspicious/noExplicitAny: as above
    primaryType: td.primaryType as any,
    message: {
      from: td.message.from,
      to: td.message.to,
      value: BigInt(td.message.value!),
      validAfter: BigInt(td.message.validAfter!),
      validBefore: BigInt(td.message.validBefore!),
      nonce: td.message.nonce,
      // biome-ignore lint/suspicious/noExplicitAny: as above
    } as any,
  }) as Promise<Hex>;
}

/** An agent of the full product asks to attach to the company, and is refused before any claim. */
async function attachRefused(d: Deployment, token: string, companyId: string): Promise<void> {
  const res = await call(d, "POST", "/onboard", token, {
    json: { spec: AGENT_SPEC, guardianPasskey: PASSKEY, companyId },
  });
  expect(res.status).toBe(400);
  expect(res.body.error.message).toBe(companyUnavailableMessage());
  expect(d.repo.listByTenant(guardian.address)).toEqual([]);
  expect(d.repo.listByCompany(companyId)).toEqual([]);
  expect(d.sagas).toEqual([]);
}

/** The company's standing, derived from the facts as they are now. No legal body is revoked. */
function standing(d: Deployment, companyId: string) {
  const facts = attestationFactsFor(
    { companies: d.companies, checks: d.checks, formationSteps: (id) => d.requests.stepsOf(id) },
    companyId,
    false,
  );
  if (!facts) throw new Error(`no company ${companyId}`);
  return deriveAttestationState(facts);
}

// ── The operator's commands ───────────────────────────────────────────────────────────────────

const noChain = () => {
  throw new Error("this command must not build a chain context");
};

const isOpsLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && "opslog" in parsed;
  } catch {
    return false;
  }
};

/** Runs a command as the operator types it, and answers the one JSON object it printed. */
async function operator(args: string[]): Promise<Json> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  const outputs = printed
    .map((line, at) => ({ line, at }))
    .slice(from)
    .filter(({ line }) => !isOpsLine(line));
  expect(outputs).toHaveLength(1);
  const [output] = outputs as [{ line: string; at: number }];
  if (args[0] === "company:show") shownAt.add(output.at);
  return JSON.parse(output.line);
}

function passedCheck(companyId: string, controlSha256: string, expectLatest: string): string[] {
  return [
    "company:check",
    companyId,
    "--result",
    "passed",
    "--operator",
    OPERATOR,
    "--expect-latest",
    expectLatest,
    "--registry-name",
    COMPANY_NAME,
    "--registry-filing-id",
    FILING_NUMBER,
    "--registry-status",
    "Active",
    "--formation-date",
    "2020-01-15",
    "--registered-agent",
    "Example Registered Agent Co",
    "--existence-evidence",
    PRINTOUT,
    "--control-evidence",
    controlSha256,
    "--control-evidence-kind",
    "ein_letter",
    "--yes",
  ];
}

const changeOfState = (
  command: "company:revoke" | "company:reinstate",
  companyId: string,
  expectLatest: number,
  reason: string,
): string[] => [
  command,
  companyId,
  "--operator",
  OPERATOR,
  "--expect-latest",
  String(expectLatest),
  "--reason",
  reason,
  "--yes",
];

// ── Where a text was put ──────────────────────────────────────────────────────────────────────

/** The tables any of whose rows holds `text`, in any column. */
function tablesHolding(text: string): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const readable = (_key: string, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    // A blob, as a Buffer serialises itself: read back as text, so a name inside one is seen.
    const blob = value as { type?: unknown; data?: unknown } | null;
    if (blob && blob.type === "Buffer" && Array.isArray(blob.data))
      return Buffer.from(blob.data as number[]).toString("latin1");
    return value;
  };
  return tables
    .map(({ name }) => name)
    .filter((name) =>
      JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all(), readable).includes(text),
    )
    .sort();
}

// ── The path ──────────────────────────────────────────────────────────────────────────────────

test("production, charging: a declared company is uploaded, checked, paid, revoked and reinstated; no agent attaches to it; the declarant's name stays in the declaration", async () => {
  const d = deploy(true);
  // The guardian is a verified human: its World ID verification, as the verify route records it.
  recordHuman(d.store, guardian.address, "1001", Date.now());
  const token = await sessionOf();

  // It asks for the statement, signs it and creates the company.
  const signed = await signedStatement(d, token, TYPED);
  expect(signed.typedData.message).toMatchObject(TYPED);
  const created = await call(d, "POST", CREATE, token, { json: signed.body });
  expect(created.status).toBe(201);
  const { companyId } = created.body;
  expect(d.companies.find(companyId)).toMatchObject({ provider: "customer", status: "draft" });
  await attachRefused(d, token, companyId);

  // The same signed body, posted again, answers the same company and creates no other.
  const again = await call(d, "POST", CREATE, token, { json: signed.body });
  expect(again).toEqual({ status: 200, body: { companyId } });
  expect(d.companies.listByTenant(guardian.address).map((c) => c.companyId)).toEqual([companyId]);
  expect(
    d.declarations.listByFilingKey(filingKeyOf(FILING_NUMBER)).map((x) => x.companyId),
  ).toEqual([companyId]);

  // An upload whose body changed on the way is refused, and nothing of it is kept.
  const existence = pdf("existence evidence");
  // One bit flipped near the end: still a PDF, no longer the file the hash names.
  const changed = Buffer.from(existence);
  const at = changed.length - 2;
  changed.writeUInt8(changed.readUInt8(at) ^ 0x01, at);
  const tampered = await upload(d, token, companyId, "existence", changed, existence);
  expect(tampered.status).toBe(400);
  expect(tampered.body.error.code).toBe("content_mismatch");
  expect(d.documents.listByCompany(companyId)).toEqual([]);
  expect(readdirSync(join(dir, "documents"))).toEqual([]);

  // The control document, with its hash; the tenant sees its company waiting for the check.
  const control = pdf("control evidence");
  const uploaded = await upload(d, token, companyId, "control", control);
  expect(uploaded.status).toBe(201);
  const controlSha256 = `0x${hexOf(control)}`;
  expect(uploaded.body).toMatchObject({ sha256: controlSha256, size: control.length });
  const view = await call(d, "GET", companyPath(companyId), token);
  expect(view.body).toMatchObject({
    provider: "customer",
    declared: { companyName: COMPANY_NAME, filingNumber: FILING_NUMBER },
    verification: { state: "awaiting_check", checkedAt: null, reasonCode: null },
  });
  expect(standing(d, companyId)).toMatchObject({ state: "pending", established: false });
  // The upload, an hour older than what follows it: the database clock has one-second resolution,
  // and the operator's check below must land after the upload for the expiry rule to see it.
  db.prepare(
    "UPDATE documents SET created_at = datetime(created_at, '-1 hour') WHERE company_id = ?",
  ).run(companyId);

  // The operator shows the company and records a passed check against the upload it lists.
  const shown = await operator(["company:show", companyId]);
  expect(shown.declaration).toMatchObject({
    declarantName: DECLARANT_NAME,
    declarantTitle: DECLARANT_TITLE,
    companyName: COMPANY_NAME,
    filingNumber: FILING_NUMBER,
    piiErasedAt: null,
  });
  expect(shown.latestCheckId).toBeNull();
  expect(shown.uploads).toMatchObject([
    { kind: "control", sha256: controlSha256, bytesPresent: true },
  ]);
  const pass = await operator(passedCheck(companyId, shown.uploads[0].sha256, "none"));
  expect(pass).toMatchObject({ recorded: true, check: { result: "passed" } });

  // The tenant sees it verified. Verified is not paid: on a deployment that charges it is pending.
  expect(await verificationSeen(d, token, companyId)).toEqual({
    state: "verified",
    checkedAt: pass.check.checkedAt,
    reasonCode: null,
  });
  expect(standing(d, companyId)).toMatchObject({
    state: "pending",
    established: true,
    controlVerified: true,
  });
  await attachRefused(d, token, companyId);

  // The requote through the REST door writes the customer fee.
  const requoted = await call(d, "POST", requotePath(companyId), token);
  expect(requoted.status).toBe(201);
  const quote = requoted.body as ServedQuote;
  expect(quote.amountUsdc).toBe(CUSTOMER_FEE.toString());
  expect(d.payments.findLive(companyId, "formation")?.amountUsdc).toBe(CUSTOMER_FEE);

  // The settlement flips the company to ready, and the company stands active.
  const settled = await call(d, "POST", settlePath(companyId), token, {
    json: { signature: await signServedQuote(quote.typedData), from: guardian.address },
  });
  expect(settled.status).toBe(200);
  expect(settled.body.status).toBe("settled");
  expect(d.chain.sent).toHaveLength(1);
  expect(d.companies.find(companyId)?.status).toBe("ready");
  expect(d.payments.findCurrent(companyId, "formation")).toMatchObject({
    status: "settled",
    amountUsdc: CUSTOMER_FEE,
  });
  expect(standing(d, companyId)).toMatchObject({ state: "active", established: true });
  await attachRefused(d, token, companyId);

  // A month on, the upload's bytes are due: it is past its expiry and a check followed it.
  const later =
    Date.now() +
    (Math.max(EVIDENCE_RETENTION_SECONDS, STALE_CUSTOMER_SECONDS) + DAY_SECONDS) * 1000;
  const due = d.documents.listExpiredCustomerUploads(Math.floor(later / 1000), 10);
  expect(due.map((doc) => doc.id)).toEqual([uploaded.body.docId]);

  // The operator revokes: the company stands revoked, and a new quote is refused.
  const revocation = await operator(
    changeOfState(
      "company:revoke",
      companyId,
      pass.check.checkId,
      "Revoked while a dispute over control is resolved.",
    ),
  );
  expect(revocation).toMatchObject({ recorded: true, check: { result: "revoked" } });
  expect(standing(d, companyId).state).toBe("revoked");
  expect((await verificationSeen(d, token, companyId)).state).toBe("revoked");
  const paymentsBefore = db.prepare("SELECT * FROM formation_payments").all();
  const refused = await call(d, "POST", requotePath(companyId), token);
  expect(refused).toEqual({
    status: 400,
    body: { error: { code: "validation_error", message: NOT_CHECKED } },
  });
  expect(db.prepare("SELECT * FROM formation_payments").all()).toEqual(paymentsBefore);
  await attachRefused(d, token, companyId);

  // Both expiry functions run, a month on: the declaration and the evidence bytes stay.
  expect(
    expireEvidenceBytes({ documents: d.documents, docStore: d.docStore, now: () => later }, 100),
  ).toBe(0);
  expect(
    expireStaleCustomerCompanies(
      {
        companies: d.companies,
        declarations: d.declarations,
        checks: d.checks,
        hasOpenLegalBody: () => false,
        transaction: (fn) => db.transaction(fn)(),
        now: () => later,
      },
      100,
    ),
  ).toBe(0);
  expect(d.companies.find(companyId)?.status).toBe("ready");
  expect(d.declarations.find(companyId)).toMatchObject({
    declarantName: DECLARANT_NAME,
    declarantTitle: DECLARANT_TITLE,
    companyName: COMPANY_NAME,
    filingNumber: FILING_NUMBER,
    piiErasedAt: null,
  });
  const kept = d.documents.findOwned(companyId, uploaded.body.docId);
  expect(kept?.bytesDeletedAt).toBeNull();
  expect(d.docStore.getBytes(kept!.path).equals(control)).toBe(true);

  // The operator reinstates: the tenant's view waits for a new check, and the paid company is
  // pending again until it passes one.
  const reinstatement = await operator(
    changeOfState(
      "company:reinstate",
      companyId,
      revocation.check.checkId,
      "The revocation was recorded on the wrong company.",
    ),
  );
  expect(reinstatement).toMatchObject({ recorded: true, check: { result: "reinstated" } });
  expect(await verificationSeen(d, token, companyId)).toEqual({
    state: "awaiting_check",
    checkedAt: reinstatement.check.checkedAt,
    reasonCode: null,
  });
  expect(standing(d, companyId)).toMatchObject({ state: "pending", established: false });
  await attachRefused(d, token, companyId);

  // The operator sees the whole history, and the evidence still there.
  const history = await operator(["company:show", companyId]);
  expect(history.checks.map((c: { result: string }) => c.result)).toEqual([
    "passed",
    "revoked",
    "reinstated",
  ]);
  expect(history.latestCheckId).toBe(reinstatement.check.checkId);
  expect(history.uploads).toMatchObject([{ sha256: controlSha256, bytesPresent: true }]);
  expect(history.declaration.declarantName).toBe(DECLARANT_NAME);

  // In the whole run, the declarant's name and title reached the declaration's table, the typed
  // data the declarant asked to sign and the output of company:show, and nothing else: no other
  // table (events included), no other answer, no ops line, no other output.
  for (const typed of [DECLARANT_NAME, DECLARANT_TITLE]) {
    expect(tablesHolding(typed), typed).toEqual(["company_declarations"]);
    const answeredWith = answers.filter((a) => a.text.includes(typed));
    expect(answeredWith.length, typed).toBeGreaterThan(0);
    expect(
      answeredWith.filter((a) => a.path !== STATEMENT_MESSAGE),
      typed,
    ).toEqual([]);
    const printedWith = printed.flatMap((line, at) => (line.includes(typed) ? [at] : []));
    expect(printedWith.length, typed).toBeGreaterThan(0);
    expect(
      printedWith.filter((at) => !shownAt.has(at)).map((at) => printed[at]),
      typed,
    ).toEqual([]);
  }
});

test("sandbox, not charging: a declared company is ready from its creation and active once its check passes; no agent attaches to it", async () => {
  const d = deploy(false);
  recordHuman(d.store, guardian.address, "1001", Date.now());
  const token = await sessionOf();

  // The sandbox declaration names its fixture declarant, never a typed name.
  const signed = await signedStatement(d, token, SANDBOX_TYPED);
  expect(signed.typedData.message).toMatchObject({
    declarantName: SYNTHETIC_DECLARANT.name,
    declarantTitle: SYNTHETIC_DECLARANT.title,
  });
  const created = await call(d, "POST", CREATE, token, { json: signed.body });
  expect(created.status).toBe(201);
  const { companyId } = created.body;
  // Nothing to pay, here or later.
  expect(d.companies.find(companyId)).toMatchObject({ provider: "customer", status: "ready" });
  expect((await call(d, "POST", requotePath(companyId), token)).status).toBe(404);
  await attachRefused(d, token, companyId);

  const control = pdf("sandbox control evidence");
  expect((await upload(d, token, companyId, "control", control)).status).toBe(201);
  expect((await verificationSeen(d, token, companyId)).state).toBe("awaiting_check");
  // Ready is not established: without a passed check the company is pending.
  expect(standing(d, companyId)).toMatchObject({ state: "pending", established: false });

  const shown = await operator(["company:show", companyId]);
  expect(shown.declaration).toMatchObject({
    declarantName: SYNTHETIC_DECLARANT.name,
    synthetic: true,
  });
  const pass = await operator(passedCheck(companyId, shown.uploads[0].sha256, "none"));
  expect(pass).toMatchObject({ recorded: true, check: { result: "passed" } });

  expect((await verificationSeen(d, token, companyId)).state).toBe("verified");
  expect(standing(d, companyId)).toMatchObject({ state: "active", established: true });
  await attachRefused(d, token, companyId);
});
