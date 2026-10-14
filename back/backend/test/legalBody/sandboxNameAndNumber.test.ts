/**
 * Two sandbox rules at the declaration doors. A sandbox declaration writes its own passed check,
 * so nobody stands between two declarations of one number there, and a stranger could take a
 * sandbox record for a real company's. So, on a sandbox deployment only: the company name must
 * say it is a test, and a test filing number is declared once. A number is held by a company that
 * is not abandoned and whose latest check passed. Both doors refuse a held number: the statement
 * door before anything is signed, and the create door after its replay lookup, so a request sent
 * again still finds its own company. On production both doors behave as before: two tenants may
 * declare one number, and the operator decides.
 *
 * Every name, company and filing number here is an invention, and the keys are anvil's published
 * test accounts.
 */
import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/errors";
import {
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
  statementTypedDataWire,
  verifyStatement,
} from "../../src/legalBody/statement";
import type { StatementFields } from "../../src/legalBody/texts/statementOfAuthority";
import { filingKeyOf } from "../../src/persistence/companyDeclarationRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  SANDBOX_TYPED,
  type Signer,
  customerCompanyDeps,
  recordHuman,
  sandboxCustomerCompanyDeps,
} from "../helpers/customerCompanyFixtures";
import {
  type LegalBodyStores,
  appendCheck,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/** anvil's published accounts #2 and #3: test keys, never real wallets. */
const owner = ANVIL_ACCOUNT_2;
const second = ANVIL_ACCOUNT_3;

/** A declaration as a production caller sends it: its declarant typed, and no synthetic flag. */
const PRODUCTION_TYPED: CustomerStatementInput = {
  declarantName: "Ada Example",
  declarantTitle: "Manager",
  companyName: "Example Holdings LLC",
  filingNumber: "EX-0001",
};

/** The refusal's sentence, and the problem each rule names. */
const NOT_VALID = "some fields of the declaration are not valid";
const NAME_PROBLEM = "must say it is a test on this deployment";
const NUMBER_PROBLEM = "is already declared on this deployment: choose another test number";

let db: Database.Database;
let s: LegalBodyStores;
let nowMs: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  // A created company writes an ops line: kept off the test's output.
  vi.spyOn(console, "log").mockImplementation(() => {});
  recordHuman(s.store, owner.address, "1001", nowMs);
  recordHuman(s.store, second.address, "1002", nowMs);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The doors of a sandbox deployment that does not charge, on the test's clock. */
const sandbox = (over: Partial<CustomerCompanyDeps> = {}) =>
  sandboxCustomerCompanyDeps(s, () => nowMs, { paymentRequired: false, ...over });
/** The doors of a production deployment that charges, on the test's clock. */
const production = (over: Partial<CustomerCompanyDeps> = {}) =>
  customerCompanyDeps(s, () => nowMs, over);

/** The body a client sends once its wallet signed the served statement, as it came over JSON. */
async function signed(
  deps: CustomerCompanyDeps,
  who: Signer,
  typed: CustomerStatementInput,
): Promise<CustomerCompanyInput> {
  const { fields } = prepareCustomerStatement(deps, who.address, typed);
  return signedFields(deps, who, typed, fields);
}

/**
 * A sandbox body signed over fields written out here, not served by the statement door: what a
 * client sends when it signed a statement the door would refuse now, or never asked for one.
 */
async function signedOutsideTheDoor(
  deps: CustomerCompanyDeps,
  who: Signer,
  typed: CustomerStatementInput,
): Promise<CustomerCompanyInput> {
  return signedFields(deps, who, typed, {
    declarantName: SYNTHETIC_DECLARANT.name,
    declarantTitle: SYNTHETIC_DECLARANT.title,
    companyName: typed.companyName,
    jurisdiction: "WY",
    filingNumber: typed.filingNumber,
    guardian: who.address,
  });
}

async function signedFields(
  deps: CustomerCompanyDeps,
  who: Signer,
  typed: CustomerStatementInput,
  fields: StatementFields,
): Promise<CustomerCompanyInput> {
  const issuedAt = BigInt(Math.floor((deps.now ?? Date.now)() / 1000));
  const served = statementTypedDataWire(
    deps.chainId,
    deps.factory,
    buildStatementMessage(fields, deps.text, issuedAt),
  );
  const signature = await who.signTypedData(JSON.parse(JSON.stringify(served)));
  return { ...typed, issuedAt: served.message.issuedAt, signature };
}

/** A company declared through the create door with its guardian's signed statement. */
async function declare(
  deps: CustomerCompanyDeps,
  who: Signer,
  typed: CustomerStatementInput,
): Promise<string> {
  const { companyId, created } = await createCustomerCompany(
    deps,
    who.address,
    await signed(deps, who, typed),
  );
  expect(created).toBe(true);
  return companyId;
}

function refusalOf(call: () => unknown): ApiError {
  try {
    call();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

async function asyncRefusalOf(call: Promise<unknown>): Promise<ApiError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

/** The refusal of one field, whole: the code, the status, the sentence and the one problem. */
const fieldRefusal = (field: string, problem: string) => ({
  code: "validation_error",
  status: 400,
  message: NOT_VALID,
  details: [{ field, problem }],
});

/** What a refusal carries, read off the error. */
const shapeOf = (err: ApiError) => ({
  code: err.code,
  status: err.status,
  message: err.message,
  details: err.details,
});

const rows = (table: "companies" | "company_declarations" | "company_checks"): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * The same 65-byte signature with its recovery byte written as 0 or 1 in place of 27 or 28:
 * another string, for the same signer over the same digest.
 */
function otherRecoveryEncoding(signature: Hex): Hex {
  const v = Number.parseInt(signature.slice(-2), 16);
  if (v !== 27 && v !== 28) throw new Error(`a recovery byte of ${v}, not 27 or 28`);
  return `${signature.slice(0, -2)}0${v - 27}` as Hex;
}

/** A pass as the operator records one, for the company's declared name and number. */
function operatorPass(companyId: string, typed: CustomerStatementInput): void {
  s.checks.append({
    companyId,
    result: "passed",
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: Math.floor(nowMs / 1000),
    registryName: typed.companyName,
    registryFilingId: typed.filingNumber,
    registryStatus: "Active",
    formationDate: "2024-02-29",
    registeredAgent: "Example Registered Agent LLC",
    existenceEvidenceSha256: `0x${"e1".repeat(32)}`,
    controlEvidenceSha256: `0x${"c1".repeat(32)}`,
    controlEvidenceKind: "ein_letter",
    reasonCode: null,
    reason: null,
  });
}

describe("on a sandbox, the company name says it is a test", () => {
  test("a name without the word is refused at the statement door, under companyName, with the rule's own problem", () => {
    const refused = refusalOf(() =>
      prepareCustomerStatement(sandbox(), owner.address, {
        ...SANDBOX_TYPED,
        companyName: "Example Holdings LLC",
      }),
    );
    expect(shapeOf(refused)).toEqual(fieldRefusal("companyName", NAME_PROBLEM));
  });

  test("the create door refuses the same name, and writes nothing", async () => {
    const deps = sandbox();
    const body = await signedOutsideTheDoor(deps, owner, {
      ...SANDBOX_TYPED,
      companyName: "Example Holdings LLC",
    });
    const refused = await asyncRefusalOf(createCustomerCompany(deps, owner.address, body));
    expect(shapeOf(refused)).toEqual(fieldRefusal("companyName", NAME_PROBLEM));
    expect(rows("companies")).toBe(0);
    expect(rows("company_declarations")).toBe(0);
    expect(rows("company_checks")).toBe(0);
  });

  test.each([
    "Example Test Holdings LLC",
    "TEST Holdings LLC",
    "Northwind Validator Test LLC",
    "Latest Test LLC",
  ])("%s says it, in any case, and is served", (companyName) => {
    const { fields } = prepareCustomerStatement(sandbox(), owner.address, {
      ...SANDBOX_TYPED,
      companyName,
    });
    expect(fields.companyName).toBe(companyName);
  });

  test("the word must stand on its own: Contest LLC and Latest Holdings LLC are refused", () => {
    for (const companyName of ["Contest LLC", "Latest Holdings LLC"]) {
      const refused = refusalOf(() =>
        prepareCustomerStatement(sandbox(), owner.address, { ...SANDBOX_TYPED, companyName }),
      );
      expect(shapeOf(refused), companyName).toEqual(fieldRefusal("companyName", NAME_PROBLEM));
    }
  });

  test("a sandbox company is created under the fixture's name, which says it", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    expect(s.declarations.find(companyId)?.companyName).toBe(SANDBOX_TYPED.companyName);
  });

  test("on production the same name is served and created without the word", async () => {
    const { fields } = prepareCustomerStatement(production(), owner.address, PRODUCTION_TYPED);
    expect(fields.companyName).toBe("Example Holdings LLC");
    const companyId = await declare(production(), owner, PRODUCTION_TYPED);
    expect(s.declarations.find(companyId)?.companyName).toBe("Example Holdings LLC");
  });
});

describe("on a sandbox, a test number is declared once", () => {
  test("another tenant asking for the statement of a held number is refused under filingNumber, before anything is signed", async () => {
    const holder = await declare(sandbox(), owner, SANDBOX_TYPED);
    expect(s.checks.passedElsewhere(filingKeyOf(SANDBOX_TYPED.filingNumber), "")).toBe(holder);

    const refused = refusalOf(() =>
      prepareCustomerStatement(sandbox(), second.address, SANDBOX_TYPED),
    );
    expect(shapeOf(refused)).toEqual(fieldRefusal("filingNumber", NUMBER_PROBLEM));
  });

  test("the create door refuses the same, and writes nothing", async () => {
    const deps = sandbox();
    await declare(deps, owner, SANDBOX_TYPED);
    const body = await signedOutsideTheDoor(deps, second, SANDBOX_TYPED);

    const refused = await asyncRefusalOf(createCustomerCompany(deps, second.address, body));
    expect(shapeOf(refused)).toEqual(fieldRefusal("filingNumber", NUMBER_PROBLEM));
    expect(s.companies.listByTenant(second.address)).toEqual([]);
    expect(rows("companies")).toBe(1);
    expect(rows("company_declarations")).toBe(1);
    expect(rows("company_checks")).toBe(1);
  });

  test("the number is matched by its filing key: hyphens placed elsewhere do not make it another", async () => {
    await declare(sandbox(), owner, SANDBOX_TYPED);
    const respelled = { ...SANDBOX_TYPED, filingNumber: "TEST-00-01" };
    expect(filingKeyOf(respelled.filingNumber)).toBe(filingKeyOf(SANDBOX_TYPED.filingNumber));

    const refused = refusalOf(() => prepareCustomerStatement(sandbox(), second.address, respelled));
    expect(shapeOf(refused)).toEqual(fieldRefusal("filingNumber", NUMBER_PROBLEM));
  });

  test("the tenant's own signed statement sent again still answers its company with created: false; a new statement of the number is refused", async () => {
    const deps = sandbox();
    const body = await signed(deps, owner, SANDBOX_TYPED);
    const first = await createCustomerCompany(deps, owner.address, body);
    expect(first.created).toBe(true);

    // The replay is looked up before the number: the request finds its own company, not a holder.
    expect(await createCustomerCompany(deps, owner.address, body)).toEqual({
      companyId: first.companyId,
      created: false,
    });
    expect(rows("companies")).toBe(1);
    expect(rows("company_checks")).toBe(1);

    // Its own company holds the number now: a statement asked for again is a new declaration.
    const refused = refusalOf(() => prepareCustomerStatement(deps, owner.address, SANDBOX_TYPED));
    expect(shapeOf(refused)).toEqual(fieldRefusal("filingNumber", NUMBER_PROBLEM));
  });

  test("the same statement signed again, with a second valid signature that is another string, answers its company with created: false and writes nothing more", async () => {
    const deps = sandbox();
    const { fields } = prepareCustomerStatement(deps, owner.address, SANDBOX_TYPED);
    const body = await signed(deps, owner, SANDBOX_TYPED);
    const again = { ...body, signature: otherRecoveryEncoding(body.signature) };
    expect(again.signature).not.toBe(body.signature);

    // The door's own signature check accepts both, for one digest: the same statement.
    const verdictOf = (signature: Hex) =>
      verifyStatement({
        chainId: deps.chainId,
        factory: deps.factory,
        tenant: owner.address,
        text: deps.text,
        fields,
        issuedAt: BigInt(body.issuedAt),
        signature,
        nowSeconds: BigInt(Math.floor(nowMs / 1000)),
      });
    const [one, two] = [await verdictOf(body.signature), await verdictOf(again.signature)];
    if (!one.ok || !two.ok) throw new Error("the door's check refused a signature");
    expect(two.digest).toBe(one.digest);

    const first = await createCustomerCompany(deps, owner.address, body);
    expect(first.created).toBe(true);

    // Not a replay at the first lookup, since the signature differs; its own company does not hold
    // the number against it, and the transaction's lookup answers that company.
    expect(await createCustomerCompany(deps, owner.address, again)).toEqual({
      companyId: first.companyId,
      created: false,
    });
    expect(rows("companies")).toBe(1);
    expect(rows("company_declarations")).toBe(1);
    expect(rows("company_checks")).toBe(1);
    expect(s.declarations.find(first.companyId)?.signature).toBe(body.signature);
  });

  test("a held number is refused before the caps: a tenant at its cap is told about the number", async () => {
    const deps = sandbox({ maxOpenPerTenant: 1 });
    await declare(deps, owner, SANDBOX_TYPED);
    await declare(deps, second, { ...SANDBOX_TYPED, filingNumber: "TEST-0002" });
    const body = await signedOutsideTheDoor(deps, second, SANDBOX_TYPED);

    const refused = await asyncRefusalOf(createCustomerCompany(deps, second.address, body));
    expect(shapeOf(refused)).toEqual(fieldRefusal("filingNumber", NUMBER_PROBLEM));
  });

  test("two tenants declaring one number at the same time: one company is created, and the other is refused", async () => {
    const deps = sandbox();
    // Both signed while the number was free, and both pass the first look before either writes:
    // the second meets the first's check inside its own transaction.
    const [a, b] = [
      await signed(deps, owner, SANDBOX_TYPED),
      await signed(deps, second, SANDBOX_TYPED),
    ];
    const settled = await Promise.allSettled([
      createCustomerCompany(deps, owner.address, a),
      createCustomerCompany(deps, second.address, b),
    ]);

    const created = settled.filter((r) => r.status === "fulfilled");
    const refused = settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(ApiError);
    expect(shapeOf(refused[0])).toEqual(fieldRefusal("filingNumber", NUMBER_PROBLEM));
    expect(rows("companies")).toBe(1);
    expect(rows("company_declarations")).toBe(1);
    expect(rows("company_checks")).toBe(1);
  });

  test("after its holder is abandoned, the number is served and declared again", async () => {
    const holder = await declare(sandbox(), owner, SANDBOX_TYPED);
    abandonCustomerCompany(sandbox(), owner.address, holder);

    const { fields } = prepareCustomerStatement(sandbox(), second.address, SANDBOX_TYPED);
    expect(fields.filingNumber).toBe(SANDBOX_TYPED.filingNumber);
    const next = await declare(sandbox(), second, SANDBOX_TYPED);
    expect(s.checks.passedElsewhere(filingKeyOf(SANDBOX_TYPED.filingNumber), "")).toBe(next);
  });

  test("a holder whose latest check failed holds nothing: the number is served and declared again", async () => {
    const holder = await declare(sandbox(), owner, SANDBOX_TYPED);
    // After its automatic pass, an operator's failure: the latest check is the failed one.
    appendCheck(s.checks, holder, "failed");
    expect(s.checks.latest(holder)?.result).toBe("failed");
    expect(s.companies.find(holder)?.status).not.toBe("abandoned");

    const { fields } = prepareCustomerStatement(sandbox(), second.address, SANDBOX_TYPED);
    expect(fields.filingNumber).toBe(SANDBOX_TYPED.filingNumber);
    const next = await declare(sandbox(), second, SANDBOX_TYPED);
    expect(s.checks.passedElsewhere(filingKeyOf(SANDBOX_TYPED.filingNumber), "")).toBe(next);
  });
});

describe("on production, one number is not the doors' to refuse", () => {
  test("two tenants declare one number and both are created (the door's 201), even when the first holds a passed check for it", async () => {
    const first = await declare(production(), owner, PRODUCTION_TYPED);
    operatorPass(first, PRODUCTION_TYPED);
    expect(s.checks.passedElsewhere(filingKeyOf(PRODUCTION_TYPED.filingNumber), "")).toBe(first);

    const { fields } = prepareCustomerStatement(production(), second.address, PRODUCTION_TYPED);
    expect(fields.filingNumber).toBe(PRODUCTION_TYPED.filingNumber);
    const next = await declare(production(), second, PRODUCTION_TYPED);
    expect(next).not.toBe(first);
    expect(rows("companies")).toBe(2);
  });
});
