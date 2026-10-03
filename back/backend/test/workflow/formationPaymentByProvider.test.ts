/**
 * Paying for a company, by where it came from.
 *
 * A customer's own company is quoted its own fee, and only once the operator's latest check of its
 * declaration is a pass. Its settlement needs the same pass at the moment it is submitted: a quote
 * stays signable for its whole window, and a revocation inside that window must stop the money.
 * A formation company is quoted and settled exactly as before.
 *
 * Through the doors: the REST payment doors and the MCP re-quote tool, over the shared payment
 * fixture (a fake chain, and the USDC domain as the token reports it). A customer's company is
 * written as the declaration door writes it, and its checks are appended as the operator's command
 * appends them. Every name and filing number is an invention.
 */
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import { CUSTOMER_COMPANY_PLACEHOLDER } from "../../src/legalBody/customerCompany";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import {
  type NewCompanyCheck,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { Hex } from "../../src/types";
import { formationPaymentDeps, requoteFormationPayment } from "../../src/workflow/formationPayment";
import { fakeChain, paymentCfg } from "../helpers/formationPayment";
import { startMcpTestClient } from "../mcp/helpers";

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
/** The guardian's wallet: an invented test key. */
const guardian = privateKeyToAccount(`0x${"7".repeat(64)}`);
const OWNER = getAddress(guardian.address);
/** The shared payment fixture's formation fee, and an invented fee for a customer's company. */
const FORMATION_FEE = 399_000_000n;
const CUSTOMER_FEE = 7_000_000n;
/** What a customer's company is told while its latest check is anything but a pass. */
const NOT_CHECKED = "this company has not passed its check yet";

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let parties: SqliteFormationPartyRepository;
let payments: SqliteFormationPaymentRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let apiKeys: SqliteApiKeyStore;
let chain: ReturnType<typeof fakeChain>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  chain = fakeChain();
  // Quotes and settlements write ops lines: kept off stdout here.
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** A deployment that charges, with both fees configured. */
function cfg(): FormationPaymentConfig {
  return paymentCfg(payments, { byoFeeAtomic: CUSTOMER_FEE });
}

/**
 * The API over this test's database, charging, with the executor on the fake chain. The customer
 * facts are wired as the composition root wires them, unless a test leaves them out.
 */
function app(opts: { customerFacts?: boolean } = {}) {
  const payment = cfg();
  // Any provider but `customer` is a company filed through formation.
  const pin = { provider: "example-formation-provider", environment: "sandbox" } as const;
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    apiKeys,
    formationSteps: (id: string) => requests.stepsOf(id),
    company: (id: string) => companies.find(id),
    companyAgents: companies,
    ...(opts.customerFacts === false ? {} : { customerFacts: { declarations, checks } }),
    formation: {
      environment: "sandbox",
      required: true,
      sandboxSyntheticPii: false,
      maxPerTenant: 3,
      dailyCeiling: 10,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin,
      companyDeps: {
        companies,
        parties,
        requests,
        pin,
        sandboxSyntheticPii: false,
        maxPerTenant: 3,
        dailyCeiling: 10,
        payment,
      },
      payment,
      feeUsdc: 399,
      paymentExecutor: chain.executor,
    },
  };
  return buildApiApp(deps as ApiDeps);
}
type App = ReturnType<typeof app>;

/** A customer's company owing its payment, as the declaration door writes it where the
 *  deployment charges. */
function customerCompany(): string {
  return companies.create({
    tenantId: OWNER,
    status: "draft",
    provider: "customer",
    environment: "sandbox",
    synthetic: true,
    nameOptions: [{ name: "Example Holdings LLC", entityTypeEnding: "", position: 1 }],
    businessPurpose: CUSTOMER_COMPANY_PLACEHOLDER,
    industryLabel: CUSTOMER_COMPANY_PLACEHOLDER,
    intakeSynthesized: false,
  });
}

/** A 32-byte value: one byte, written as two hex digits, repeated. */
const H = (byte: string) => `0x${byte.repeat(32)}` as Hex;

function passed(companyId: string): NewCompanyCheck {
  return {
    companyId,
    result: "passed",
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: 1_790_000_000,
    registryName: "Example Holdings LLC",
    registryFilingId: "TEST-0001",
    registryStatus: "Active",
    formationDate: "2024-02-29",
    registeredAgent: "Example Registered Agent LLC",
    existenceEvidenceSha256: H("e1"),
    controlEvidenceSha256: H("c1"),
    controlEvidenceKind: "ein_letter",
    reasonCode: null,
    reason: null,
  };
}

