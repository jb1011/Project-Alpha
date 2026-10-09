/**
 * The last annual report the registry showed at the operator's check: two optional fields of a
 * passed check, kept in two nullable columns of `company_checks`, and the rules a passed check's
 * dates keep against the day of the check, a Wyoming calendar date.
 *
 * Every company and filing number here is an invention.
 */
import Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type CompanyCheck,
  type NewCompanyCheck,
  SqliteCompanyCheckRepository,
  validateCompanyCheck,
} from "../../src/persistence/companyCheckRepository";
import { migrate } from "../../src/persistence/db";

/** A 32-byte value: one byte, written as two hex digits, repeated. */
const H = (byte: string) => `0x${byte.repeat(32)}` as Hex;
/** 2026-10-07 at 05:30 UTC: still 6 October in Wyoming (UTC-6 in summer). */
const CHECKED_AT = Date.parse("2026-10-07T05:30:00Z") / 1000;
/** The day of the check, as Wyoming's clock reads it. */
const CHECK_DAY = "2026-10-06";
/** The same instant's day in UTC, a day after the check's. */
const UTC_DAY = "2026-10-07";

let db: Database.Database;
let checks: SqliteCompanyCheckRepository;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  checks = new SqliteCompanyCheckRepository(db);
});
afterEach(() => db.close());

function passed(over: Partial<NewCompanyCheck> = {}): NewCompanyCheck {
  return {
    companyId: "co_1",
    result: "passed",
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: CHECKED_AT,
    registryName: "Example Holdings LLC",
    registryFilingId: "TEST-0001",
    registryStatus: "Active",
    formationDate: "2023-03-10",
    registeredAgent: "Example Registered Agent LLC",
    existenceEvidenceSha256: H("e1"),
    controlEvidenceSha256: H("c1"),
    controlEvidenceKind: "ein_letter",
    reasonCode: null,
    reason: null,
    ...over,
  };
}

function failed(over: Partial<NewCompanyCheck> = {}): NewCompanyCheck {
  return {
    ...passed(),
    result: "failed",
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
    ...over,
  };
}

/** The stored check of `passed()`, field for field and in order, as it read before the two fields. */
const storedShape = (checkId: number): CompanyCheck => ({
  checkId,
  companyId: "co_1",
  result: "passed",
  operator: "ops.example",
  operatorOsUser: "ops",
  checkedAt: CHECKED_AT,
  registryName: "Example Holdings LLC",
  registryFilingId: "TEST-0001",
  filingKey: "TEST0001",
  registryStatus: "Active",
  formationDate: "2023-03-10",
  registeredAgent: "Example Registered Agent LLC",
  existenceEvidenceSha256: H("e1"),
  controlEvidenceSha256: H("c1"),
  controlEvidenceKind: "ein_letter",
  reasonCode: null,
  reason: null,
});

const reportColumns = () =>
  db
    .prepare(
      "SELECT last_report_period, last_report_filed_on FROM company_checks ORDER BY check_id",
    )
    .all();

/** A passed row as raw SQL writes it, naming only the columns given. */
function rawPassed(extra: Record<string, unknown> = {}) {
  const row = {
    company_id: "co_raw",
    result: "passed",
    operator: "ops.example",
    operator_os_user: "ops",
    checked_at: CHECKED_AT,
    registry_name: "Example Holdings LLC",
    registry_filing_id: "TEST-0001",
    filing_key: "TEST0001",
    registry_status: "Active",
    formation_date: "2020-01-15",
    registered_agent: "Example Registered Agent LLC",
    existence_evidence_sha256: H("e1"),
    control_evidence_sha256: H("c1"),
    control_evidence_kind: "ein_letter",
    ...extra,
  };
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO company_checks (${columns.join(", ")})
       VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
    )
    .run(row);
}

