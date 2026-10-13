/**
 * The sandbox's automatic check. A sandbox deployment has nobody on duty to check a declaration, so
 * the declaration writes its own passed check, inside its own transaction, and every field of that
 * check says it examined nothing. The company is verified from its first read, an order can be
 * placed on it at once, and the signed public statement over it reads active, with filing facts
 * counted from the declaration day and the sandbox said out loud. An automatic check does not keep
 * a company from being abandoned, and an abandoned company holds no filing number. A production
 * declaration writes nothing new.
 *
 * Every name, company and filing number here is an invention, and the keys are anvil's published
 * test accounts.
 */
import type Database from "better-sqlite3";
import { sha256, stringToBytes } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toCompanyView } from "../../src/api/views";
import { ApiError } from "../../src/errors";
import { attestationFactsFor, deriveAttestationState } from "../../src/legalBody/attestation";
import {
  type CustomerCompanyDeps,
  type CustomerCompanyInput,
  type CustomerStatementInput,
  STALE_CUSTOMER_SECONDS,
  SYNTHETIC_DECLARANT,
  abandonCustomerCompany,
  createCustomerCompany,
  expireStaleCustomerCompanies,
  prepareCustomerStatement,
} from "../../src/legalBody/customerCompany";
import { acceptEvidence } from "../../src/legalBody/evidence";
import { companyEligible, createOrder } from "../../src/legalBody/orders";
import {
  SANDBOX_AUTOMATIC_OPERATOR,
  SANDBOX_AUTOMATIC_SENTINEL,
  SANDBOX_AUTOMATIC_SENTINEL_SHA256,
  SANDBOX_REGISTERED_AGENT,
  SANDBOX_REGISTRY_STATUS,
  automaticSandboxCheck,
  isAutomaticSandboxCheck,
  processOsUser,
} from "../../src/legalBody/sandboxCheck";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import { statementForAgent } from "../../src/legalBody/statements";
import { validateCompanyCheck } from "../../src/persistence/companyCheckRepository";
import { filingKeyOf } from "../../src/persistence/companyDeclarationRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import { wyomingDate } from "../../src/util/wyomingCalendar";
import {
  ACTION,
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  SANDBOX_TYPED,
  type Signer,
  customerCompanyDeps,
  recordHuman,
  sandboxCustomerCompanyDeps,
} from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import {
  type LegalBodyStores,
  appendCheck,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";
import {
  CLOCK_MS,
  CLOCK_S,
  FakeStatementChain,
  bodyIn,
  openStatementStores,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

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

/** The refusal of abandoning a company its check keeps: the door's sentence, unchanged. */
const KEPT = "the operator has checked this company's declaration, so it is kept";

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

const nowSeconds = (): number => Math.floor(nowMs / 1000);

/** The body a client sends once its wallet signed the served statement, as it came over JSON. */
async function signed(
  deps: CustomerCompanyDeps,
  who: Signer,
  typed: CustomerStatementInput,
): Promise<CustomerCompanyInput> {
  const { fields } = prepareCustomerStatement(deps, who.address, typed);
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

const checkRows = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM company_checks").get() as { n: number }).n;

/** The company's attestation, derived from the facts as they are now. No legal body is revoked. */
function attestationOf(companyId: string) {
  const facts = attestationFactsFor(
    { companies: s.companies, checks: s.checks, formationSteps: () => [] },
    companyId,
    false,
  );
  if (facts === undefined) throw new Error(`no company ${companyId}`);
  return deriveAttestationState(facts);
}

/** The tenant's own view of a customer company, with its declaration and latest check. */
function viewOf(companyId: string) {
  const company = s.companies.find(companyId);
  if (company === undefined) throw new Error(`no company ${companyId}`);
  return toCompanyView(company, [], false, 0, {
    declaration: s.declarations.find(companyId),
    latestCheck: s.checks.latest(companyId),
  });
}

describe("the check a sandbox declaration writes", () => {
  test("the operator's name, the sentence and the two sandbox values are the exact ones, and the evidence hash is the sha256 of the sentence", () => {
    expect(SANDBOX_AUTOMATIC_OPERATOR).toBe("sandbox-automatic");
    expect(SANDBOX_AUTOMATIC_SENTINEL).toBe(
      "Novi Corpus sandbox: this check was written automatically and examined no evidence.",
    );
    expect(SANDBOX_REGISTRY_STATUS).toBe("sandbox");
    expect(SANDBOX_REGISTERED_AGENT).toBe("sandbox");
    expect(SANDBOX_AUTOMATIC_SENTINEL_SHA256).toBe(
      sha256(stringToBytes(SANDBOX_AUTOMATIC_SENTINEL)),
    );
    expect(SANDBOX_AUTOMATIC_SENTINEL_SHA256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("one passed check, every field of which says it examined nothing, and the stored row passes the repository's own rules", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    const checks = s.checks.list(companyId);
    expect(checks).toHaveLength(1);
    const [check] = checks;
    if (check === undefined) throw new Error("no check");
    const checkedAt = nowSeconds();
    // Exactly these keys: no annual report is recorded.
    expect(check).toStrictEqual({
      checkId: check.checkId,
      companyId,
      result: "passed",
      operator: SANDBOX_AUTOMATIC_OPERATOR,
      operatorOsUser: check.operatorOsUser,
      checkedAt,
      registryName: SANDBOX_TYPED.companyName,
      registryFilingId: SANDBOX_TYPED.filingNumber,
      filingKey: filingKeyOf(SANDBOX_TYPED.filingNumber),
      registryStatus: SANDBOX_REGISTRY_STATUS,
      formationDate: wyomingDate(checkedAt),
      registeredAgent: SANDBOX_REGISTERED_AGENT,
      existenceEvidenceSha256: SANDBOX_AUTOMATIC_SENTINEL_SHA256,
      controlEvidenceSha256: SANDBOX_AUTOMATIC_SENTINEL_SHA256,
      controlEvidenceKind: "other",
      reasonCode: null,
      reason: null,
    });
    expect(check.operatorOsUser.length).toBeGreaterThan(0);
    const { checkId: _id, filingKey: _key, ...asNew } = check;
    expect(validateCompanyCheck(asNew)).toEqual(asNew);
  });

  test("its registry name and number are the declared ones as the door normalised them", async () => {
    const companyId = await declare(sandbox(), owner, {
      ...SANDBOX_TYPED,
      companyName: `  ${SANDBOX_TYPED.companyName.replace(" ", "  ")} `,
      filingNumber: ` ${SANDBOX_TYPED.filingNumber} `,
    });
    expect(s.checks.latest(companyId)).toMatchObject({
      registryName: SANDBOX_TYPED.companyName,
      registryFilingId: SANDBOX_TYPED.filingNumber,
    });
  });

  test("automaticSandboxCheck builds the row from what it is given, its formation date the Wyoming day of the check", () => {
    const row = automaticSandboxCheck({
      companyId: "co_example",
      companyName: SANDBOX_TYPED.companyName,
      filingNumber: SANDBOX_TYPED.filingNumber,
      checkedAt: CLOCK_S,
      osUser: "example-user",
    });
    expect(row).toStrictEqual({
      companyId: "co_example",
      result: "passed",
      operator: SANDBOX_AUTOMATIC_OPERATOR,
      operatorOsUser: "example-user",
      checkedAt: CLOCK_S,
      registryName: SANDBOX_TYPED.companyName,
      registryFilingId: SANDBOX_TYPED.filingNumber,
      registryStatus: SANDBOX_REGISTRY_STATUS,
      formationDate: wyomingDate(CLOCK_S),
      registeredAgent: SANDBOX_REGISTERED_AGENT,
      existenceEvidenceSha256: SANDBOX_AUTOMATIC_SENTINEL_SHA256,
      controlEvidenceSha256: SANDBOX_AUTOMATIC_SENTINEL_SHA256,
      controlEvidenceKind: "other",
      reasonCode: null,
      reason: null,
    });
    expect(validateCompanyCheck(row)).toEqual(row);
  });

  test("processOsUser names a user, never an empty one", () => {
    expect(typeof processOsUser()).toBe("string");
    expect(processOsUser().length).toBeGreaterThan(0);
  });
});

describe("a sandbox company, checked from its creation", () => {
  test("its view reads verified and ready from the first read, and its attestation is active", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    const view = viewOf(companyId);
    expect(view).toMatchObject({ provider: "customer", state: "ready" });
    expect(view.verification).toEqual({
      state: "verified",
      checkedAt: nowSeconds(),
      reasonCode: null,
    });
    expect(attestationOf(companyId)).toMatchObject({
      state: "active",
      established: true,
      controlVerified: true,
      existenceCheckedAt: nowSeconds(),
    });
  });

  test("on a sandbox that charges, the same check is written: verified at once, and pending until paid", async () => {
    const companyId = await declare(sandbox({ paymentRequired: true }), owner, SANDBOX_TYPED);
    expect(s.companies.find(companyId)?.status).toBe("draft");
    expect(s.checks.list(companyId)).toMatchObject([
      { result: "passed", operator: SANDBOX_AUTOMATIC_OPERATOR },
    ]);
    expect(viewOf(companyId).verification).toMatchObject({ state: "verified" });
    expect(attestationOf(companyId)).toMatchObject({
      state: "pending",
      established: true,
      controlVerified: true,
    });
  });

  test("an order can be placed on it at once", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    const deps = legalBodyOrderDeps(s);
    expect(companyEligible(deps, companyId)).toBe(true);
    expect(createOrder(deps, owner.address, { companyId })).toMatchObject({
      companyId,
      state: "draft",
      agreement: { version: 1 },
    });
  });

  test("the request sent again answers its company and writes no second check", async () => {
    const deps = sandbox();
    const body = await signed(deps, owner, SANDBOX_TYPED);
    const first = await createCustomerCompany(deps, owner.address, body);
    expect(first.created).toBe(true);
    expect(await createCustomerCompany(deps, owner.address, body)).toEqual({
      companyId: first.companyId,
      created: false,
    });
    expect(s.checks.list(first.companyId)).toHaveLength(1);
    expect(checkRows()).toBe(1);
  });

  test("two copies of the request at the same time make one company and one check", async () => {
    const deps = sandbox();
    const body = await signed(deps, owner, SANDBOX_TYPED);
    // Both pass the replay lookup before either writes: the second finds the first's declaration
    // inside its own transaction.
    const [a, b] = await Promise.all([
      createCustomerCompany(deps, owner.address, body),
      createCustomerCompany(deps, owner.address, body),
    ]);
    expect([a, b].filter((answer) => answer.created)).toHaveLength(1);
    expect(a.companyId).toBe(b.companyId);
    expect(s.companies.listByTenant(owner.address)).toHaveLength(1);
    expect(checkRows()).toBe(1);
  });
});

describe("a production declaration", () => {
  test("writes no check: the company awaits the operator, and no order can be placed on it", async () => {
    const companyId = await declare(production(), owner, PRODUCTION_TYPED);
    expect(s.checks.list(companyId)).toEqual([]);
    expect(viewOf(companyId).verification).toEqual({
      state: "awaiting_check",
      checkedAt: null,
      reasonCode: null,
    });
    expect(companyEligible(legalBodyOrderDeps(s), companyId)).toBe(false);
  });
});

describe("the signed public statement over a sandbox declaration", () => {
  test("reads active and controlVerified, says sandbox, and counts its filing facts from the declaration day", async () => {
    const st = openStatementStores();
    try {
      recordHuman(st.store, owner.address, "2001", CLOCK_MS - 60_000);
      // The declaration is made on the statement service's fixed clock.
      const deps = sandboxCustomerCompanyDeps(st, () => CLOCK_MS, { paymentRequired: false });
      const { companyId } = await createCustomerCompany(
        deps,
        owner.address,
        await signed(deps, owner, SANDBOX_TYPED),
      );
      const row = bodyIn("linked", st, companyId, { tenant: owner.address, agentId: "77" });
      const chain = new FakeStatementChain();
      chain.link(row);

      const out = await statementForAgent(statementDeps(st, chain), "77");
      if (out.kind !== "statement") throw new Error(`no statement: ${out.kind}`);

      // The declaration day, and the first annual report due a year on, from the fixed clock.
      const declaredOn = wyomingDate(CLOCK_S);
      const firstDue = `${Number(declaredOn.slice(0, 4)) + 1}-${declaredOn.slice(5, 7)}-01`;
      expect(out.standing).toBe("active");
      expect(out.statement.message).toMatchObject({
        standing: "active",
        attestationState: "active",
        environment: "sandbox",
        controlVerified: true,
        existenceCheckedAt: String(CLOCK_S),
        legalName: SANDBOX_TYPED.companyName,
        filingNumber: SANDBOX_TYPED.filingNumber,
        filedAt: declaredOn,
        filingStatus: "not_yet_due",
        lastFiledPeriod: "0",
        lastFiledAt: "",
        nextDue: firstDue,
      });
    } finally {
      st.db.close();
    }
  });
});

describe("abandoning a company", () => {
  test("a sandbox company with only its automatic check is abandoned, and its declarant's fields are erased", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);

    // Returning is the door's success: its route answers 204.
    abandonCustomerCompany(sandbox(), owner.address, companyId);

    expect(s.companies.find(companyId)?.status).toBe("abandoned");
    expect(s.declarations.find(companyId)).toMatchObject({
      declarantName: null,
      declarantTitle: null,
      statementText: null,
      statementHash: null,
      statementDigest: null,
      signature: null,
      piiErasedAt: nowSeconds(),
      // The company it named stays.
      companyName: SANDBOX_TYPED.companyName,
      filingNumber: SANDBOX_TYPED.filingNumber,
    });
  });

  test("a sandbox company whose latest check is an operator's pass is kept, with the door's sentence, and nothing moves", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    appendCheck(s.checks, companyId, "passed");

    expect(
      refusalOf(() => abandonCustomerCompany(sandbox(), owner.address, companyId)),
    ).toMatchObject({ code: "conflict", status: 409, message: KEPT });
    expect(s.companies.find(companyId)?.status).toBe("ready");
    expect(s.declarations.find(companyId)).toMatchObject({
      declarantName: SYNTHETIC_DECLARANT.name,
      piiErasedAt: null,
    });
  });

  test("a production company whose check passed is kept, even when the check carries the automatic operator's name", async () => {
    const companyId = await declare(production(), owner, PRODUCTION_TYPED);
    s.checks.append(
      automaticSandboxCheck({
        companyId,
        companyName: PRODUCTION_TYPED.companyName,
        filingNumber: PRODUCTION_TYPED.filingNumber,
        checkedAt: nowSeconds(),
        osUser: "ops",
      }),
    );

    expect(
      refusalOf(() => abandonCustomerCompany(production(), owner.address, companyId)),
    ).toMatchObject({ code: "conflict", status: 409, message: KEPT });
    expect(s.companies.find(companyId)?.status).toBe("draft");
  });

  test("the company's own environment decides, never the deployment's: a sandbox company is abandoned under production doors, a production one kept under sandbox doors", async () => {
    const onSandbox = await declare(sandbox(), owner, SANDBOX_TYPED);
    abandonCustomerCompany(production(), owner.address, onSandbox);
    expect(s.companies.find(onSandbox)?.status).toBe("abandoned");

    const onProduction = await declare(production(), owner, PRODUCTION_TYPED);
    s.checks.append(
      automaticSandboxCheck({
        companyId: onProduction,
        companyName: PRODUCTION_TYPED.companyName,
        filingNumber: PRODUCTION_TYPED.filingNumber,
        checkedAt: nowSeconds(),
        osUser: "ops",
      }),
    );
    expect(
      refusalOf(() => abandonCustomerCompany(sandbox(), owner.address, onProduction)),
    ).toMatchObject({ code: "conflict", status: 409, message: KEPT });
    expect(s.companies.find(onProduction)?.status).toBe("draft");
  });
});