/** A check that is not a pass: it carries a reason, and no registry facts. */
function notPassed(
  companyId: string,
  result: "failed" | "revoked" | "reinstated",
  checkedAt = 1_790_000_100,
): NewCompanyCheck {
  return {
    ...passed(companyId),
    result,
    checkedAt,
    registryName: null,
    registryFilingId: null,
    registryStatus: null,
    formationDate: null,
    registeredAgent: null,
    existenceEvidenceSha256: null,
    controlEvidenceSha256: null,
    controlEvidenceKind: null,
    reasonCode: result === "failed" ? "filing_not_found" : null,
    reason: "Recorded for the test.",
  };
}

async function token(tenantId = OWNER): Promise<string> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

async function post(application: App, path: string, body: unknown = {}): Promise<Response> {
  return application.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const requotePath = (companyId: string) => `/companies/${companyId}/payment/requote`;
const settlePath = (companyId: string) => `/companies/${companyId}/payment/settle`;

/** A served quote, as a caller receives it over the wire. */
interface ServedQuote {
  amountUsdc: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, string>;
  };
}

/** The guardian's wallet signs the SERVED typed data, converting only the three uint256 strings
 *  viem wants as bigints, as a browser client does. */
async function signServed(td: ServedQuote["typedData"]): Promise<Hex> {
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

/** A requote through the REST door that must succeed: the quote it served. */
async function requoted(application: App, companyId: string): Promise<ServedQuote> {
  const res = await post(application, requotePath(companyId));
  expect(res.status).toBe(201);
  return (await res.json()) as ServedQuote;
}

/** Every row the payment path could write. */
function rowsAtRest() {
  return {
    payments: db.prepare("SELECT * FROM formation_payments ORDER BY payment_id").all(),
    companies: db.prepare("SELECT * FROM companies ORDER BY company_id").all(),
  };
}

// ── the quote ───────────────────────────────────────────────────────────────────────────────

test("REST: a requote of a verified customer company answers 201 with the customer fee", async () => {
  const application = app();
  const companyId = customerCompany();
  checks.append(passed(companyId));

  const res = await post(application, requotePath(companyId));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({
    amountUsdc: CUSTOMER_FEE.toString(),
    amountDisplayUsdc: 7,
    typedData: { message: { from: OWNER, value: CUSTOMER_FEE.toString() } },
  });
  expect(payments.findLive(companyId, "formation")?.amountUsdc).toBe(CUSTOMER_FEE);
});

test("REST: a formation company is quoted the formation fee at its creation and its requote, with a customer fee configured", async () => {
  const application = app();
  const created = await post(application, "/companies", {
    partyId: parties.create({
      tenantId: OWNER,
      legalFirstName: "Ada",
      legalLastName: "Example",
      email: "ada@example.com",
      phone: "+12125550100",
      line1: "1 Example Way",
      line2: null,
      city: "Cheyenne",
      region: "WY",
      postalCode: "82001",
      country: "USA",
      synthetic: false,
    }),
    names: ["Example Robotics LLC", "Example Automata", "Example Mechanicals"],
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: DEFAULT_INDUSTRY,
  });
  expect(created.status).toBe(201);
  const { companyId, payment } = (await created.json()) as {
    companyId: string;
    payment: ServedQuote;
  };
  expect(payment.amountUsdc).toBe(FORMATION_FEE.toString());

  payments.markExpired(payments.findLive(companyId, "formation")!.paymentId, "quoted");
  const res = await post(application, requotePath(companyId));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({
    amountUsdc: FORMATION_FEE.toString(),
    amountDisplayUsdc: 399,
    typedData: { message: { value: FORMATION_FEE.toString() } },
  });
});

test("REST: a requote of an unverified, a failed, a revoked or a reinstated customer company is refused, and writes nothing", async () => {
  const application = app();
  const unverified = customerCompany();
  const failed = customerCompany();
  checks.append(notPassed(failed, "failed"));
  const revoked = customerCompany();
  checks.append(passed(revoked));
  checks.append(notPassed(revoked, "revoked"));
  // A reinstatement waits for a new check, exactly like no check at all.
  const reinstated = customerCompany();
  checks.append(passed(reinstated));
  checks.append(notPassed(reinstated, "revoked"));
  checks.append(notPassed(reinstated, "reinstated", 1_790_000_200));

  const before = rowsAtRest();
  for (const companyId of [unverified, failed, revoked, reinstated]) {
    const res = await post(application, requotePath(companyId));
    expect(res.status, companyId).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "validation_error", message: NOT_CHECKED } });
  }
  expect(rowsAtRest()).toEqual(before);
});

test("REST: with no checks to read, a requote of a customer company is refused, its passed check notwithstanding", async () => {
  const companyId = customerCompany();
  checks.append(passed(companyId));
  const before = rowsAtRest();

  const res = await post(app({ customerFacts: false }), requotePath(companyId));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: { code: "validation_error", message: NOT_CHECKED } });
  expect(rowsAtRest()).toEqual(before);
});

