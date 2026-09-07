/**
 * A REJECTED CREATE IS NEVER AUTO-RETRIED WITH THE SAME BODY (design §4.7).
 *
 * `rejected` is doola LOOKING at the request and refusing it — a name it will not file, a
 * malformed field, a person it cannot accept. Re-sending the identical body cannot succeed, but
 * the sweeper's doubling backoff did it seven more times anyway and then `abandonFormation`'d the
 * company: which erases the responsible party's data, sets the company terminal, and forecloses
 * the edit-and-retry §4.7 exists to offer — all inside about eight hours, and usually overnight.
 *
 * So a rejection PARKS FOR A HUMAN, and the only thing that puts the row back in the sweeper's
 * reach is a successful `PATCH /companies/:companyId`: the edit is the evidence that the next
 * body will be different, and it clears the flag in the same transaction as the edit itself.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type DoolaApi, DoolaApiError } from "../../src/adapters/doola/doolaClient";
import type { CreateCompanyInput } from "../../src/adapters/doola/types";
import {
  type CreateCompanyDeps,
  createCompany,
  updateCompanyIntake,
} from "../../src/formation/company";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { parsePiiKey } from "../../src/formation/pii";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository, parseDetail } from "../../src/persistence/formationRepository";
import { runFormationCreateProvider } from "../../src/workflow/formationProvider";
import { FormationSweeper } from "../../src/workflow/formationSweeper";

const TENANT = "0x000000000000000000000000000000000000000A";
const RING = { current: parsePiiKey(Buffer.alloc(32, 9).toString("base64"), "FORMATION_PII_KEY") };
/** Well past every backoff, so "not retried" can only mean the park. */
const LATER = Date.now() + 365 * 24 * 60 * 60 * 1000;

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let repo: SqliteEntityRepository;
let stdout: string[];

const printed = () => stdout.filter((l) => l.includes('"opslog"')).map((l) => JSON.parse(l));

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  repo = new SqliteEntityRepository(db);
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function deps(): CreateCompanyDeps {
  return {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "sandbox" },
    sandboxSyntheticPii: false,
    maxPerTenant: 10,
    dailyCeiling: 100,
    pii: RING,
    transaction: (fn) => db.transaction(fn)(),
  };
}

function mint(): string {
  const r = createCompany(deps(), TENANT, {
    partyId: parties.create({
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
    }),
    names: ["Acme One", "Acme Two", "Acme Three"],
    businessPurpose: "Original purpose.",
    industryLabel: DEFAULT_INDUSTRY,
  });
  if ("error" in r) throw new Error(r.error);
  return r.companyId;
}

/** A doola that REJECTS the create, recording every body it was asked to file. */
function rejectingDoola(): DoolaApi & { bodies: CreateCompanyInput[] } {
  const bodies: CreateCompanyInput[] = [];
  return {
    createCustomer: async () => ({ doolaCustomerId: "cus_1" }),
    createCompany: async (input: CreateCompanyInput) => {
      bodies.push(input);
      throw new DoolaApiError("E_VALIDATION_FAILED", 400, "name is not filable", "req_1");
    },
    getCompany: async () => ({ doolaCompanyId: "cmp_1" }),
    listCompanies: async () => [],
    listDocuments: async () => [],
    getDocumentDownloadUrl: async () => ({ id: "d", downloadUrl: "https://x" }),
    listRequiredActions: async () => [],
    getComplianceCalendar: async () => [],
    listNaicsCodes: async () => [],
    playgroundCompleteFormation: async () => undefined,
    playgroundCompleteEin: async () => undefined,
    bodies,
  } as unknown as DoolaApi & { bodies: CreateCompanyInput[] };
}

function file(companyId: string, doola: DoolaApi): Promise<void> {
  return runFormationCreateProvider({
    company: companies.find(companyId)!,
    companies,
    repo,
    requests,
    parties,
    doola,
    environment: "sandbox",
    pii: RING,
  });
}

