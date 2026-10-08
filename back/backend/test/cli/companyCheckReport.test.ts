/**
 * `company:check` records the last annual report the registry shows, through two optional options
 * of a passed check, and advises the operator, in the one JSON object it prints, when a report has
 * come due by the day of the check and the check records none.
 *
 * The command opens the database and the document store through the configuration, so the test
 * works in a temporary data directory. Dates derive from the test's own clock. Every name, company
 * and filing number is an invention, and the keys are anvil's published test accounts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildCli } from "../../src/cli/index";
import { createCustomerCompany } from "../../src/legalBody/customerCompany";
import { acceptEvidence } from "../../src/legalBody/evidence";
import { dueDates } from "../../src/legalBody/filings";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import {
  type CompanyCheck,
  type NewCompanyCheck,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { addDays, wyomingDate, yearOf } from "../../src/util/wyomingCalendar";
import {
  ANVIL_ACCOUNT_2,
  APPROVED,
  CHAIN_ID,
  FACTORY,
  customerCompanyDeps,
  recordHuman,
} from "../helpers/customerCompanyFixtures";

/** anvil's published account #2: a test key, never a real wallet. */
const owner = ANVIL_ACCOUNT_2;
const OPERATOR = "ops.example";
/** The sha256 of the operator's own registry printout: any 64 hexadecimal digits. */
const PRINTOUT = `0x${"ab".repeat(32)}`;
/** Formed in January 2020: a report has come due every 1 January since 2021. */
const LONG_AGO = "2020-01-15";

/** The keys of a check row and of a stored check, in order, as the command printed them before
 *  the two report fields existed. */
const ROW_KEYS = [
  "companyId",
  "operator",
  "operatorOsUser",
  "checkedAt",
  "result",
  "registryName",
  "registryFilingId",
  "registryStatus",
  "formationDate",
  "registeredAgent",
  "existenceEvidenceSha256",
  "controlEvidenceSha256",
  "controlEvidenceKind",
  "reasonCode",
  "reason",
];
const CHECK_KEYS = [
  "checkId",
  "companyId",
  "result",
  "operator",
  "operatorOsUser",
  "checkedAt",
  "registryName",
  "registryFilingId",
  "filingKey",
  "registryStatus",
  "formationDate",
  "registeredAgent",
  "existenceEvidenceSha256",
  "controlEvidenceSha256",
  "controlEvidenceKind",
  "reasonCode",
  "reason",
];

let dir: string;
let db: Database.Database;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let documents: SqliteDocumentIndexRepository;
let store: SqliteWorldStore;
let docStore: FileDocumentStore;
/** Every console line written in the process: the commands' output, ops lines and warnings. */
let printed: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "company-check-report-"));
  // The commands find the database and the document store through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  store = new SqliteWorldStore(db);
  docStore = new FileDocumentStore(join(dir, "documents"));
  printed = [];
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

/** The owner's company, declared with a real signature, with one control upload. */
async function ownerCompany(): Promise<{ companyId: string; control: Hex }> {
  const nowMs = Date.now();
  recordHuman(store, owner.address, "1001", nowMs);
  const issuedAt = BigInt(Math.floor(nowMs / 1000));
  const typed = {
    declarantName: "Ada Example",
    declarantTitle: "Sole Example Manager",
    companyName: "Example Holdings LLC",
    filingNumber: "TEST-0001",
  };
  const message = buildStatementMessage(
    { ...typed, jurisdiction: "WY", guardian: owner.address },
    APPROVED,
    issuedAt,
  );
  const served = statementTypedDataWire(CHAIN_ID, FACTORY, message);
  const signature = await owner.signTypedData(JSON.parse(JSON.stringify(served)));
  const { companyId } = await createCustomerCompany(
    customerCompanyDeps({ db, companies, declarations, checks, store }, () => nowMs),
    owner.address,
    { ...typed, issuedAt: issuedAt.toString(), signature },
  );
  const bytes = Buffer.from("%PDF-1.7\n% owner control\n%%EOF\n", "latin1");
  const accepted = acceptEvidence(
    { documents, docStore },
    {
      companyId,
      kind: "control",
      expectedSha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
      bytes,
    },
  );
  if (!accepted.ok) throw new Error(`the upload was refused: ${accepted.problem}`);
  return { companyId, control: accepted.sha256 };
}

// ── Command lines ─────────────────────────────────────────────────────────────────────────────

type Options = Record<string, string | null>;

/** The options as a command line; an option given as null is left out. */
const flags = (options: Options): string[] =>
  Object.entries(options).flatMap(([name, value]) => (value === null ? [] : [name, value]));

function passedCheck(companyId: string, control: string, over: Options = {}, yes = true) {
  return [
    "company:check",
    companyId,
    "--result",
    "passed",
    ...flags({
      "--operator": OPERATOR,
      "--expect-latest": "none",
      "--registry-name": "Example Holdings LLC",
      "--registry-filing-id": "TEST-0001",
      "--registry-status": "Active",
      "--formation-date": LONG_AGO,
      "--registered-agent": "Example Registered Agent Co",
      "--existence-evidence": PRINTOUT,
      "--control-evidence": control,
      "--control-evidence-kind": "ein_letter",
      ...over,
    }),
    ...(yes ? ["--yes"] : []),
  ];
}