describe("isAutomaticSandboxCheck", () => {
  test("true only on a sandbox, for the automatic operator's name: false on production for the same name, false with no check, false for another operator", () => {
    const automatic = { operator: SANDBOX_AUTOMATIC_OPERATOR };
    expect(isAutomaticSandboxCheck(automatic, "sandbox")).toBe(true);
    expect(isAutomaticSandboxCheck(automatic, "production")).toBe(false);
    expect(isAutomaticSandboxCheck(undefined, "sandbox")).toBe(false);
    expect(isAutomaticSandboxCheck(undefined, "production")).toBe(false);
    expect(isAutomaticSandboxCheck({ operator: "ops.example" }, "sandbox")).toBe(false);
  });
});

describe("a filing number held by a passed check", () => {
  test("an abandoned holder frees it, and a holder that is not abandoned still holds it", async () => {
    const key = filingKeyOf(SANDBOX_TYPED.filingNumber);
    const first = await declare(sandbox(), owner, SANDBOX_TYPED);
    expect(s.checks.passedElsewhere(key, "")).toBe(first);

    abandonCustomerCompany(sandbox(), owner.address, first);
    expect(s.checks.passedElsewhere(key, "")).toBeUndefined();

    // Another tenant declares the same test number: its automatic check holds it now.
    const next = await declare(sandbox(), second, SANDBOX_TYPED);
    expect(s.checks.passedElsewhere(key, "")).toBe(next);
    expect(s.checks.passedElsewhere(key, next)).toBeUndefined();
  });
});