/** A sweeper with only the wiring the retry leg touches, and a clock far past every backoff. */
function sweeper(doola: DoolaApi): FormationSweeper {
  return new FormationSweeper({
    repo,
    companies,
    parties,
    requests,
    events: { listUnprocessed: () => [], markProcessed: () => {}, deleteOlderThan: () => 0 },
    documents: {} as never,
    docStore: {} as never,
    doola,
    environment: "sandbox",
    pii: RING,
    intervalMs: 60_000,
    now: () => LATER,
  } as never);
}

const rowOf = (companyId: string) => requests.find(companyId, "create_provider")!;
const parked = (companyId: string) =>
  parseDetail<{ awaitingIntakeEdit?: boolean }>(rowOf(companyId).detail).awaitingIntakeEdit ===
  true;

const EDIT = {
  names: ["Filable One", "Filable Two", "Filable Three"],
  businessPurpose: "Corrected purpose.",
  industryLabel: DEFAULT_INDUSTRY,
};

test("a rejection parks for a human and tells somebody — it does not schedule a retry", async () => {
  const companyId = mint();
  const doola = rejectingDoola();
  await file(companyId, doola);

  expect(doola.bodies).toHaveLength(1);
  const row = rowOf(companyId);
  expect(row.state).toBe("failed");
  // The attempt IS burned — `rejected` is the one failure that releases doola's key (C1), which
  // is exactly what makes a DIFFERENT body sendable later.
  expect(row.attempt).toBe(1);
  expect(parked(companyId)).toBe(true);
  // Silence would be the worse failure of the two: nothing else will move this company.
  expect(printed().find((l) => l.opslog === "formation_stale")).toMatchObject({
    severity: "CRITICAL",
    companyId,
    reason: "create_rejected_awaiting_intake_edit",
  });
});

test("the sweeper will NOT retry it, however long it waits — the body has not changed", async () => {
  const companyId = mint();
  const doola = rejectingDoola();
  await file(companyId, doola);

  // Eight passes, each a year past the backoff. The old behaviour spent all eight attempts here
  // and then abandoned the company, erasing the party's data.
  for (let i = 0; i < 8; i++) await sweeper(doola).tick();

  expect(doola.bodies).toHaveLength(1);
  expect(rowOf(companyId).attempt).toBe(1);
  expect(rowOf(companyId).state).toBe("failed");
  // NOT abandoned: a verdict belongs to the human who owns the row, not to a counter.
  expect(companies.find(companyId)!.status).not.toBe("abandoned");
});

test("a successful PATCH re-arms exactly one retry, and it goes out with the NEW body", async () => {
  const companyId = mint();
  const doola = rejectingDoola();
  await file(companyId, doola);
  expect(parked(companyId)).toBe(true);

  expect(updateCompanyIntake(deps(), TENANT, companyId, EDIT)).toEqual({ companyId });
  // The flag comes off in the SAME transaction as the edit — the edit is the evidence.
  expect(parked(companyId)).toBe(false);
  // …and the operator trail still says what doola refused.
  expect(rowOf(companyId).error).toContain("name is not filable");

  await sweeper(doola).tick();

  expect(doola.bodies).toHaveLength(2);
  expect(doola.bodies[1]!.nameOptions.map((n) => n.name)).toEqual([
    "Filable One",
    "Filable Two",
    "Filable Three",
  ]);
  // And it is parked again, because doola refused this one too: one edit buys one retry.
  expect(parked(companyId)).toBe(true);
  await sweeper(doola).tick();
  expect(doola.bodies).toHaveLength(2);
});

test("a PATCH that does not land leaves the park in place", async () => {
  // The re-arm is not a side effect of calling the door — it rides the transaction that actually
  // rewrote the intake. A refused edit changes nothing at all.
  const companyId = mint();
  const doola = rejectingDoola();
  await file(companyId, doola);
  const before = rowOf(companyId);
  expect(
    updateCompanyIntake(deps(), "0x00000000000000000000000000000000000000BB", companyId, EDIT),
  ).toHaveProperty("error");
  expect(rowOf(companyId).detail).toBe(before.detail);
  expect(parked(companyId)).toBe(true);
});