function failedCheck(companyId: string, over: Options = {}) {
  return [
    "company:check",
    companyId,
    "--result",
    "failed",
    ...flags({
      "--operator": OPERATOR,
      "--expect-latest": "none",
      "--reason-code": "name_mismatch",
      "--reason": "The registry shows another name for this filing.",
      ...over,
    }),
    "--yes",
  ];
}

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

interface DryRun {
  recorded: false;
  wouldRecord: NewCompanyCheck;
  warning?: string;
}
interface Recorded {
  recorded: true;
  check: CompanyCheck;
  warning?: string;
}

/** Runs a command, and answers the ONE JSON object it printed: every other line is an ops line. */
async function run<T>(args: string[]): Promise<T> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  const outputs = printed.slice(from).filter((line) => !isOpsLine(line));
  expect(outputs).toHaveLength(1);
  return JSON.parse(outputs[0] as string) as T;
}

/** The refusal's message. A refusal prints nothing, an ops line included. */
async function refusal(args: string[]): Promise<string> {
  const from = printed.length;
  let message: string | undefined;
  try {
    await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === undefined) throw new Error(`expected ${args[0]} to be refused`);
  expect(printed.slice(from)).toEqual([]);
  return message;
}

/** Today in Wyoming, by the test's clock. */
const today = (): string => wyomingDate(Math.floor(Date.now() / 1000));

/** The warning a check made at `checkedAt` without a report gets, for a formation date. */
const warningFor = (formationDate: string, checkedAt: number): string => {
  const { lastDuePassed } = dueDates(formationDate, wyomingDate(checkedAt));
  return `an annual report was due on ${lastDuePassed}: without --last-report-period this company's legal bodies read unknown once the grace period has passed`;
};

// ── The two options ───────────────────────────────────────────────────────────────────────────

