/**
 * Stale customer companies: a declared company that nobody paid for and that gives the operator
 * nothing new to look at is abandoned once it is old. That is a company 30 days old with no check
 * and no upload, or one whose latest check failed more than 30 days ago with no upload since. The
 * declarant's personal fields are erased only when nothing was ever checked: after a failed check,
 * the declaration is evidence and stays.
 *
 * A company is made old by moving the function's clock forward, or by setting `created_at` with
 * SQL: a check's time is its `created_at`, the database's own clock, and a check row can never be
 * changed. Nothing here sleeps.
 *
 * Every name, company and filing number here is an invention, and the keys are anvil's published
 * test accounts.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CUSTOMER_COMPANY_PLACEHOLDER,
  CUSTOMER_PROVIDER,
  type CustomerCompanyDeps,
  type CustomerStatementInput,
  STALE_CUSTOMER_SECONDS,
  abandonCustomerCompany,
  createCustomerCompany,
  expireStaleCustomerCompanies,
} from "../../src/legalBody/customerCompany";
import { acceptEvidence } from "../../src/legalBody/evidence";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import {
  type CompanyCheckResult,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import {
  type CompanyStatus,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import {
  ANVIL_ACCOUNT_2,
  APPROVED,
  CHAIN_ID,
  FACTORY,
  FORMATION_PROVIDER,
  customerCompanyDeps,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";

/** anvil's published account #2: a test key, never a real wallet. */
const owner = ANVIL_ACCOUNT_2;
const OWNER_NULLIFIER = "2001";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A declaration as a production caller types it. */
const TYPED: CustomerStatementInput = {
  declarantName: "Ada Example",
  declarantTitle: "Manager",
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
};

let db: Database.Database;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let documents: SqliteDocumentIndexRepository;
let store: SqliteWorldStore;
let docStore: DeletableMemoryDocumentStore;
/** The real time when the test started, in whole seconds as milliseconds: companies are declared,
 *  checks recorded and files uploaded at this time, since their `created_at` is the database's own
 *  clock. */
let startMs: number;
/** The clock of the function under test, in milliseconds. A test moves it forward. */
let nowMs: number;
let logs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  store = new SqliteWorldStore(db);
  docStore = new DeletableMemoryDocumentStore();
  startMs = Math.floor(Date.now() / 1000) * 1000;
  nowMs = startMs;
  // A declaration and an upload each write an ops line: the tests read them here, not on stdout.
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
  recordHuman(store, owner.address, OWNER_NULLIFIER, startMs);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const passDays = (days: number): void => {
  nowMs += days * DAY_MS;
};
const nowSeconds = (): number => Math.floor(nowMs / 1000);

/** The doors of a production deployment, on the real clock, with room for every company a test
 *  declares. */
function doorDeps(over: Partial<CustomerCompanyDeps> = {}): CustomerCompanyDeps {
  return customerCompanyDeps({ db, companies, declarations, checks, store }, () => startMs, {
    maxOpenPerTenant: 10,
    ...over,
  });
}

type ExpireDeps = Parameters<typeof expireStaleCustomerCompanies>[0];

function expireDeps(over: Partial<ExpireDeps> = {}): ExpireDeps {
  return {
    companies,
    declarations,
    checks,
    hasOpenLegalBody: () => false,
    transaction: (fn) => db.transaction(fn)(),
    now: () => nowMs,
    ...over,
  };
}

const expire = (over: Partial<ExpireDeps> = {}, limit = 50): number =>
  expireStaleCustomerCompanies(expireDeps(over), limit);

/** Declares a company as the doors do: a statement of authority signed by the owner's key. On a
 *  deployment that charges it lands `draft`, otherwise `ready`. */
async function declare(
  opts: { filingNumber?: string; paymentRequired?: boolean } = {},
): Promise<string> {
  const typed = { ...TYPED, filingNumber: opts.filingNumber ?? TYPED.filingNumber };
  const issuedAt = BigInt(Math.floor(startMs / 1000));
  const fields = {
    declarantName: TYPED.declarantName as string,
    declarantTitle: TYPED.declarantTitle as string,
    companyName: typed.companyName,
    jurisdiction: "WY" as const,
    filingNumber: typed.filingNumber,
    guardian: owner.address,
  };
  const served = statementTypedDataWire(
    CHAIN_ID,
    FACTORY,
    buildStatementMessage(fields, APPROVED, issuedAt),
  );
  const signature = await owner.signTypedData(JSON.parse(JSON.stringify(served)));
  const { companyId } = await createCustomerCompany(
    doorDeps({ paymentRequired: opts.paymentRequired ?? true }),
    owner.address,
    { ...typed, issuedAt: issuedAt.toString(), signature },
  );
  return companyId;
}

