/**
 * A customer's own company: an existing Wyoming LLC that its guardian declares with a signed
 * statement of authority, and that its tenant may abandon while nobody has checked it.
 *
 * The create runs a fixed order of checks and writes nothing until all of them pass. Each step is
 * tested with a request that is wrong at that step AND at every later one, so the step that answers
 * is the first in the order. The company and its declaration are then written in one transaction,
 * which looks the statement up and counts the caps again: two requests in flight at once cannot
 * both get past a cap.
 *
 * Every name, company and filing number here is an invention, and the keys are anvil's published
 * test accounts.
 */
import type Database from "better-sqlite3";
import { type Address, type Hex, keccak256, recoverAddress, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/api/errors";
import { type WorldIdDeps, buildWorldIdDeps } from "../../src/api/routes/worldId";
import {
  CUSTOMER_COMPANIES_PER_TENANT_PER_DAY,
  CUSTOMER_COMPANY_PLACEHOLDER,
  CUSTOMER_PROVIDER,
  type CustomerCompanyDeps,
  type CustomerCompanyInput,
  type CustomerStatementInput,
  SYNTHETIC_DECLARANT,
  abandonCustomerCompany,
  createCustomerCompany,
  prepareCustomerStatement,
} from "../../src/legalBody/customerCompany";
import {
  buildStatementMessage,
  statementDigest,
  statementTypedDataWire,
} from "../../src/legalBody/statement";
import { type LegalText, LegalTextNotApprovedError } from "../../src/legalBody/texts/index";
import {
  STATEMENT_OF_AUTHORITY,
  type StatementFields,
} from "../../src/legalBody/texts/statementOfAuthority";
import {
  type NewCompanyCheck,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import {
  type CompanyStatus,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. */
const owner = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const second = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
const stranger = privateKeyToAccount(
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
);
type Signer = typeof owner;

const FACTORY = "0x00000000000000000000000000000000000fAc70" as Address;
const OTHER_FACTORY = "0x00000000000000000000000000000000000A11cE" as Address;
const CHAIN_ID = 31_337;
const ACTION = "guardian-verification";
const OWNER_NULLIFIER = "1001";
const SECOND_NULLIFIER = "1002";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FORMATION_PROVIDER = "example-formation-provider";

/** The draft wording, approved: what a production deployment serves once the wording is final. */
const APPROVED: LegalText<StatementFields> = { ...STATEMENT_OF_AUTHORITY, status: "approved" };

/** A declaration as a production caller types it. */
const TYPED: CustomerStatementInput = {
  declarantName: "Ada Example",
  declarantTitle: "Manager",
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
};
/** A declaration as a sandbox caller sends it: the synthetic flag, and no declarant. */
const SANDBOX_TYPED: CustomerStatementInput = {
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
  synthetic: true,
};

let db: Database.Database;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let store: SqliteWorldStore;
/** The tests' clock, in milliseconds. It starts at the real time, because `created_at` is the
 *  database's own clock and the 24-hour window is measured against it. */
let nowMs: number;
let logs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  store = new SqliteWorldStore(db);
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  // A created company writes an ops line: the tests read it here rather than on stdout.
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
  recordHuman(owner.address, OWNER_NULLIFIER);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const nowSeconds = (): bigint => BigInt(Math.floor(nowMs / 1000));

/** A verification row, recorded as the verify route records one. */
function recordHuman(tenantId: Address, nullifier: string, credential = "proof_of_human"): void {
  expect(
    store.recordVerification({
      nullifier,
      action: ACTION,
      tenantId,
      issuerSchemaId: 1,
      credential,
      environment: "production",
      verifiedAt: nowMs,
      expiresAtMin: null,
    }),
  ).toBe(true);
}

/** World ID wired through its one builder. Enforcement is off on purpose: a declaration needs a
 *  real human whatever that switch says. */
function worldFor(
  opts: { environment?: "production" | "staging"; maxCompaniesPerHuman?: number } = {},
): WorldIdDeps {
  return buildWorldIdDeps(
    {
      appId: "app_test",
      rpId: "rp_test",
      rpSigningKey: `0x${"1".repeat(64)}`,
      action: ACTION,
      environment: opts.environment ?? "production",
      attestMinAge: 18,
      maxCompaniesPerHuman: opts.maxCompaniesPerHuman,
      requireGuardian: false,
    },
    store,
  );
}

/** A production deployment that charges, serving the approved wording. */
function deps(over: Partial<CustomerCompanyDeps> = {}): CustomerCompanyDeps {
  return {
    companies,
    declarations,
    checks,
    world: worldFor(),
    chainId: CHAIN_ID,
    factory: FACTORY,
    environment: "production",
    text: APPROVED,
    maxOpenPerTenant: 3,
    paymentRequired: true,
    hasOpenLegalBody: () => false,
    transaction: (fn) => db.transaction(fn)(),
    now: () => nowMs,
    ...over,
  };
}

/** A sandbox deployment: the draft wording, and a World configuration that is not production. */
function sandboxDeps(over: Partial<CustomerCompanyDeps> = {}): CustomerCompanyDeps {
  return deps({
    environment: "sandbox",
    text: STATEMENT_OF_AUTHORITY,
    world: worldFor({ environment: "staging" }),
    ...over,
  });
}

/** The fields the server builds from a declaration, written out here on their own. */
function fieldsOf(typed: CustomerStatementInput, guardian: Address): StatementFields {
  return {
    declarantName: typed.declarantName ?? "Novi Sandbox Declarant",
    declarantTitle: typed.declarantTitle ?? "Manager",
    companyName: typed.companyName,
    jurisdiction: "WY",
    filingNumber: typed.filingNumber,
    guardian,
  };
}

interface SignOptions {
  signer?: Signer;
  issuedAt?: bigint;
  factory?: Address;
}

/** What a wallet does: sign the served typed data as it arrives over JSON. */
async function sign(
  fields: StatementFields,
  opts: SignOptions = {},
): Promise<{ issuedAt: string; signature: Hex }> {
  const issuedAt = opts.issuedAt ?? nowSeconds();
  const message = buildStatementMessage(fields, APPROVED, issuedAt);
  const served = statementTypedDataWire(CHAIN_ID, opts.factory ?? FACTORY, message);
  const signature = await (opts.signer ?? owner).signTypedData(JSON.parse(JSON.stringify(served)));
  return { issuedAt: issuedAt.toString(), signature };
}

/** A declaration signed by its own guardian: the owner, unless another signer is named. */
async function signed(
  typed: CustomerStatementInput,
  opts: SignOptions = {},
): Promise<CustomerCompanyInput> {
  const signer = opts.signer ?? owner;
  return { ...typed, ...(await sign(fieldsOf(typed, signer.address), { ...opts, signer })) };
}

interface Refusal {
  code: string;
  status: number;
  message: string;
  details?: unknown;
}

/** The refusal a door turns into a response. A draft wording is refused by its own error class,
 *  which the doors answer as `legal_text_not_approved` (503). */
function refusalFrom(err: unknown): Refusal {
  if (err instanceof ApiError)
    return { code: err.code, status: err.status, message: err.message, details: err.details };
  if (err instanceof LegalTextNotApprovedError)
    return { code: "legal_text_not_approved", status: 503, message: err.message };
  throw err;
}

async function refusalOf(pending: Promise<unknown>): Promise<Refusal> {
  try {
    await pending;
  } catch (err) {
    return refusalFrom(err);
  }
  throw new Error("expected a refusal");
}

function refusalOfCall(call: () => unknown): Refusal {
  try {
    call();
  } catch (err) {
    return refusalFrom(err);
  }
  throw new Error("expected a refusal");
}

const rows = (table: "companies" | "company_declarations" | "formation_payments"): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Everything printed to the console during the test, one entry per call. */
const printed = (): string[] => logs.mock.calls.map((call) => call.map(String).join(" "));
const opsLines = (event: string): string[] =>
  printed().filter((line) => line.includes(`"opslog":"${event}"`));

function expectNothingWritten(): void {
  expect(rows("companies")).toBe(0);
  expect(rows("company_declarations")).toBe(0);
}

/** A company row written directly, for the tests about the counts and the abandon rules. */
function companyRow(over: { tenantId?: Address; provider?: string; status?: CompanyStatus }) {
  return companies.create({
    tenantId: over.tenantId ?? owner.address,
    status: over.status ?? "draft",
    provider: over.provider ?? CUSTOMER_PROVIDER,
    environment: "production",
    synthetic: false,
    nameOptions: [],
    businessPurpose: CUSTOMER_COMPANY_PLACEHOLDER,
    industryLabel: CUSTOMER_COMPANY_PLACEHOLDER,
    intakeSynthesized: false,
  });
}

/** A failed check of a declaration, as the operator records one. */
function failedCheck(companyId: string): NewCompanyCheck {
  return {
    companyId,
    result: "failed",
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: Number(nowSeconds()),
    registryName: null,
    registryFilingId: null,
    registryStatus: null,
    formationDate: null,
    registeredAgent: null,
    existenceEvidenceSha256: null,
    controlEvidenceSha256: null,
    controlEvidenceKind: null,
    reasonCode: "filing_not_found",
    reason: "No filing under this number in the registry.",
  };
}

function paymentRow(companyId: string, status: string): void {
  db.prepare(
    `INSERT INTO formation_payments (payment_id, company_id, status, amount_usdc, nonce, valid_before)
     VALUES (?, ?, ?, '1000000', ?, 1)`,
  ).run(`pay-${companyId}-${status}`, companyId, status, `nonce-${companyId}-${status}`);
}

/**
 * A request that is right before step `from` and wrong at it and at every later step: on a
 * production deployment, the draft wording (2), the synthetic flag (3), a zero-width space in the
 * declarant's name (4), the human's cap at zero (5), the tenant's cap at zero (6) and a statement
 * issued eleven minutes ago (7). The owner, a verified human, passes step 1.
 */
async function wrongFrom(from: 2 | 3 | 4 | 5 | 6 | 7) {
  const typed: CustomerStatementInput = { ...TYPED };
  if (from <= 3) typed.synthetic = true;
  if (from <= 4) typed.declarantName = "Ada\u200BExample";
  const d = deps({
    text: from <= 2 ? STATEMENT_OF_AUTHORITY : APPROVED,
    world: worldFor({ maxCompaniesPerHuman: from <= 5 ? 0 : undefined }),
    maxOpenPerTenant: from <= 6 ? 0 : 3,
  });
  const body = await signed(typed, { issuedAt: nowSeconds() - 660n });
  return { d, body };
}

test("the exact values: the provider, the placeholder, the sandbox declarant and the daily cap", () => {
  expect(CUSTOMER_PROVIDER).toBe("customer");
  expect(CUSTOMER_COMPANY_PLACEHOLDER).toBe("not applicable: an existing company");
  expect(SYNTHETIC_DECLARANT).toEqual({ name: "Novi Sandbox Declarant", title: "Manager" });
  expect(CUSTOMER_COMPANIES_PER_TENANT_PER_DAY).toBe(5);
});

describe("on a production deployment, with the wording approved", () => {
  test("a valid request creates a draft customer company owing its payment, and a declaration holding what was signed", async () => {
    const body = await signed(TYPED);
    const result = await createCustomerCompany(deps(), owner.address, body);
    expect(result.created).toBe(true);

    expect(companies.find(result.companyId)).toMatchObject({
      tenantId: owner.address,
      status: "draft",
      provider: "customer",
      environment: "production",
      synthetic: false,
      nameOptions: [{ name: "Example Holdings LLC", entityTypeEnding: "LLC", position: 1 }],
      businessPurpose: CUSTOMER_COMPANY_PLACEHOLDER,
      industryLabel: CUSTOMER_COMPANY_PLACEHOLDER,
      intakeSynthesized: false,
    });

    const fields = fieldsOf(TYPED, owner.address);
    const sentence = APPROVED.render(fields);
    const message = buildStatementMessage(fields, APPROVED, nowSeconds());
    const declaration = declarations.find(result.companyId);
    expect(declaration).toMatchObject({
      companyId: result.companyId,
      tenantId: owner.address,
      humanNullifier: OWNER_NULLIFIER,
      declarantName: "Ada Example",
      declarantTitle: "Manager",
      statementText: sentence,
      statementHash: keccak256(stringToBytes(sentence)),
      statementDigest: statementDigest(CHAIN_ID, FACTORY, message),
      signature: body.signature,
      companyName: "Example Holdings LLC",
      jurisdiction: "WY",
      filingNumber: "TEST-0001",
      wordingVersion: APPROVED.version,
      chainId: CHAIN_ID,
      factory: FACTORY,
      issuedAt: Number(nowSeconds()),
      synthetic: false,
      piiErasedAt: null,
    });
    // The row is evidence on its own: its signature recovers, over its digest, to the guardian.
    expect(
      await recoverAddress({
        hash: declaration!.statementDigest!,
        signature: declaration!.signature!,
      }),
    ).toBe(owner.address);
    // No payment quote is written here.
    expect(rows("formation_payments")).toBe(0);
  });

  test("with payment not required, the company lands ready", async () => {
    const { companyId } = await createCustomerCompany(
      deps({ paymentRequired: false }),
      owner.address,
      await signed(TYPED),
    );
    expect(companies.find(companyId)?.status).toBe("ready");
  });

  test("the stored sentence is the server's own rendering: a sentence or a version sent beside the fields is ignored", async () => {
    const body = {
      ...(await signed(TYPED)),
      statement: "I declare something else entirely.",
      wordingVersion: "another-version",
    } as CustomerCompanyInput;
    const { companyId } = await createCustomerCompany(deps(), owner.address, body);
    expect(declarations.find(companyId)).toMatchObject({
      statementText: APPROVED.render(fieldsOf(TYPED, owner.address)),
      wordingVersion: APPROVED.version,
    });
  });

  test("a body that says synthetic is refused with synthetic_rule; synthetic: false claims nothing and passes", async () => {
    for (const synthetic of [true, "true", 1]) {
      const body = await signed({ ...TYPED, synthetic } as CustomerStatementInput);
      expect(await refusalOf(createCustomerCompany(deps(), owner.address, body))).toMatchObject({
        code: "synthetic_rule",
        status: 400,
      });
    }
    expectNothingWritten();
    const { companyId } = await createCustomerCompany(
      deps(),
      owner.address,
      await signed({ ...TYPED, synthetic: false }),
    );
    expect(companies.find(companyId)?.synthetic).toBe(false);
  });

  test("a filing number with a space inside is refused", async () => {
    const body = await signed({ ...TYPED, filingNumber: "TEST 0001" });
    expect(await refusalOf(createCustomerCompany(deps(), owner.address, body))).toMatchObject({
      code: "validation_error",
      status: 400,
      details: [{ field: "filingNumber", problem: expect.any(String) }],
    });
    expectNothingWritten();
  });

  test("with the draft wording, the request is refused as a text not approved", async () => {
    await expect(
      createCustomerCompany(
        deps({ text: STATEMENT_OF_AUTHORITY }),
        owner.address,
        await signed(TYPED),
      ),
    ).rejects.toBeInstanceOf(LegalTextNotApprovedError);
    expectNothingWritten();
  });
});

describe("the order of checks: each step refuses with its own code, before every later step, and writes nothing", () => {
  test("step 1, the human: unverified is guardian_not_verified (403), a waiver waiver_not_accepted (403), no World ID unavailable (503)", async () => {
    const { d, body } = await wrongFrom(2);
    expect(await refusalOf(createCustomerCompany(d, second.address, body))).toMatchObject({
      code: "guardian_not_verified",
      status: 403,
    });
    recordHuman(second.address, "waiver:example", "waiver");
    expect(await refusalOf(createCustomerCompany(d, second.address, body))).toMatchObject({
      code: "waiver_not_accepted",
      status: 403,
    });
    expect(
      await refusalOf(createCustomerCompany({ ...d, world: undefined }, owner.address, body)),
    ).toMatchObject({ code: "unavailable", status: 503 });
    expectNothingWritten();
  });

  test("step 2, the wording: a draft on a production deployment (the doors answer legal_text_not_approved, 503)", async () => {
    const { d, body } = await wrongFrom(2);
    await expect(createCustomerCompany(d, owner.address, body)).rejects.toBeInstanceOf(
      LegalTextNotApprovedError,
    );
    expect(await refusalOf(createCustomerCompany(d, owner.address, body))).toMatchObject({
      code: "legal_text_not_approved",
    });
    expectNothingWritten();
  });

  test("step 3, the synthetic rule: synthetic_rule (400)", async () => {
    const { d, body } = await wrongFrom(3);
    expect(await refusalOf(createCustomerCompany(d, owner.address, body))).toMatchObject({
      code: "synthetic_rule",
      status: 400,
    });
    expectNothingWritten();
  });

  test("step 4, the fields: validation_error (400), naming the field", async () => {
    const { d, body } = await wrongFrom(4);
    expect(await refusalOf(createCustomerCompany(d, owner.address, body))).toMatchObject({
      code: "validation_error",
      status: 400,
      details: [{ field: "declarantName", problem: expect.any(String) }],
    });
    expectNothingWritten();
  });

  test("step 4, the wire form: a malformed issuedAt or signature is a validation_error too", async () => {
    const { d, body } = await wrongFrom(5);
    const malformed: [string, Partial<Record<keyof CustomerCompanyInput, unknown>>][] = [
      ["issuedAt", { issuedAt: "0123" }],
      ["signature", { signature: "0xabc" }],
    ];
    for (const [field, over] of malformed)
      expect(
        await refusalOf(
          createCustomerCompany(d, owner.address, { ...body, ...over } as CustomerCompanyInput),
        ),
      ).toMatchObject({ code: "validation_error", status: 400, details: [{ field }] });
    expectNothingWritten();
  });

  test("step 5, the human's company cap: guardian_company_cap (403)", async () => {
    const { d, body } = await wrongFrom(5);
    expect(await refusalOf(createCustomerCompany(d, owner.address, body))).toMatchObject({
      code: "guardian_company_cap",
      status: 403,
    });
    expectNothingWritten();
  });

  test("step 6, the tenant's open companies: customer_company_cap (409)", async () => {
    const { d, body } = await wrongFrom(6);
    expect(await refusalOf(createCustomerCompany(d, owner.address, body))).toMatchObject({
      code: "customer_company_cap",
      status: 409,
    });
    expectNothingWritten();
  });

  test("step 6, the tenant's declarations in 24 hours: customer_company_rate (429), counted after the open companies", async () => {
    const d = deps({ maxOpenPerTenant: 10 });
    for (let i = 1; i <= 5; i++)
      await createCustomerCompany(
        d,
        owner.address,
        await signed({ ...TYPED, filingNumber: `TEST-000${i}` }),
      );
    const stale = await signed(
      { ...TYPED, filingNumber: "TEST-0006" },
      { issuedAt: nowSeconds() - 660n },
    );
    expect(
      await refusalOf(createCustomerCompany(deps({ maxOpenPerTenant: 5 }), owner.address, stale)),
    ).toMatchObject({ code: "customer_company_cap", status: 409 });
    expect(await refusalOf(createCustomerCompany(d, owner.address, stale))).toMatchObject({
      code: "customer_company_rate",
      status: 429,
    });
    expect(rows("companies")).toBe(5);
    expect(rows("company_declarations")).toBe(5);
  });

  test("step 7, a statement outside its time window: statement_stale (400), at either end", async () => {
    const { d, body } = await wrongFrom(7);
    expect(await refusalOf(createCustomerCompany(d, owner.address, body))).toMatchObject({
      code: "statement_stale",
      status: 400,
    });
    const ahead = await signed(TYPED, { issuedAt: nowSeconds() + 61n });
    expect(await refusalOf(createCustomerCompany(deps(), owner.address, ahead))).toMatchObject({
      code: "statement_stale",
      status: 400,
    });
    expectNothingWritten();
    // Ten minutes back and one minute ahead are still inside the window.
    const oldest = await signed(TYPED, { issuedAt: nowSeconds() - 600n });
    const newest = await signed(
      { ...TYPED, filingNumber: "TEST-0002" },
      { issuedAt: nowSeconds() + 60n },
    );
    expect((await createCustomerCompany(deps(), owner.address, oldest)).created).toBe(true);
    expect((await createCustomerCompany(deps(), owner.address, newest)).created).toBe(true);
  });

  test("step 7, a signature that is not the guardian's over this very statement: statement_not_valid (400)", async () => {
    const fields = fieldsOf(TYPED, owner.address);
    const good = await sign(fields);
    const bodies: CustomerCompanyInput[] = [
      // Signed by another wallet.
      { ...TYPED, ...(await sign(fields, { signer: stranger })) },
      // Signed for another deployment's factory.
      { ...TYPED, ...(await sign(fields, { factory: OTHER_FACTORY })) },
      // Signed over another company name.
      { ...TYPED, ...(await sign({ ...fields, companyName: "Other Example LLC" })) },
      // 64 bytes: not a form of signature the statement accepts.
      { ...TYPED, issuedAt: good.issuedAt, signature: good.signature.slice(0, -2) as Hex },
    ];
    for (const body of bodies)
      expect(await refusalOf(createCustomerCompany(deps(), owner.address, body))).toMatchObject({
        code: "statement_not_valid",
        status: 400,
      });
    expectNothingWritten();
  });
});

test("prepareCustomerStatement runs steps 1 to 4 only: it refuses as the create does, applies no cap and writes nothing", () => {
  const capped = deps({ world: worldFor({ maxCompaniesPerHuman: 0 }), maxOpenPerTenant: 0 });
  const prepared = prepareCustomerStatement(capped, owner.address, TYPED);
  expect(prepared.verification.nullifier).toBe(OWNER_NULLIFIER);
  expect(prepared.fields).toEqual(fieldsOf(TYPED, owner.address));

  recordHuman(second.address, "waiver:example", "waiver");
  const refused = (d: CustomerCompanyDeps, tenant: Address, input: CustomerStatementInput) =>
    refusalOfCall(() => prepareCustomerStatement(d, tenant, input)).code;
  expect(refused(deps(), second.address, TYPED)).toBe("waiver_not_accepted");
  expect(refused(deps({ text: STATEMENT_OF_AUTHORITY }), owner.address, TYPED)).toBe(
    "legal_text_not_approved",
  );
  expect(
    refused(sandboxDeps(), owner.address, {
      companyName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
    }),
  ).toBe("synthetic_rule");
  expect(refused(deps(), owner.address, { ...TYPED, companyName: "E" })).toBe("validation_error");
  expectNothingWritten();
});

describe("on a sandbox deployment", () => {
  test("a request must say synthetic: true", async () => {
    const { synthetic: _said, ...unsaid } = SANDBOX_TYPED;
    for (const synthetic of [undefined, false, "true"]) {
      const body = await signed({ ...unsaid, synthetic } as CustomerStatementInput);
      expect(
        await refusalOf(createCustomerCompany(sandboxDeps(), owner.address, body)),
      ).toMatchObject({ code: "synthetic_rule", status: 400 });
    }
    expectNothingWritten();
  });

  test("the declarant is never the caller's: a body carrying a name or a title is synthetic_declarant_only", async () => {
    const carried: Partial<CustomerStatementInput>[] = [
      { declarantName: "Ada Example" },
      { declarantTitle: "Manager" },
      { declarantName: "" },
    ];
    for (const over of carried) {
      const body = await signed({ ...SANDBOX_TYPED, ...over });
      expect(
        await refusalOf(createCustomerCompany(sandboxDeps(), owner.address, body)),
      ).toMatchObject({ code: "synthetic_declarant_only", status: 400 });
    }
    expectNothingWritten();
  });

  test("a valid request stores the sandbox declarant, and its company and declaration are synthetic", async () => {
    const { companyId, created } = await createCustomerCompany(
      sandboxDeps(),
      owner.address,
      await signed(SANDBOX_TYPED),
    );
    expect(created).toBe(true);
    expect(companies.find(companyId)).toMatchObject({
      provider: "customer",
      environment: "sandbox",
      synthetic: true,
    });
    expect(declarations.find(companyId)).toMatchObject({
      declarantName: "Novi Sandbox Declarant",
      declarantTitle: "Manager",
      synthetic: true,
      statementText: APPROVED.render(fieldsOf(SANDBOX_TYPED, owner.address)),
    });
  });

  test("the filing number must be a test number: ABCD-0001 is refused and TEST-0001 accepted", async () => {
    for (const filingNumber of ["ABCD-0001", "test-0001", "TEST-001"]) {
      const body = await signed({ ...SANDBOX_TYPED, filingNumber });
      expect(
        await refusalOf(createCustomerCompany(sandboxDeps(), owner.address, body)),
      ).toMatchObject({
        code: "validation_error",
        status: 400,
        details: [{ field: "filingNumber" }],
      });
    }
    expectNothingWritten();
    const accepted = await signed({ ...SANDBOX_TYPED, filingNumber: "TEST-0001" });
    expect((await createCustomerCompany(sandboxDeps(), owner.address, accepted)).created).toBe(
      true,
    );
  });
});

describe("a replay", () => {
  test("the same signed body, sent again by a tenant now at its cap, answers the same companyId with created: false", async () => {
    const d = deps({ maxOpenPerTenant: 1 });
    const body = await signed(TYPED);
    const first = await createCustomerCompany(d, owner.address, body);
    expect(first.created).toBe(true);

    // The tenant is at its cap: a new statement is refused…
    const another = await signed({ ...TYPED, filingNumber: "TEST-0002" });
    expect(await refusalOf(createCustomerCompany(d, owner.address, another))).toMatchObject({
      code: "customer_company_cap",
    });
    // …but its own first request, sent again after a lost response, is answered.
    expect(await createCustomerCompany(d, owner.address, body)).toEqual({
      companyId: first.companyId,
      created: false,
    });
    // At the human's cap too, and even once the statement itself has gone stale.
    const capped = deps({ maxOpenPerTenant: 1, world: worldFor({ maxCompaniesPerHuman: 1 }) });
    expect(await refusalOf(createCustomerCompany(capped, owner.address, another))).toMatchObject({
      code: "guardian_company_cap",
    });
    nowMs += 11 * 60 * 1000;
    expect(await createCustomerCompany(capped, owner.address, body)).toEqual({
      companyId: first.companyId,
      created: false,
    });
    expect(rows("companies")).toBe(1);
    expect(rows("company_declarations")).toBe(1);
  });

  test("only the same signature is a replay: the same statement with another signature is checked as a new request", async () => {
    const body = await signed(TYPED);
    await createCustomerCompany(deps(), owner.address, body);
    const otherSignature = await sign(fieldsOf(TYPED, owner.address), {
      signer: stranger,
      issuedAt: BigInt(body.issuedAt),
    });
    expect(
      await refusalOf(
        createCustomerCompany(deps(), owner.address, {
          ...body,
          signature: otherSignature.signature,
        }),
      ),
    ).toMatchObject({ code: "statement_not_valid" });
    expect(rows("company_declarations")).toBe(1);
  });
});

describe("the field rules", () => {
  test("surrounding spaces and a decomposed accent are stored normalised, and the signature covers the normalised form", async () => {
    const typed: CustomerStatementInput = {
      declarantName: "  Rene\u0301e   Example ",
      declarantTitle: " Managing  Member ",
      companyName: "  Example   Holdings LLC ",
      filingNumber: " TEST-0001  ",
    };
    const normalised: StatementFields = {
      declarantName: "Ren\u00E9e Example",
      declarantTitle: "Managing Member",
      companyName: "Example Holdings LLC",
      jurisdiction: "WY",
      filingNumber: "TEST-0001",
      guardian: owner.address,
    };
    // The fields the server will put in front of the wallet are the normalised ones.
    expect(prepareCustomerStatement(deps(), owner.address, typed).fields).toEqual(normalised);
    // A signature over the fields as typed does not match them…
    const asTyped = { ...typed, jurisdiction: "WY", guardian: owner.address } as StatementFields;
    expect(
      await refusalOf(
        createCustomerCompany(deps(), owner.address, { ...typed, ...(await sign(asTyped)) }),
      ),
    ).toMatchObject({ code: "statement_not_valid" });
    // …and one over the normalised fields does, with the fields as typed beside it.
    const { companyId } = await createCustomerCompany(deps(), owner.address, {
      ...typed,
      ...(await sign(normalised)),
    });
    expect(declarations.find(companyId)).toMatchObject({
      declarantName: "Ren\u00E9e Example",
      declarantTitle: "Managing Member",
      companyName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
      statementText: APPROVED.render(normalised),
    });
    expect(companies.find(companyId)?.nameOptions).toEqual([
      { name: "Example Holdings LLC", entityTypeEnding: "LLC", position: 1 },
    ]);
  });

  // Each field's character set would refuse these characters too; the problem shows that the
  // first rule in the order is the one that answered.
  const refusedValues: [
    string,
    "declarantName" | "declarantTitle" | "companyName",
    string,
    string,
  ][] = [
    [
      "a right-to-left override",
      "declarantName",
      "Quill\u202EMarker",
      "holds a control or invisible character",
    ],
    [
      "a zero-width space",
      "companyName",
      "Quill\u200BMarker LLC",
      "holds a control or invisible character",
    ],
    [
      "a non-breaking space",
      "declarantTitle",
      "Quill\u00A0Marker",
      "holds a space other than a plain space",
    ],
    ["a double quote", "declarantName", 'Quill "Marker"', "holds a double quote"],
    [
      "an over-long field",
      "declarantName",
      `Quill${"a".repeat(116)}Marker`,
      "must be 2 to 120 characters long",
    ],
  ];
  test.each(refusedValues)(
    "%s is refused, and the refusal does not repeat the value",
    async (_label, field, value, problem) => {
      const body = { ...(await signed(TYPED)), [field]: value };
      const refusal = await refusalOf(createCustomerCompany(deps(), owner.address, body));
      expect(refusal).toMatchObject({
        code: "validation_error",
        status: 400,
        details: [{ field, problem }],
      });
      const said = JSON.stringify(refusal);
      expect(said).not.toContain("Quill");
      expect(said).not.toContain("Marker");
      expectNothingWritten();
    },
  );

  test("a tab, a line separator and an ideographic space are refused too, never collapsed into a space", () => {
    for (const space of ["\t", "\u2028", "\u3000"]) {
      const refusal = refusalOfCall(() =>
        prepareCustomerStatement(deps(), owner.address, {
          ...TYPED,
          declarantName: `Ada${space}Example`,
        }),
      );
      expect(refusal).toMatchObject({
        code: "validation_error",
        details: [{ field: "declarantName" }],
      });
    }
  });

  /** The fields as the server builds them, or the names of the fields it refused. */
  function outcome(over: Partial<Record<keyof CustomerStatementInput, unknown>>) {
    try {
      return prepareCustomerStatement(deps(), owner.address, {
        ...TYPED,
        ...over,
      } as CustomerStatementInput).fields;
    } catch (err) {
      const details = refusalFrom(err).details as { field: string }[];
      return details.map((d) => d.field);
    }
  }

  test("lengths are counted in code points, after the spaces at the ends are stripped, at both ends of each range", () => {
    const ranges: [
      "declarantName" | "declarantTitle" | "companyName" | "filingNumber",
      number,
      number,
      string,
    ][] = [
      ["declarantName", 2, 120, "a"],
      ["declarantTitle", 2, 80, "a"],
      ["companyName", 2, 200, "a"],
      ["filingNumber", 4, 32, "A"],
    ];
    for (const [field, min, max, ch] of ranges) {
      expect(outcome({ [field]: ch.repeat(min) })).toMatchObject({ [field]: ch.repeat(min) });
      expect(outcome({ [field]: ch.repeat(max) })).toMatchObject({ [field]: ch.repeat(max) });
      expect(outcome({ [field]: ` ${ch.repeat(max)}  ` })).toMatchObject({
        [field]: ch.repeat(max),
      });
      expect(outcome({ [field]: ch.repeat(min - 1) })).toEqual([field]);
      expect(outcome({ [field]: ch.repeat(max + 1) })).toEqual([field]);
    }
    // A letter outside the basic plane is one code point, though it is two UTF-16 units.
    const script = "\u{1D49C}";
    expect(outcome({ declarantName: script.repeat(120) })).toMatchObject({
      declarantName: script.repeat(120),
    });
    expect(outcome({ declarantName: script.repeat(121) })).toEqual(["declarantName"]);
  });

  test("each field takes only its own characters", () => {
    expect(outcome({ declarantName: "Ada O'Example-Smith Jr." })).toMatchObject({
      declarantName: "Ada O'Example-Smith Jr.",
    });
    expect(outcome({ declarantName: "Ada Example 2" })).toEqual(["declarantName"]);
    expect(outcome({ declarantName: "Ada & Example" })).toEqual(["declarantName"]);
    expect(outcome({ declarantTitle: "Member & Manager, 2/3" })).toMatchObject({
      declarantTitle: "Member & Manager, 2/3",
    });
    expect(outcome({ declarantTitle: "Manager #1" })).toEqual(["declarantTitle"]);
    expect(outcome({ companyName: "Example's (Holdings) & Co. + Partners, LLC" })).toMatchObject({
      companyName: "Example's (Holdings) & Co. + Partners, LLC",
    });
    // The character set a Wyoming entity name takes, which leaves accented letters out.
    expect(outcome({ companyName: "Caf\u00E9 Example LLC" })).toEqual(["companyName"]);
    expect(outcome({ companyName: "Example Holdings LLC!" })).toEqual(["companyName"]);
    expect(outcome({ filingNumber: "Test-0001-ab" })).toMatchObject({
      filingNumber: "Test-0001-ab",
    });
    for (const filingNumber of ["TEST_0001", "TEST/0001", "TEST.0001"])
      expect(outcome({ filingNumber })).toEqual(["filingNumber"]);
  });

  test("every bad field is named once, in order; a missing field or one that is not text is a problem too", () => {
    expect(
      outcome({
        declarantName: "A",
        declarantTitle: 7,
        companyName: undefined,
        filingNumber: "TEST 0001",
      }),
    ).toEqual(["declarantName", "declarantTitle", "companyName", "filingNumber"]);
    const nothing = refusalOfCall(() =>
      prepareCustomerStatement(deps(), owner.address, null as unknown as CustomerStatementInput),
    );
    expect(nothing).toMatchObject({ code: "validation_error" });
    expect((nothing.details as { field: string }[]).map((d) => d.field)).toEqual([
      "declarantName",
      "declarantTitle",
      "companyName",
      "filingNumber",
    ]);
  });

  test("issuedAt must be unix seconds in decimal, and the signature 0x and whole bytes of hex", async () => {
    const body = await signed(TYPED);
    const badIssuedAt: unknown[] = ["01", "-1", "1.5", "1e9", " 1", "12345678901234567", 1, null];
    for (const issuedAt of badIssuedAt)
      expect(
        await refusalOf(
          createCustomerCompany(deps(), owner.address, {
            ...body,
            issuedAt,
          } as CustomerCompanyInput),
        ),
      ).toMatchObject({ code: "validation_error", details: [{ field: "issuedAt" }] });
    const badSignatures: unknown[] = ["0x", "0x1", "0xzz", body.signature.slice(2), 65, undefined];
    for (const signature of badSignatures)
      expect(
        await refusalOf(
          createCustomerCompany(deps(), owner.address, {
            ...body,
            signature,
          } as CustomerCompanyInput),
        ),
      ).toMatchObject({ code: "validation_error", details: [{ field: "signature" }] });
    // Both at once, after a bad field: one problem each, in order.
    const all = await refusalOf(
      createCustomerCompany(deps(), owner.address, {
        ...body,
        companyName: "E",
        issuedAt: "x",
        signature: "y" as Hex,
      }),
    );
    expect((all.details as { field: string }[]).map((d) => d.field)).toEqual([
      "companyName",
      "issuedAt",
      "signature",
    ]);
    expectNothingWritten();
  });
});

describe("two concurrent valid requests at maxOpenPerTenant - 1 create exactly one company", () => {
  // The two calls overlap: each runs its checks up to the signature's verification, which awaits,
  // before either reaches the transaction. Both therefore pass the first count of the caps, and
  // only the transaction's own lookup and second count can tell them apart.
  async function atOneBelowTheCap(): Promise<CustomerCompanyDeps> {
    const d = deps({ maxOpenPerTenant: 3 });
    for (const filingNumber of ["TEST-0001", "TEST-0002"])
      await createCustomerCompany(d, owner.address, await signed({ ...TYPED, filingNumber }));
    return d;
  }

  test("with two different statements, the other one is refused with customer_company_cap", async () => {
    const d = await atOneBelowTheCap();
    const a = await signed({ ...TYPED, filingNumber: "TEST-0003" });
    const b = await signed({ ...TYPED, filingNumber: "TEST-0004" });
    const results = await Promise.allSettled([
      createCustomerCompany(d, owner.address, a),
      createCustomerCompany(d, owner.address, b),
    ]);
    const created = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ value: { created: true } });
    expect(refused).toHaveLength(1);
    expect(refusalFrom((refused[0] as PromiseRejectedResult).reason)).toMatchObject({
      code: "customer_company_cap",
      status: 409,
    });
    expect(companies.countCustomerOpenByTenant(owner.address)).toBe(3);
    expect(rows("companies")).toBe(3);
    expect(rows("company_declarations")).toBe(3);
  });

  test("with the same statement, the other one answers the same companyId with created: false", async () => {
    const d = await atOneBelowTheCap();
    const body = await signed({ ...TYPED, filingNumber: "TEST-0003" });
    const [a, b] = await Promise.all([
      createCustomerCompany(d, owner.address, body),
      createCustomerCompany(d, owner.address, body),
    ]);
    expect(a.companyId).toBe(b.companyId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(rows("companies")).toBe(3);
    expect(rows("company_declarations")).toBe(3);
    // The one answered inside the transaction created nothing, so it wrote no ops line.
    expect(opsLines("customer_company_created")).toHaveLength(3);
  });
});

test("the sixth creation in 24 hours is refused, abandoned ones included; a day later the tenant may declare again", async () => {
  const d = deps({ maxOpenPerTenant: 10 });
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const body = await signed({ ...TYPED, filingNumber: `TEST-000${i}` });
    ids.push((await createCustomerCompany(d, owner.address, body)).companyId);
  }
  for (const id of ids.slice(0, 3)) abandonCustomerCompany(d, owner.address, id);
  expect(companies.countCustomerOpenByTenant(owner.address)).toBe(2);

  const sixth = await signed({ ...TYPED, filingNumber: "TEST-0006" });
  expect(await refusalOf(createCustomerCompany(d, owner.address, sixth))).toMatchObject({
    code: "customer_company_rate",
    status: 429,
  });

  nowMs += DAY_MS + HOUR_MS;
  const later = await signed({ ...TYPED, filingNumber: "TEST-0006" });
  expect((await createCustomerCompany(d, owner.address, later)).created).toBe(true);
});

test("two tenants can each create a company for the same filing number: the operator's check decides", async () => {
  recordHuman(second.address, SECOND_NULLIFIER);
  const a = await createCustomerCompany(deps(), owner.address, await signed(TYPED));
  const b = await createCustomerCompany(
    deps(),
    second.address,
    await signed(TYPED, { signer: second }),
  );
  expect([a.created, b.created]).toEqual([true, true]);
  expect(declarations.listByFilingKey("TEST-0001").map((d) => d.tenantId)).toEqual([
    owner.address,
    second.address,
  ]);
});

describe("abandoning a customer company", () => {
  test("an unchecked company becomes abandoned, its declaration is erased, and it leaves both caps", async () => {
    const d = deps({ maxOpenPerTenant: 1, world: worldFor({ maxCompaniesPerHuman: 1 }) });
    const { companyId } = await createCustomerCompany(d, owner.address, await signed(TYPED));
    const next = await signed({ ...TYPED, filingNumber: "TEST-0002" });
    expect(await refusalOf(createCustomerCompany(d, owner.address, next))).toMatchObject({
      code: "guardian_company_cap",
    });

    abandonCustomerCompany(d, owner.address, companyId);

    expect(companies.find(companyId)?.status).toBe("abandoned");
    expect(declarations.find(companyId)).toMatchObject({
      declarantName: null,
      declarantTitle: null,
      statementText: null,
      statementHash: null,
      statementDigest: null,
      signature: null,
      piiErasedAt: Number(nowSeconds()),
      // The company it named, and who declared it, stay.
      companyName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
      humanNullifier: OWNER_NULLIFIER,
    });
    expect(store.countCompaniesForNullifier(OWNER_NULLIFIER, ACTION)).toBe(0);
    expect(companies.countCustomerOpenByTenant(owner.address)).toBe(0);
    expect((await createCustomerCompany(d, owner.address, next)).created).toBe(true);
  });

  test("a company that landed ready is abandoned the same way", async () => {
    const d = deps({ paymentRequired: false });
    const { companyId } = await createCustomerCompany(d, owner.address, await signed(TYPED));
    abandonCustomerCompany(d, owner.address, companyId);
    expect(companies.find(companyId)?.status).toBe("abandoned");
    expect(declarations.find(companyId)?.piiErasedAt).toBe(Number(nowSeconds()));
  });

  test("a checked company, one with a settled payment and one with an open legal body are each refused with conflict", async () => {
    const make = async (filingNumber: string) =>
      (await createCustomerCompany(deps(), owner.address, await signed({ ...TYPED, filingNumber })))
        .companyId;
    const checked = await make("TEST-0001");
    checks.append(failedCheck(checked));
    const paid = await make("TEST-0002");
    paymentRow(paid, "settled");
    const bound = await make("TEST-0003");
    const d = deps({ hasOpenLegalBody: (id) => id === bound });

    for (const companyId of [checked, paid, bound]) {
      expect(
        refusalOfCall(() => abandonCustomerCompany(d, owner.address, companyId)),
      ).toMatchObject({ code: "conflict", status: 409 });
      // Nothing moved, and nothing was erased.
      expect(companies.find(companyId)?.status).toBe("draft");
      expect(declarations.find(companyId)).toMatchObject({
        declarantName: "Ada Example",
        piiErasedAt: null,
      });
    }
  });

  test("an unknown company and another tenant's get the same 404", async () => {
    recordHuman(second.address, SECOND_NULLIFIER);
    const theirs = (
      await createCustomerCompany(deps(), second.address, await signed(TYPED, { signer: second }))
    ).companyId;
    const unknown = refusalOfCall(() =>
      abandonCustomerCompany(deps(), owner.address, "00000000-0000-4000-8000-000000000000"),
    );
    const notYours = refusalOfCall(() => abandonCustomerCompany(deps(), owner.address, theirs));
    expect(unknown).toMatchObject({ code: "not_found", status: 404 });
    expect(notYours).toEqual(unknown);
    expect(companies.find(theirs)?.status).toBe("draft");
  });

  test("an abandoned company, and the tenant's own formation company, are a conflict", async () => {
    const { companyId } = await createCustomerCompany(deps(), owner.address, await signed(TYPED));
    abandonCustomerCompany(deps(), owner.address, companyId);
    expect(
      refusalOfCall(() => abandonCustomerCompany(deps(), owner.address, companyId)),
    ).toMatchObject({ code: "conflict", status: 409 });
    const formation = companyRow({ provider: FORMATION_PROVIDER });
    expect(
      refusalOfCall(() => abandonCustomerCompany(deps(), owner.address, formation)),
    ).toMatchObject({ code: "conflict", status: 409 });
    expect(companies.find(formation)?.status).toBe("draft");
  });

  test("the status and the erasure are one transaction: a declaration that cannot be erased leaves the company as it was", () => {
    // A customer company with no declaration cannot arise from the create; written by hand here.
    const orphan = companyRow({});
    expect(() => abandonCustomerCompany(deps(), owner.address, orphan)).toThrow();
    expect(companies.find(orphan)?.status).toBe("draft");
  });
});

describe("the counts behind the caps", () => {
  test("countCustomerOpenByTenant counts the tenant's own customer companies in draft or ready, and nothing else", () => {
    companyRow({ status: "draft" });
    companyRow({ status: "ready" });
    companyRow({ status: "abandoned" });
    companyRow({ provider: FORMATION_PROVIDER, status: "ready" });
    companyRow({ tenantId: second.address, status: "ready" });
    expect(companies.countCustomerOpenByTenant(owner.address)).toBe(2);
    expect(companies.countCustomerOpenByTenant(second.address)).toBe(1);
  });

  test("hasLiveOrSettledPayment: a quoted, settling, settled or refunded payment, never an expired or failed one", () => {
    for (const status of ["quoted", "settling", "settled", "refunded"]) {
      paymentRow(`company-${status}`, status);
      expect(companies.hasLiveOrSettledPayment(`company-${status}`)).toBe(true);
    }
    for (const status of ["expired", "failed"]) {
      paymentRow(`company-${status}`, status);
      expect(companies.hasLiveOrSettledPayment(`company-${status}`)).toBe(false);
    }
    expect(companies.hasLiveOrSettledPayment("company-without-payments")).toBe(false);
  });

  test("countCompaniesForNullifier leaves out only a customer company abandoned before any check", () => {
    companyRow({ status: "draft" });
    companyRow({ status: "ready" });
    companyRow({ status: "abandoned" }); // left out
    const checkedThenAbandoned = companyRow({ status: "draft" });
    checks.append(failedCheck(checkedThenAbandoned));
    expect(companies.setStatus(checkedThenAbandoned, "draft", "abandoned")).toBe(true);
    companyRow({ provider: FORMATION_PROVIDER, status: "abandoned" });
    companyRow({ provider: FORMATION_PROVIDER, status: "ready" });
    companyRow({ tenantId: second.address, status: "ready" });
    expect(store.countCompaniesForNullifier(OWNER_NULLIFIER, ACTION)).toBe(5);
  });
});

test("one ops line per company created, with no personal field in it; a replay writes none", async () => {
  const typed: CustomerStatementInput = {
    declarantName: "Ada Example",
    declarantTitle: "Managing Member",
    companyName: "Example Holdings LLC",
    filingNumber: "TEST-4242",
  };
  const body = await signed(typed);
  const { companyId } = await createCustomerCompany(deps(), owner.address, body);
  await createCustomerCompany(deps(), owner.address, body);
  const sandbox = await createCustomerCompany(
    sandboxDeps(),
    owner.address,
    await signed({ ...SANDBOX_TYPED, filingNumber: "TEST-4343" }),
  );

  const lines = opsLines("customer_company_created");
  expect(lines).toHaveLength(2);
  const [production, synthetic] = lines.map((line) => JSON.parse(line));
  expect(Object.keys(production).sort()).toEqual([
    "at",
    "companyId",
    "environment",
    "opslog",
    "synthetic",
    "tenantPrefix",
  ]);
  expect(production).toMatchObject({
    companyId,
    tenantPrefix: owner.address.slice(0, 10),
    environment: "production",
    synthetic: false,
  });
  expect(synthetic).toMatchObject({
    companyId: sandbox.companyId,
    environment: "sandbox",
    synthetic: true,
  });
  // Nothing the create printed holds a name, a title or a filing number.
  const all = printed().join("\n");
  for (const value of [
    "Ada Example",
    "Managing Member",
    "Novi Sandbox Declarant",
    "Example Holdings",
    "TEST-4242",
    "TEST4242",
    "TEST-4343",
  ])
    expect(all).not.toContain(value);
});
