/**
 * THE SSN NEVER REACHES A LOG LINE (design §4, and the house secrets rule).
 *
 * `opsLog` writes one JSON line per event to stdout, which becomes journald, which an operator
 * greps. So this file drives the whole SSN-bearing path — the create, a filing that succeeds, and
 * every failure branch that could plausibly put a request body in an error — with stdout captured,
 * and asserts that nothing resembling a nine-digit identifier ever comes out of it.
 *
 * It asserts a PATTERN rather than the fixture's own digits, deliberately: a test that only looks
 * for "123-45-6789" passes the day somebody logs a body containing a different SSN.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DoolaApi } from "../../src/adapters/doola/doolaClient";
import { type CreateCompanyDeps, createCompany } from "../../src/formation/company";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { parsePiiKey, redactPii } from "../../src/formation/pii";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { runFormationCreateProvider } from "../../src/workflow/formationProvider";

const TENANT = "0x000000000000000000000000000000000000000A";
const SSN = "123-45-6789";
const RING = { current: parsePiiKey(Buffer.alloc(32, 6).toString("base64"), "FORMATION_PII_KEY") };

/**
 * "Nothing here looks like an SSN" — asked of the very function that redacts them.
 *
 * `redactPii` is what strips SSN-shaped runs out of a provider's error text, so reusing it here
 * means the assertion and the defence cannot drift: widening one widens the other. It is
 * boundary-anchored (`\b\d{9}\b`), which is what keeps a 13-digit epoch in `nextRetryAt` from
 * reading as a false positive while a bare nine-digit run still does.
 */
function expectNoSsnShape(text: string, label?: string): void {
  expect(redactPii(text), label).toBe(text);
}

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let repo: SqliteEntityRepository;
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  repo = new SqliteEntityRepository(db);
  printed = [];
  // stdout itself, which is what journald actually receives.
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function deps(over: Partial<CreateCompanyDeps> = {}): CreateCompanyDeps {
  return {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "production" },
    sandboxSyntheticPii: false,
    maxPerTenant: 10,
    dailyCeiling: 100,
    pii: RING,
    transaction: (fn) => db.transaction(fn)(),
    ...over,
  };
}

function newParty(): string {
  return parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
}

function mintWithSsn(): string {
  const result = createCompany(deps(), TENANT, {
    partyId: newParty(),
    names: ["Acme Robotics", "Acme Automata", "Acme Mechanicals"],
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: DEFAULT_INDUSTRY,
    ssn: SSN,
  });
  if ("error" in result) throw new Error(result.error);
  return result.companyId;
}

/** A doola double whose `createCompany` does whatever the test needs. */
function doola(over: Partial<DoolaApi> = {}): DoolaApi {
  return {
    createCustomer: async () => ({ doolaCustomerId: "cus_1" }),
    createCompany: async () => ({ doolaCompanyId: "cmp_1", formationSubmissionStatus: "PENDING" }),
    getCompany: async () => ({ doolaCompanyId: "cmp_1" }),
    listCompanies: async () => [],
    listDocuments: async () => [],
    getDocumentDownloadUrl: async () => ({ id: "d", downloadUrl: "https://x" }),
    listRequiredActions: async () => [],
    getComplianceCalendar: async () => [],
    listNaicsCodes: async () => [],
    playgroundCompleteFormation: async () => undefined,
    playgroundCompleteEin: async () => undefined,
    ...over,
  } as DoolaApi;
}

function file(companyId: string, api: DoolaApi): Promise<void> {
  return runFormationCreateProvider({
    company: companies.find(companyId)!,
    companies,
    repo,
    requests,
    parties,
    doola: api,
    environment: "production",
    pii: RING,
  });
}

/** Everything stdout saw, plus every column the create path writes that a human ever reads. */
function assertClean(companyId: string) {
  const all = printed.join("\n");
  expect(all.length).toBeGreaterThan(0); // the path must actually have logged SOMETHING
  expectNoSsnShape(all, "stdout");
  expect(all).not.toContain(SSN);

  const row = requests.find(companyId, "create_provider");
  // `detail` is persisted AND rendered in the ops trail; `error` reaches the entity event trail.
  for (const [label, text] of [
    ["detail", row?.detail ?? ""],
    ["error", row?.error ?? ""],
  ] as const) {
    expectNoSsnShape(text, label);
    expect(text, label).not.toContain(SSN);
  }
}

test("the CREATE path logs no nine-digit pattern — and does log the boolean", () => {
  const companyId = mintWithSsn();
  assertClean(companyId);
  // The operational question ("did this take the fast EIN route?") is answered by a boolean.
  expect(printed.join("\n")).toContain('"ssnCaptured":true');
});

test("a SUCCESSFUL filing that FORWARDS the SSN logs nothing of it", async () => {
  const companyId = mintWithSsn();
  let sentSsn: string | undefined;
  await file(
    companyId,
    doola({
      createCompany: async (input) => {
        sentSsn = input.responsibleParty.ssn;
        return { doolaCompanyId: "cmp_1", formationSubmissionStatus: "PENDING" };
      },
    }),
  );
  // It really was forwarded — otherwise this test would pass vacuously.
  expect(sentSsn).toBe(SSN);
  assertClean(companyId);
});

test("every FAILURE branch is clean too — the error path is where bodies leak", async () => {
  for (const [label, api] of [
    // A doola error whose message contains the body (the classic leak).
    [
      "rejected with the body echoed",
      doola({
        createCompany: async () => {
          throw new Error(`E_REQUEST_BODY_INVALID: {"responsibleParty":{"ssn":"${SSN}"}}`);
        },
      }),
    ],
    [
      "a lost answer",
      doola({
        createCompany: async () => {
          throw new Error("socket hang up");
        },
      }),
    ],
  ] as const) {
    printed = [];
    const companyId = mintWithSsn();
    await file(companyId, api);
    expect(printed.length, label).toBeGreaterThan(0);
    // The whole surface: stdout, the `detail` blob, and the `error` column that reaches the
    // entity event trail. The first case is the one that matters — a provider echoing our own
    // request body back at us is an ordinary thing for an API to do, and `describeDoolaError`
    // redacting it is the only thing standing between that and three places it comes to rest.
    assertClean(companyId);
  }
});

test("a provider error that ECHOES the SSN is redacted before it is stored anywhere", async () => {
  // Stated as its own test because it is a property of `describeDoolaError`, not of this path:
  // every consumer of a doola failure goes through it, so redacting there covers the ops line,
  // the `error` column and the entity event in one place.
  const companyId = mintWithSsn();
  await file(
    companyId,
    doola({
      createCompany: async () => {
        throw new Error(`E_REQUEST_BODY_INVALID: ssn ${SSN} is not valid`);
      },
    }),
  );
  const row = requests.find(companyId, "create_provider")!;
  expect(row.error).toContain("[redacted]");
  expect(row.error).not.toContain(SSN);
});