/** Appends a check with this result, as the operator records one. */
function check(companyId: string, result: CompanyCheckResult): void {
  const common = {
    companyId,
    result,
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: Math.floor(startMs / 1000),
  };
  checks.append(
    result === "passed"
      ? {
          ...common,
          registryName: "Example Holdings LLC",
          registryFilingId: "TEST-0001",
          registryStatus: "Active",
          formationDate: "2024-02-29",
          registeredAgent: "Example Registered Agent LLC",
          existenceEvidenceSha256: `0x${"e1".repeat(32)}`,
          controlEvidenceSha256: `0x${"c1".repeat(32)}`,
          controlEvidenceKind: "ein_letter",
          reasonCode: null,
          reason: null,
        }
      : {
          ...common,
          registryName: null,
          registryFilingId: null,
          registryStatus: null,
          formationDate: null,
          registeredAgent: null,
          existenceEvidenceSha256: null,
          controlEvidenceSha256: null,
          controlEvidenceKind: null,
          reasonCode: result === "failed" ? "filing_not_found" : null,
          reason: "Recorded for a test.",
        },
  );
}

/** Uploads a small PDF for the company, as the upload door does. */
function upload(companyId: string, label = "evidence"): void {
  const bytes = Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF\n`, "latin1");
  const expectedSha256: Hex = `0x${createHash("sha256").update(bytes).digest("hex")}`;
  const result = acceptEvidence(
    { documents, docStore, now: () => startMs },
    { companyId, kind: "existence", expectedSha256, bytes },
  );
  if (!result.ok) throw new Error(`the upload was refused: ${result.problem}`);
}

/** Sets the upload time of every upload of the company. */
function setUploadTime(companyId: string, createdAt: string): void {
  db.prepare(
    "UPDATE documents SET created_at = ? WHERE company_id = ? AND source = 'customer'",
  ).run(createdAt, companyId);
}

/** Sets when the company was created. */
function setCreatedAt(companyId: string, ms: number): void {
  db.prepare("UPDATE companies SET created_at = ? WHERE company_id = ?").run(
    sqliteUtcTimestamp(ms),
    companyId,
  );
}

/** The time the company's latest check was recorded, as the column holds it. */
function latestCheckTime(companyId: string): string {
  return (
    db
      .prepare(
        "SELECT created_at FROM company_checks WHERE company_id = ? ORDER BY check_id DESC LIMIT 1",
      )
      .get(companyId) as { created_at: string }
  ).created_at;
}

function paymentRow(companyId: string, status: string): void {
  db.prepare(
    `INSERT INTO formation_payments (payment_id, company_id, status, amount_usdc, nonce, valid_before)
     VALUES (?, ?, ?, '1000000', ?, 1)`,
  ).run(`pay-${companyId}-${status}`, companyId, status, `nonce-${companyId}-${status}`);
}

/** A company row written directly, without a declaration. */
function companyRow(over: { provider?: string; status?: CompanyStatus } = {}): string {
  return companies.create({
    tenantId: owner.address,
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

/** The cutoff the function computes from its clock. */
const cutoff = (): string => sqliteUtcTimestamp(nowMs - STALE_CUSTOMER_SECONDS * 1000);

const printed = (): string[] => logs.mock.calls.map((call) => call.map(String).join(" "));
const expiryFailures = (): string[] =>
  printed().filter((line) => line.includes('"opslog":"customer_company_expiry_failed"'));

function expectErased(companyId: string, atSeconds: number): void {
  expect(declarations.find(companyId)).toMatchObject({
    declarantName: null,
    declarantTitle: null,
    statementText: null,
    statementHash: null,
    statementDigest: null,
    signature: null,
    piiErasedAt: atSeconds,
    // The company it named, and who declared it, stay.
    companyName: "Example Holdings LLC",
    humanNullifier: OWNER_NULLIFIER,
  });
}

function expectDeclarationKept(companyId: string): void {
  const declaration = declarations.find(companyId);
  expect(declaration).toMatchObject({
    declarantName: "Ada Example",
    declarantTitle: "Manager",
    piiErasedAt: null,
  });
  expect(declaration?.statementText).toEqual(expect.any(String));
  expect(declaration?.signature).toEqual(expect.any(String));
}

test("the exact value: 30 days", () => {
  expect(STALE_CUSTOMER_SECONDS).toBe(30 * 24 * 3600);
});

describe("a company with no check and no upload", () => {
  test("31 days old: abandoned, and its declarant's personal fields erased", async () => {
    const companyId = await declare();
    expect(companies.find(companyId)?.status).toBe("draft");
    passDays(31);

    expect(expire()).toBe(1);

    expect(companies.find(companyId)?.status).toBe("abandoned");
    expectErased(companyId, nowSeconds());
    expect(declarations.find(companyId)?.filingNumber).toBe("TEST-0001");
    // Nothing about the declarant reaches a log.
    expect(printed().join("\n")).not.toContain("Ada Example");
  });

  test("on a deployment that does not charge, a company that landed ready is abandoned the same way", async () => {
    const companyId = await declare({ paymentRequired: false });
    expect(companies.find(companyId)?.status).toBe("ready");
    passDays(31);

    expect(expire()).toBe(1);

    expect(companies.find(companyId)?.status).toBe("abandoned");
    expectErased(companyId, nowSeconds());
  });

  test("a quote that expired or a payment that failed does not keep it", async () => {
    const expired = await declare({ filingNumber: "TEST-0001" });
    paymentRow(expired, "expired");
    const failed = await declare({ filingNumber: "TEST-0002" });
    paymentRow(failed, "failed");
    passDays(31);

    expect(expire()).toBe(2);

    expect(companies.find(expired)?.status).toBe("abandoned");
    expect(companies.find(failed)?.status).toBe("abandoned");
  });
});

describe("kept, with its declaration as it was", () => {
  const cases: { name: string; arrange: (companyId: string) => void }[] = [
    { name: "a company 29 days old", arrange: () => passDays(29) },
    {
      name: "a company with an upload and no check: it waits for the operator",
      arrange: (id) => {
        upload(id);
        passDays(31);
      },
    },
    {
      name: "a company whose latest check passed",
      arrange: (id) => {
        check(id, "passed");
        passDays(31);
      },
    },
    {
      name: "a company whose latest check is a revocation",
      arrange: (id) => {
        check(id, "passed");
        check(id, "revoked");
        passDays(31);
      },
    },
    {
      name: "a company whose latest check is a reinstatement",
      arrange: (id) => {
        check(id, "passed");
        check(id, "revoked");
        check(id, "reinstated");
        passDays(31);
      },
    },
    ...(["quoted", "settling", "settled", "refunded"] as const).map((status) => ({
      name: `a company with a payment ${status}`,
      arrange: (id: string) => {
        paymentRow(id, status);
        passDays(31);
      },
    })),
    {
      name: "a company 31 days old whose check failed less than 30 days ago",
      arrange: (id) => {
        setCreatedAt(id, startMs - 31 * DAY_MS);
        check(id, "failed");
      },
    },
    {
      name: "a company with an upload in the same second as its failed check: a check is not after an upload of its own second",
      arrange: (id) => {
        check(id, "failed");
        upload(id);
        setUploadTime(id, latestCheckTime(id));
        passDays(31);
      },
    },
  ];

  test.each(cases)("$name", async ({ arrange }) => {
    const companyId = await declare();
    arrange(companyId);

    expect(companies.listStaleCustomerCandidates(cutoff(), 50)).toEqual([]);
    expect(companies.isStaleCustomerCandidate(companyId, cutoff())).toBe(false);
    expect(expire()).toBe(0);

    expect(companies.find(companyId)?.status).toBe("draft");
    expectDeclarationKept(companyId);
  });

  test("a company that stands behind an open legal body", async () => {
    const companyId = await declare();
    passDays(31);
    // Listed: the legal body is the one condition the listing does not carry.
    expect(companies.isStaleCustomerCandidate(companyId, cutoff())).toBe(true);

    expect(expire({ hasOpenLegalBody: (id) => id === companyId })).toBe(0);

    expect(companies.find(companyId)?.status).toBe("draft");
    expectDeclarationKept(companyId);
  });

  test("a formation company, and a customer company already abandoned, are never candidates", async () => {
    const formation = companyRow({ provider: FORMATION_PROVIDER });
    const abandoned = await declare();
    abandonCustomerCompany(doorDeps(), owner.address, abandoned);
    passDays(31);

    expect(companies.listStaleCustomerCandidates(cutoff(), 50)).toEqual([]);
    expect(expire()).toBe(0);
    expect(companies.find(formation)?.status).toBe("draft");
  });
});

describe("a company whose check failed", () => {
  test("31 days ago with no upload since: abandoned, and its declaration kept as evidence", async () => {
    const companyId = await declare();
    upload(companyId);
    // The upload was made an hour before the check, so the check covered it.
    setUploadTime(companyId, sqliteUtcTimestamp(startMs - 60 * 60 * 1000));
    check(companyId, "failed");
    passDays(31);

    expect(expire()).toBe(1);

    expect(companies.find(companyId)?.status).toBe("abandoned");
    expectDeclarationKept(companyId);
  });

  test("31 days ago with an upload after it: kept, waiting for the operator", async () => {
    const companyId = await declare();
    check(companyId, "failed");
    upload(companyId);
    setUploadTime(companyId, sqliteUtcTimestamp(startMs + 2 * DAY_MS));
    passDays(31);

    expect(expire()).toBe(0);

    expect(companies.find(companyId)?.status).toBe("draft");
    expectDeclarationKept(companyId);
  });
});

describe("the sweep", () => {
  test("takes the oldest first, at most `limit` of them", async () => {
    const youngest = await declare({ filingNumber: "TEST-0001" });
    const oldest = await declare({ filingNumber: "TEST-0002" });
    const middle = await declare({ filingNumber: "TEST-0003" });
    setCreatedAt(youngest, startMs - 31 * DAY_MS);
    setCreatedAt(oldest, startMs - 33 * DAY_MS);
    setCreatedAt(middle, startMs - 32 * DAY_MS);

    expect(companies.listStaleCustomerCandidates(cutoff(), 50).map((c) => c.companyId)).toEqual([
      oldest,
      middle,
      youngest,
    ]);
    expect(expire({}, 2)).toBe(2);

    expect(companies.find(oldest)?.status).toBe("abandoned");
    expect(companies.find(middle)?.status).toBe("abandoned");
    expect(companies.find(youngest)?.status).toBe("draft");
  });

  test("is idempotent: a second run changes nothing", async () => {
    const unchecked = await declare({ filingNumber: "TEST-0001" });
    const failed = await declare({ filingNumber: "TEST-0002" });
    check(failed, "failed");
    passDays(31);
    const firstRun = nowSeconds();

    expect(expire()).toBe(2);
    passDays(1);
    expect(expire()).toBe(0);

    expect(companies.find(unchecked)?.status).toBe("abandoned");
    expect(companies.find(failed)?.status).toBe("abandoned");
    expectErased(unchecked, firstRun);
    expectDeclarationKept(failed);
  });

  const changes: { name: string; change: (companyId: string) => void }[] = [
    { name: "an upload arrives", change: (id) => upload(id) },
    { name: "the operator records a passed check", change: (id) => check(id, "passed") },
    { name: "a payment is quoted", change: (id) => paymentRow(id, "quoted") },
    {
      name: "its tenant abandons it",
      change: (id) => abandonCustomerCompany(doorDeps(), owner.address, id),
    },
  ];

  test.each(changes)(
    "a candidate that changed between the listing and its transaction is skipped: $name",
    async ({ name, change }) => {
      const companyId = await declare();
      passDays(31);
      expect(companies.isStaleCustomerCandidate(companyId, cutoff())).toBe(true);
      const before = companies.find(companyId)?.status;

      const count = expire({
        transaction: (fn) => {
          change(companyId);
          return db.transaction(fn)();
        },
      });

      expect(count).toBe(0);
      // Skipped by the re-read, not by a failure.
      expect(expiryFailures()).toEqual([]);
      if (name === "its tenant abandons it") {
        // Abandoned and erased by its tenant, at the tenant's time, not by the sweep.
        expect(companies.find(companyId)?.status).toBe("abandoned");
        expectErased(companyId, Math.floor(startMs / 1000));
      } else {
        expect(companies.find(companyId)?.status).toBe(before);
        expectDeclarationKept(companyId);
      }
    },
  );

  test("a legal body opened between the listing and its transaction: skipped", async () => {
    const companyId = await declare();
    passDays(31);
    let open = false;

    const count = expire({
      hasOpenLegalBody: () => open,
      transaction: (fn) => {
        open = true;
        return db.transaction(fn)();
      },
    });

    expect(count).toBe(0);
    expect(companies.find(companyId)?.status).toBe("draft");
    expectDeclarationKept(companyId);
  });

  test("a lost compare-and-set skips the company, and the sweep goes on to the next", async () => {
    const raced = await declare({ filingNumber: "TEST-0001" });
    const next = await declare({ filingNumber: "TEST-0002" });
    setCreatedAt(raced, startMs - DAY_MS);
    passDays(31);
    // Another writer moves the company between the sweep's read of its status and its write.
    const racing: SqliteCompanyRepository = Object.create(companies);
    racing.setStatus = (id, from, to) => {
      if (id === raced) companies.setStatus(id, "draft", "ready");
      return companies.setStatus(id, from, to);
    };

    expect(expire({ companies: racing })).toBe(1);
    expect(expiryFailures()).toEqual([]);

    expect(companies.find(raced)?.status).toBe("ready");
    expectDeclarationKept(raced);
    expect(companies.find(next)?.status).toBe("abandoned");
    expectErased(next, nowSeconds());
    // Skipped, not failed: still stale, it is taken by the next run.
    expect(expire()).toBe(1);
    expect(companies.find(raced)?.status).toBe("abandoned");
  });

  test("the status and the erasure are one transaction: a declaration that cannot be erased leaves its company as it was, and the sweep goes on", async () => {
    // A customer company with no declaration cannot arise from the doors; written by hand here.
    const orphan = companyRow();
    setCreatedAt(orphan, startMs - DAY_MS);
    const declared = await declare();
    passDays(31);

    expect(expire()).toBe(1);

    expect(companies.find(orphan)?.status).toBe("draft");
    expect(companies.find(declared)?.status).toBe("abandoned");
    const failures = expiryFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(orphan);
  });
});

test("a company is a candidate from the second its age reaches the cutoff", async () => {
  const companyId = await declare();
  const createdAt = companies.find(companyId)?.createdAt as string;
  expect(companies.isStaleCustomerCandidate(companyId, createdAt)).toBe(true);
  const oneSecondEarlier = sqliteUtcTimestamp(Date.parse(`${createdAt.replace(" ", "T")}Z`) - 1000);
  expect(companies.isStaleCustomerCandidate(companyId, oneSecondEarlier)).toBe(false);
  expect(
    companies.isStaleCustomerCandidate("00000000-0000-4000-8000-000000000000", createdAt),
  ).toBe(false);
});

test("the listing takes the cutoff only as the text the columns hold, and a positive limit", () => {
  const iso = new Date(startMs).toISOString();
  expect(() => companies.listStaleCustomerCandidates(iso, 10)).toThrow(/YYYY-MM-DD HH:MM:SS/);
  expect(() => companies.isStaleCustomerCandidate("any", iso)).toThrow(/YYYY-MM-DD HH:MM:SS/);
  // SQLite would read a negative limit as no limit at all.
  for (const limit of [0, -1, 1.5])
    expect(() => companies.listStaleCustomerCandidates(cutoff(), limit)).toThrow(/limit/);
});

test("the repository is still constructed, and still works, on a database without the checks table", () => {
  // An operator command that runs without the migration constructs it on such a database.
  const older = openDatabase(":memory:");
  try {
    migrate(older);
    older.exec("DROP TABLE company_checks");
    const repo = new SqliteCompanyRepository(older);
    const companyId = repo.create({
      tenantId: owner.address,
      status: "draft",
      provider: FORMATION_PROVIDER,
      environment: "production",
      synthetic: false,
      nameOptions: [],
      businessPurpose: "Example purpose",
      industryLabel: "Example industry",
      intakeSynthesized: false,
    });
    expect(repo.setStatus(companyId, "draft", "abandoned")).toBe(true);
  } finally {
    older.close();
  }
});