// ── The two other readers of "this company has a check" ────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** A cutoff a day after the test's clock: every company declared here was created before it. */
const cutoffAfterCreation = (): string => sqliteUtcTimestamp(nowMs + DAY_MS);
/** A cutoff a day before the test's clock: every company declared here was created after it. */
const cutoffBeforeCreation = (): string => sqliteUtcTimestamp(nowMs - DAY_MS);

/** Whether the stale rule takes the company at `cutoff`: in the listing, and in the one-company
 *  re-read, which must agree. */
function staleAt(companyId: string, cutoff: string): boolean {
  const listed = s.companies
    .listStaleCustomerCandidates(cutoff, 50)
    .some((c) => c.companyId === companyId);
  expect(s.companies.isStaleCustomerCandidate(companyId, cutoff), companyId).toBe(listed);
  return listed;
}

/** The lifetime count of companies of the owner's human. */
const ownerCount = (): number => s.store.countCompaniesForNullifier("1001", ACTION);

describe("the stale sweep reads the automatic check as no check", () => {
  test("a sandbox company with only its automatic check, created before the cutoff, is stale", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    expect(staleAt(companyId, cutoffAfterCreation())).toBe(true);
  });

  test("the same company created after the cutoff is not stale", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    expect(staleAt(companyId, cutoffBeforeCreation())).toBe(false);
  });

  test("a sandbox company whose latest check is an operator's pass is not stale", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    appendCheck(s.checks, companyId, "passed");
    expect(staleAt(companyId, cutoffAfterCreation())).toBe(false);
  });

  test.each(["broken", "superseded"] as const)(
    "a sandbox company with only its automatic check is not stale once it had a deployed body, now %s",
    async (state) => {
      const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
      bodyIn(state, s, companyId, { tenant: owner.address });
      expect(staleAt(companyId, cutoffAfterCreation())).toBe(false);
    },
  );

  test("a body that never deployed does not spare it: with only an order's draft, it is stale", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    createOrder(legalBodyOrderDeps(s), owner.address, { companyId });
    expect(staleAt(companyId, cutoffAfterCreation())).toBe(true);
  });

  test("a production company whose check passed is not stale, even under the automatic operator's name; an unchecked one is", async () => {
    const checked = await declare(production(), owner, PRODUCTION_TYPED);
    appendCheck(s.checks, checked, "passed");
    const named = await declare(production(), owner, {
      ...PRODUCTION_TYPED,
      filingNumber: "EX-0002",
    });
    s.checks.append(
      automaticSandboxCheck({
        companyId: named,
        companyName: PRODUCTION_TYPED.companyName,
        filingNumber: "EX-0002",
        checkedAt: nowSeconds(),
        osUser: "ops",
      }),
    );
    const unchecked = await declare(production(), owner, {
      ...PRODUCTION_TYPED,
      filingNumber: "EX-0003",
    });
    const cutoff = cutoffAfterCreation();
    expect(staleAt(checked, cutoff)).toBe(false);
    expect(staleAt(named, cutoff)).toBe(false);
    expect(staleAt(unchecked, cutoff)).toBe(true);
  });

  test("any upload keeps a sandbox company whose only check is automatic, as it keeps an unchecked one, even an upload older than that check", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    const bytes = Buffer.from("%PDF-1.7\n% sandbox evidence\n%%EOF\n", "latin1");
    const uploaded = acceptEvidence(
      {
        documents: new SqliteDocumentIndexRepository(db),
        docStore: new DeletableMemoryDocumentStore(),
      },
      { companyId, kind: "existence", expectedSha256: sha256(bytes), bytes },
    );
    expect(uploaded.ok).toBe(true);
    // Before the automatic check: had that check counted, no upload would have followed it.
    db.prepare("UPDATE documents SET created_at = ? WHERE company_id = ?").run(
      sqliteUtcTimestamp(nowMs - DAY_MS),
      companyId,
    );
    expect(staleAt(companyId, cutoffAfterCreation())).toBe(false);
  });

  test("the sweep abandons an unused sandbox declaration and erases its declarant fields, as it does an unchecked one; after an operator's check the declaration stays", async () => {
    const unused = await declare(sandbox(), owner, SANDBOX_TYPED);
    // Another test number, made from the fixture's: each sandbox number has one holder.
    const failed = await declare(sandbox(), second, {
      ...SANDBOX_TYPED,
      filingNumber: `${SANDBOX_TYPED.filingNumber}-2`,
    });
    appendCheck(s.checks, failed, "failed");
    // A month and a day on: both are old, and the failed check is older than the cutoff.
    const later = nowMs + STALE_CUSTOMER_SECONDS * 1000 + DAY_MS;
    expect(
      expireStaleCustomerCompanies(
        {
          companies: s.companies,
          declarations: s.declarations,
          checks: s.checks,
          hasOpenLegalBody: () => false,
          transaction: (fn) => db.transaction(fn)(),
          now: () => later,
        },
        50,
      ),
    ).toBe(2);
    expect(s.companies.find(unused)?.status).toBe("abandoned");
    expect(s.declarations.find(unused)).toMatchObject({
      declarantName: null,
      signature: null,
      piiErasedAt: Math.floor(later / 1000),
    });
    expect(s.companies.find(failed)?.status).toBe("abandoned");
    expect(s.declarations.find(failed)).toMatchObject({
      declarantName: SYNTHETIC_DECLARANT.name,
      piiErasedAt: null,
    });
  });
});