test("MCP: requote_company_payment refuses a customer company before its pass, and quotes the customer fee after", async () => {
  const application = app();
  const companyId = customerCompany();
  const requote = async () => {
    const mcp = await startMcpTestClient(
      application,
      apiKeys.mint(OWNER, { capability: "provision" }).key,
    );
    try {
      const out = (await mcp.client.callTool({
        name: "requote_company_payment",
        arguments: { companyId },
      })) as { content: { text: string }[]; isError?: boolean };
      return { text: out.content[0]!.text, isError: Boolean(out.isError) };
    } finally {
      await mcp.close();
    }
  };

  expect(await requote()).toEqual({ text: NOT_CHECKED, isError: true });
  expect(payments.findCurrent(companyId, "formation")).toBeUndefined();

  checks.append(passed(companyId));
  const after = await requote();
  expect(after.isError).toBe(false);
  expect(JSON.parse(after.text)).toMatchObject({ amountUsdc: CUSTOMER_FEE.toString() });
});

test("formationPaymentDeps hands the payment functions the checks of the customer facts", () => {
  const base = { companies, repo, formation: { payment: cfg(), paymentExecutor: chain.executor } };
  expect(formationPaymentDeps({ ...base, customerFacts: { checks } })?.checks).toBe(checks);
  expect(formationPaymentDeps(base)?.checks).toBeUndefined();
});

test("a verified customer company on a deployment with no customer fee is never quoted: the requote throws and writes nothing", () => {
  const companyId = customerCompany();
  checks.append(passed(companyId));
  const deps = formationPaymentDeps({
    companies,
    repo,
    formation: { payment: paymentCfg(payments), paymentExecutor: chain.executor },
    customerFacts: { checks },
  })!;
  const before = rowsAtRest();
  expect(() => requoteFormationPayment(deps, companies.find(companyId)!)).toThrow(/customer/);
  expect(rowsAtRest()).toEqual(before);
});

test("the check is asked first: before the payment row in a settlement, before the live quote in a requote", async () => {
  const application = app();
  // Never quoted: a settlement names the check, not the missing payment.
  const unquoted = customerCompany();
  const settle = await post(application, settlePath(unquoted), {
    signature: `0x${"11".repeat(65)}`,
    from: OWNER,
  });
  expect((await settle.json()).error.message).toBe(NOT_CHECKED);
  // Quoted, then revoked: a requote names the check, not the live quote.
  const quoted = customerCompany();
  checks.append(passed(quoted));
  await requoted(application, quoted);
  checks.append(notPassed(quoted, "revoked"));
  const requote = await post(application, requotePath(quoted));
  expect((await requote.json()).error.message).toBe(NOT_CHECKED);
});

// ── the settlement ──────────────────────────────────────────────────────────────────────────

test("REST: a settlement of a verified customer company flips it from draft to ready", async () => {
  const application = app();
  const companyId = customerCompany();
  checks.append(passed(companyId));
  const quote = await requoted(application, companyId);

  const res = await post(application, settlePath(companyId), {
    signature: await signServed(quote.typedData),
    from: OWNER,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("settled");
  expect(companies.find(companyId)?.status).toBe("ready");
  expect(payments.findCurrent(companyId, "formation")).toMatchObject({
    status: "settled",
    amountUsdc: CUSTOMER_FEE,
    payerAddress: OWNER,
  });
  expect(chain.sent).toHaveLength(1);
});

test("REST: a settlement of a customer company revoked after its quote is refused, and writes nothing", async () => {
  const application = app();
  const companyId = customerCompany();
  checks.append(passed(companyId));
  const quote = await requoted(application, companyId);
  const signature = await signServed(quote.typedData);
  checks.append(notPassed(companyId, "revoked"));
  const before = rowsAtRest();

  const res = await post(application, settlePath(companyId), { signature, from: OWNER });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: { code: "validation_error", message: NOT_CHECKED } });
  expect(rowsAtRest()).toEqual(before);
  expect(chain.sent).toHaveLength(0);
});

test("REST: with no checks to read, a settlement of a customer company is refused, and writes nothing", async () => {
  const companyId = customerCompany();
  checks.append(passed(companyId));
  const quote = await requoted(app(), companyId);
  const signature = await signServed(quote.typedData);
  const before = rowsAtRest();

  const res = await post(app({ customerFacts: false }), settlePath(companyId), {
    signature,
    from: OWNER,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: { code: "validation_error", message: NOT_CHECKED } });
  expect(rowsAtRest()).toEqual(before);
  expect(chain.sent).toHaveLength(0);
});