describe("company:check --result passed records the last annual report", () => {
  test("with both options: the dry run shows them, the write stores them, and no warning is given", async () => {
    const { companyId, control } = await ownerCompany();
    const year = yearOf(today()) - 1;
    const report = { "--last-report-period": String(year), "--last-report-filed": `${year}-01-10` };

    const dry = await run<DryRun>(passedCheck(companyId, control, report, false));
    expect(dry.recorded).toBe(false);
    expect(Object.keys(dry.wouldRecord)).toEqual([
      ...ROW_KEYS,
      "lastReportPeriod",
      "lastReportFiledOn",
    ]);
    expect(dry.wouldRecord).toMatchObject({
      lastReportPeriod: year,
      lastReportFiledOn: `${year}-01-10`,
    });
    expect(dry).not.toHaveProperty("warning");
    expect(checks.list(companyId)).toEqual([]);

    const written = await run<Recorded>(passedCheck(companyId, control, report));
    expect(Object.keys(written)).toEqual(["recorded", "check"]);
    expect(Object.keys(written.check)).toEqual([
      ...CHECK_KEYS,
      "lastReportPeriod",
      "lastReportFiledOn",
    ]);
    expect(written.check).toMatchObject({
      result: "passed",
      formationDate: LONG_AGO,
      lastReportPeriod: year,
      lastReportFiledOn: `${year}-01-10`,
    });
    expect(checks.list(companyId)).toEqual([written.check]);
  });

  test("with the period alone: it is stored with no date, and no warning is given", async () => {
    const { companyId, control } = await ownerCompany();
    const year = yearOf(today()) - 1;

    const written = await run<Recorded>(
      passedCheck(companyId, control, { "--last-report-period": String(year) }),
    );

    expect(written.check.lastReportPeriod).toBe(year);
    expect(written.check).not.toHaveProperty("lastReportFiledOn");
    expect(written).not.toHaveProperty("warning");
    expect(checks.latest(companyId)).toEqual(written.check);
  });

  test("with neither, once a report has come due: the warning names the due date in the dry run and the write, and the write goes ahead", async () => {
    const { companyId, control } = await ownerCompany();

    const dry = await run<DryRun>(passedCheck(companyId, control, {}, false));
    expect(Object.keys(dry)).toEqual([
      "recorded",
      "company",
      "latestCheck",
      "wouldRecord",
      "warning",
      "next",
    ]);
    expect(dry.warning).toBe(warningFor(LONG_AGO, dry.wouldRecord.checkedAt));
    // The row itself is printed exactly as before the two fields existed.
    expect(Object.keys(dry.wouldRecord)).toEqual(ROW_KEYS);
    expect(checks.list(companyId)).toEqual([]);

    const written = await run<Recorded>(passedCheck(companyId, control));
    expect(Object.keys(written)).toEqual(["recorded", "check", "warning"]);
    expect(written.warning).toBe(warningFor(LONG_AGO, written.check.checkedAt));
    expect(written.warning).toMatch(
      /^an annual report was due on [0-9]{4}-01-01: without --last-report-period /,
    );
    expect(Object.keys(written.check)).toEqual(CHECK_KEYS);
    expect(checks.list(companyId)).toEqual([written.check]);
  });

  test("with neither, before any report has come due: no warning, and the output is as before", async () => {
    const { companyId, control } = await ownerCompany();
    // Formed a month ago: the first report is due at least ten months from now.
    const recent = addDays(today(), -30);
    expect(dueDates(recent, today()).lastDuePassed).toBe("");

    const dry = await run<DryRun>(
      passedCheck(companyId, control, { "--formation-date": recent }, false),
    );
    expect(Object.keys(dry)).toEqual(["recorded", "company", "latestCheck", "wouldRecord", "next"]);

    const written = await run<Recorded>(
      passedCheck(companyId, control, { "--formation-date": recent }),
    );
    expect(Object.keys(written)).toEqual(["recorded", "check"]);
    expect(Object.keys(written.check)).toEqual(CHECK_KEYS);
    expect(written.check.formationDate).toBe(recent);
  });

  describe("refuses, and records nothing", () => {
    test("--last-report-filed without --last-report-period", async () => {
      const { companyId, control } = await ownerCompany();
      for (const yes of [false, true])
        expect(
          await refusal(
            passedCheck(companyId, control, { "--last-report-filed": "2025-01-10" }, yes),
          ),
        ).toMatch(/^refusing: --last-report-filed is taken only with --last-report-period$/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a period that is not a year written YYYY", async () => {
      const { companyId, control } = await ownerCompany();
      for (const period of ["25", "02025", "2025.0", "two thousand", ""])
        expect(
          await refusal(passedCheck(companyId, control, { "--last-report-period": period })),
          period,
        ).toMatch(/^refusing: --last-report-period must be a year written YYYY$/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a report the check's rules refuse, in the dry run as in the write", async () => {
      const { companyId, control } = await ownerCompany();
      for (const yes of [false, true]) {
        // Formed in 2020: the first report year is 2021.
        expect(
          await refusal(passedCheck(companyId, control, { "--last-report-period": "2020" }, yes)),
        ).toMatch(/^company check: lastReportPeriod is before the first report year/);
        expect(
          await refusal(
            passedCheck(
              companyId,
              control,
              { "--last-report-period": "2021", "--last-report-filed": "2021-02-30" },
              yes,
            ),
          ),
        ).toMatch(/^company check: lastReportFiledOn must be a calendar date/);
        expect(
          await refusal(
            passedCheck(
              companyId,
              control,
              { "--last-report-period": "2021", "--last-report-filed": addDays(today(), 2) },
              yes,
            ),
          ),
        ).toMatch(/^company check: lastReportFiledOn is after the date of the check$/);
      }
      expect(checks.list(companyId)).toEqual([]);
    });
  });

  test("a report filed before the formation date is refused in the dry run as in the write; one filed on the formation date itself is recorded", async () => {
    const { companyId, control } = await ownerCompany();
    // Formed on LONG_AGO: the first report, said to be filed the day before.
    for (const yes of [false, true])
      expect(
        await refusal(
          passedCheck(
            companyId,
            control,
            { "--last-report-period": "2021", "--last-report-filed": addDays(LONG_AGO, -1) },
            yes,
          ),
        ),
      ).toMatch(/^company check: lastReportFiledOn is before the formation date$/);
    expect(checks.list(companyId)).toEqual([]);

    const onFormation = { "--last-report-period": "2021", "--last-report-filed": LONG_AGO };
    const dry = await run<DryRun>(passedCheck(companyId, control, onFormation, false));
    expect(dry.wouldRecord).toMatchObject({ lastReportPeriod: 2021, lastReportFiledOn: LONG_AGO });
    expect(checks.list(companyId)).toEqual([]);
    const written = await run<Recorded>(passedCheck(companyId, control, onFormation));
    expect(written.check).toMatchObject({
      formationDate: LONG_AGO,
      lastReportPeriod: 2021,
      lastReportFiledOn: LONG_AGO,
    });
    expect(checks.list(companyId)).toEqual([written.check]);
  });
});

describe("company:check --result failed", () => {
  test("refuses both options, as it refuses a passed check's own", async () => {
    const { companyId } = await ownerCompany();
    expect(await refusal(failedCheck(companyId, { "--last-report-period": "2025" }))).toMatch(
      /^refusing: --last-report-period is not taken with --result failed$/,
    );
    expect(await refusal(failedCheck(companyId, { "--last-report-filed": "2025-01-10" }))).toMatch(
      /^refusing: --last-report-filed is not taken with --result failed$/,
    );
    expect(checks.list(companyId)).toEqual([]);

    // Without them it is recorded as before, with no warning.
    const written = await run<Recorded>(failedCheck(companyId));
    expect(Object.keys(written)).toEqual(["recorded", "check"]);
    expect(Object.keys(written.check)).toEqual(CHECK_KEYS);
  });
});