describe("the lifetime count of a human's companies reads the automatic check as no check", () => {
  test("a sandbox company abandoned with only its automatic check does not count", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    abandonCustomerCompany(sandbox(), owner.address, companyId);
    expect(ownerCount()).toBe(0);
  });

  test("a sandbox company abandoned after an operator's check counts", async () => {
    const companyId = await declare(sandbox(), owner, SANDBOX_TYPED);
    appendCheck(s.checks, companyId, "failed");
    expect(s.companies.setStatus(companyId, "ready", "abandoned")).toBe(true);
    expect(ownerCount()).toBe(1);
  });

  test("an open sandbox company counts", async () => {
    await declare(sandbox(), owner, SANDBOX_TYPED);
    expect(ownerCount()).toBe(1);
  });

  test("on production, as before: an abandoned company with a check counts, under any operator's name; one abandoned unchecked does not", async () => {
    const checked = await declare(production(), owner, PRODUCTION_TYPED);
    appendCheck(s.checks, checked, "failed");
    expect(s.companies.setStatus(checked, "draft", "abandoned")).toBe(true);
    expect(ownerCount()).toBe(1);

    const named = await declare(production(), owner, {
      ...PRODUCTION_TYPED,
      filingNumber: "EX-0002",
    });
    s.checks.append(
      automaticSandboxCheck({
        companyId: named,
        companyName: PRODUCTION_TYPED.companyName,
        filingNumber: "EX-0002",
        checkedAt: nowSeconds(),
        osUser: "ops",
      }),
    );
    expect(s.companies.setStatus(named, "draft", "abandoned")).toBe(true);
    expect(ownerCount()).toBe(2);

    const unchecked = await declare(production(), owner, {
      ...PRODUCTION_TYPED,
      filingNumber: "EX-0003",
    });
    abandonCustomerCompany(production(), owner.address, unchecked);
    expect(ownerCount()).toBe(2);
  });
});