describe("the two fields", () => {
  test("are stored and read back, the period alone too", () => {
    const both = checks.append(passed({ lastReportPeriod: 2026, lastReportFiledOn: "2026-02-20" }));
    expect(both).toStrictEqual({
      ...storedShape(1),
      lastReportPeriod: 2026,
      lastReportFiledOn: "2026-02-20",
    });
    expect(checks.latest("co_1")).toStrictEqual(both);
    expect(checks.list("co_1")).toStrictEqual([both]);

    // The registry showed the year filed, and no date.
    const periodOnly = checks.append(passed({ lastReportPeriod: 2025 }));
    expect(periodOnly).toStrictEqual({ ...storedShape(2), lastReportPeriod: 2025 });
    expect(Object.keys(periodOnly)).not.toContain("lastReportFiledOn");

    expect(reportColumns()).toEqual([
      { last_report_period: 2026, last_report_filed_on: "2026-02-20" },
      { last_report_period: 2025, last_report_filed_on: null },
    ]);
  });

  test("a check without them stores NULL and reads exactly as before: no key at all", () => {
    const left = checks.append(passed());
    const nulled = checks.append(passed({ lastReportPeriod: null, lastReportFiledOn: null }));
    const failure = checks.append(failed());

    expect(left).toStrictEqual(storedShape(1));
    expect(nulled).toStrictEqual(storedShape(2));
    expect(Object.keys(left)).toEqual(Object.keys(storedShape(1)));
    expect(JSON.stringify(left)).toBe(JSON.stringify(storedShape(1)));
    expect(checks.latest("co_1")).toStrictEqual(failure);
    for (const c of checks.list("co_1")) {
      expect(c).not.toHaveProperty("lastReportPeriod");
      expect(c).not.toHaveProperty("lastReportFiledOn");
    }
    expect(reportColumns()).toEqual([
      { last_report_period: null, last_report_filed_on: null },
      { last_report_period: null, last_report_filed_on: null },
      { last_report_period: null, last_report_filed_on: null },
    ]);
  });

  test("validateCompanyCheck keeps the shape: the fields given, and no key for the ones left out", () => {
    expect(validateCompanyCheck(passed())).toStrictEqual(passed());
    // `passed()` holds no report key: null records nothing, and leaves no key either.
    expect(
      validateCompanyCheck(passed({ lastReportPeriod: null, lastReportFiledOn: null })),
    ).toStrictEqual(passed());
    expect(
      validateCompanyCheck(passed({ lastReportPeriod: 2026, lastReportFiledOn: "2026-02-20" })),
    ).toStrictEqual(passed({ lastReportPeriod: 2026, lastReportFiledOn: "2026-02-20" }));
  });

  test("a row written before the columns existed reads without the keys once migrate adds them", () => {
    // A database from before: the table without the two columns, a passed row in it.
    db.exec("ALTER TABLE company_checks DROP COLUMN last_report_filed_on");
    db.exec("ALTER TABLE company_checks DROP COLUMN last_report_period");
    rawPassed();

    migrate(db);

    const columns = (
      db.prepare("PRAGMA table_info(company_checks)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns.slice(-2)).toEqual(["last_report_period", "last_report_filed_on"]);
    const old = new SqliteCompanyCheckRepository(db).latest("co_raw");
    expect(old?.result).toBe("passed");
    expect(old).not.toHaveProperty("lastReportPeriod");
    expect(old).not.toHaveProperty("lastReportFiledOn");
    expect(reportColumns()).toEqual([{ last_report_period: null, last_report_filed_on: null }]);
    // The CHECKs added over a table that held a row hold for every row written after.
    expect(() => rawPassed({ last_report_period: 1989 })).toThrow(/CHECK/);
    expect(() => rawPassed({ last_report_filed_on: "2026-1-01" })).toThrow(/CHECK/);
    // A second migrate adds nothing.
    migrate(db);
    expect(db.prepare("PRAGMA table_info(company_checks)").all()).toHaveLength(columns.length);
  });

  test("a raw insert that leaves them out reads without the keys", () => {
    rawPassed();
    const raw = checks.latest("co_raw");
    expect(raw).toMatchObject({ result: "passed", formationDate: "2020-01-15" });
    expect(raw).not.toHaveProperty("lastReportPeriod");
    expect(raw).not.toHaveProperty("lastReportFiledOn");
  });
});

describe("the columns hold their own shape against raw SQL", () => {
  test("a period that is not a whole number from 1990 to 2200 is refused, and the bounds are kept", () => {
    for (const period of [1989, 2201, -1, 0, 2025.5])
      expect(() => rawPassed({ last_report_period: period }), String(period)).toThrow(/CHECK/);
    expect(reportColumns()).toEqual([]);
    expect(rawPassed({ last_report_period: 1990 }).changes).toBe(1);
    expect(rawPassed({ last_report_period: 2200 }).changes).toBe(1);
  });

  test("a filed date that is not written YYYY-MM-DD is refused", () => {
    for (const filedOn of [
      "2026-1-01",
      "2026/01/01",
      "20260101",
      "2026-01-011",
      "2026-01-01T00:00:00Z",
      "",
    ])
      expect(() => rawPassed({ last_report_filed_on: filedOn }), filedOn).toThrow(/CHECK/);
    expect(reportColumns()).toEqual([]);
    expect(
      rawPassed({ last_report_period: 2025, last_report_filed_on: "2025-01-10" }).changes,
    ).toBe(1);
  });
});

describe("the rules of append, each refusal naming its field and writing nothing", () => {
  const refusals: [string, NewCompanyCheck, RegExp][] = [
    [
      "a period with a failed result",
      failed({ lastReportPeriod: 2025 }),
      /^company check: lastReportPeriod is recorded on a passed check only$/,
    ],
    [
      "a period and a date with a revocation",
      failed({
        result: "revoked",
        reasonCode: null,
        lastReportPeriod: 2025,
        lastReportFiledOn: "2025-01-10",
      }),
      /^company check: lastReportPeriod is recorded on a passed check only$/,
    ],
    [
      "a period with a reinstatement",
      failed({ result: "reinstated", reasonCode: null, lastReportPeriod: 2025 }),
      /^company check: lastReportPeriod is recorded on a passed check only$/,
    ],
    [
      "a date without a period",
      passed({ lastReportFiledOn: "2026-02-20" }),
      /^company check: lastReportFiledOn is recorded only with lastReportPeriod$/,
    ],
    [
      "a date without a period, on a failed check",
      failed({ lastReportFiledOn: "2026-02-20" }),
      /^company check: lastReportFiledOn is recorded only with lastReportPeriod$/,
    ],
    [
      "a period before the year after formation",
      passed({ formationDate: "2023-03-10", lastReportPeriod: 2023 }),
      /^company check: lastReportPeriod is before the first report year, the year after formation$/,
    ],
    [
      "a period after the year of the check",
      passed({ lastReportPeriod: 2027 }),
      /^company check: lastReportPeriod is after the year of the check$/,
    ],
    [
      "a period below 1990",
      passed({ formationDate: "1980-01-01", lastReportPeriod: 1989 }),
      /^company check: lastReportPeriod must be a whole number from 1990 to 2200$/,
    ],
    [
      "a period above 2200",
      passed({ lastReportPeriod: 2201 }),
      /^company check: lastReportPeriod must be a whole number from 1990 to 2200$/,
    ],
    [
      "a period that is not a whole number",
      passed({ lastReportPeriod: 2025.5 }),
      /^company check: lastReportPeriod must be a whole number from 1990 to 2200$/,
    ],
    [
      "a period written as text",
      passed({ lastReportPeriod: "2025" as unknown as number }),
      /^company check: lastReportPeriod must be a whole number from 1990 to 2200$/,
    ],
    [
      "a filed date that is not a calendar date",
      passed({ lastReportPeriod: 2026, lastReportFiledOn: "2026-02-30" }),
      /^company check: lastReportFiledOn must be a calendar date written YYYY-MM-DD$/,
    ],
    [
      "a filed date after the check",
      passed({ lastReportPeriod: 2026, lastReportFiledOn: "2026-10-08" }),
      /^company check: lastReportFiledOn is after the date of the check$/,
    ],
    [
      "a filed date on the UTC day of the check, which is the day after Wyoming's",
      passed({ lastReportPeriod: 2026, lastReportFiledOn: UTC_DAY }),
      /^company check: lastReportFiledOn is after the date of the check$/,
    ],
    [
      "a filed date before the formation date",
      passed({
        formationDate: "2023-03-10",
        lastReportPeriod: 2024,
        lastReportFiledOn: "2023-03-09",
      }),
      /^company check: lastReportFiledOn is before the formation date$/,
    ],
    [
      "a formation date one day after the check",
      passed({ formationDate: UTC_DAY }),
      /^company check: formationDate is after the date of the check$/,
    ],
    [
      "a formation date in a later year",
      passed({ formationDate: "2027-01-01" }),
      /^company check: formationDate is after the date of the check$/,
    ],
  ];
  for (const [name, check, message] of refusals)
    test(`refuses ${name}`, () => {
      expect(() => validateCompanyCheck(check)).toThrow(message);
      expect(() => checks.append(check)).toThrow(message);
      expect(reportColumns()).toEqual([]);
    });

  test("accepts the edges: a formation date on the day of the check, a period of the check's year, a report filed that day", () => {
    expect(checks.append(passed({ formationDate: CHECK_DAY })).formationDate).toBe(CHECK_DAY);
    expect(
      checks.append(
        passed({
          formationDate: "2025-10-06",
          lastReportPeriod: 2026,
          lastReportFiledOn: CHECK_DAY,
        }),
      ),
    ).toMatchObject({ lastReportPeriod: 2026, lastReportFiledOn: CHECK_DAY });
    // The first report year is the year after formation, even for a formation on 31 December.
    expect(
      checks.append(passed({ formationDate: "2025-12-31", lastReportPeriod: 2026 }))
        .lastReportPeriod,
    ).toBe(2026);
    expect(
      checks.append(passed({ formationDate: "1989-01-01", lastReportPeriod: 1990 }))
        .lastReportPeriod,
    ).toBe(1990);
    expect(checks.list("co_1")).toHaveLength(4);
  });

  test("accepts a report filed on the formation date itself", () => {
    const onFormation = {
      formationDate: "2023-03-10",
      lastReportPeriod: 2024,
      lastReportFiledOn: "2023-03-10",
    };
    expect(validateCompanyCheck(passed(onFormation))).toMatchObject(onFormation);
    expect(checks.append(passed(onFormation))).toMatchObject(onFormation);
    expect(reportColumns()).toEqual([
      { last_report_period: 2024, last_report_filed_on: "2023-03-10" },
    ]);
  });

  test("a revocation and a failure without the fields are recorded as before", () => {
    expect(checks.append(failed()).result).toBe("failed");
    expect(checks.append(failed({ result: "revoked", reasonCode: null })).result).toBe("revoked");
  });

  test("the refusal never repeats the value it refused", () => {
    expect(() => checks.append(passed({ lastReportPeriod: 1234 }))).toThrow(/^(?![\s\S]*1234)/);
    expect(() =>
      checks.append(passed({ lastReportPeriod: 2026, lastReportFiledOn: "2026-10-08" })),
    ).toThrow(/^(?![\s\S]*2026-10-08)/);
  });
});
