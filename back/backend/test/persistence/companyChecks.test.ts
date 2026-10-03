import Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type CheckReasonCode,
  type CompanyCheckResult,
  type ControlEvidenceKind,
  type NewCompanyCheck,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { filingKeyOf } from "../../src/persistence/companyDeclarationRepository";
import { migrate } from "../../src/persistence/db";

/** A 32-byte value: one byte, written as two hex digits, repeated. */
const H = (byte: string) => `0x${byte.repeat(32)}` as Hex;

let db: Database.Database;
let checks: SqliteCompanyCheckRepository;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  checks = new SqliteCompanyCheckRepository(db);
});
afterEach(() => db.close());

function passed(companyId: string, over: Partial<NewCompanyCheck> = {}): NewCompanyCheck {
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
    ...over,
  };
}

function failed(companyId: string, over: Partial<NewCompanyCheck> = {}): NewCompanyCheck {
  return {
    ...passed(companyId),
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

function revoked(companyId: string, over: Partial<NewCompanyCheck> = {}): NewCompanyCheck {
  return {
    ...failed(companyId),
    result: "revoked",
    reasonCode: null,
    reason: "Recorded in error.",
    ...over,
  };
}

const rowsOf = () => db.prepare("SELECT * FROM company_checks ORDER BY check_id").all();

/** A row as raw SQL writes it, with every column a passed check needs. */
function rawPassed(extra: Record<string, unknown> = {}) {
  return {
    company_id: "co_1",
    result: "passed",
    operator: "ops.example",
    operator_os_user: "ops",
    checked_at: 1_790_000_000,
    registry_name: "Example Holdings LLC",
    registry_filing_id: "TEST-0001",
    filing_key: "TEST0001",
    registry_status: "Active",
    formation_date: "2024-02-29",
    registered_agent: "Example Registered Agent LLC",
    existence_evidence_sha256: H("e1"),
    control_evidence_sha256: H("c1"),
    control_evidence_kind: "ein_letter",
    ...extra,
  };
}
function rawInsert(row: Record<string, unknown>, verb = "INSERT") {
  const columns = Object.keys(row);
  return db
    .prepare(
      `${verb} INTO company_checks (${columns.join(", ")})
       VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
    )
    .run(row);
}

describe("appending and reading checks", () => {
  test("a check appends and reads back; latest is the highest check_id; list is oldest first", () => {
    const first = checks.append(failed("co_1"));
    expect(first).toEqual({ ...failed("co_1"), checkId: 1, filingKey: null });

    const second = checks.append(
      passed("co_1", { registryFilingId: "test-00-01", checkedAt: 1_790_000_100 }),
    );
    expect(second).toEqual({
      ...passed("co_1", { registryFilingId: "test-00-01", checkedAt: 1_790_000_100 }),
      checkId: 2,
      filingKey: "TEST0001",
    });

    // Another company's check in between takes the next id.
    const other = checks.append(passed("co_2", { reason: "Matched the registry entry." }));
    expect(other.checkId).toBe(3);

    const third = checks.append(revoked("co_1", { checkedAt: 1_790_000_200 }));
    expect(third.checkId).toBe(4);

    expect(checks.latest("co_1")).toEqual(third);
    expect(checks.list("co_1")).toEqual([first, second, third]);
    expect(checks.latest("co_2")).toEqual(other);
    expect(checks.list("co_2")).toEqual([other]);
    expect(checks.latest("co_none")).toBeUndefined();
    expect(checks.list("co_none")).toEqual([]);
  });

  test("the filing key is derived from the registry filing id, and is null without one", () => {
    for (const registryFilingId of ["TEST-00-01", "TEST-0001", "test-0001"])
      expect(checks.append(passed("co_1", { registryFilingId })).filingKey).toBe("TEST0001");
    expect(checks.append(revoked("co_1")).filingKey).toBeNull();
    // A failed check may record the filing the operator looked at.
    expect(
      checks.append(failed("co_1", { registryFilingId: "test-0002", reasonCode: "not_active" }))
        .filingKey,
    ).toBe("TEST0002");
  });
});

describe("the database guards the checks against raw SQL", () => {
  test("UPDATE, DELETE and an INSERT over an existing check abort", () => {
    checks.append(passed("co_1"));
    const before = rowsOf();
    expect(() => db.prepare("UPDATE company_checks SET result = 'revoked'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM company_checks").run()).toThrow(/append-only/);
    for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE", "INSERT"])
      expect(
        () => rawInsert(rawPassed({ check_id: 1, registry_name: "Rewritten" }), verb),
        verb,
      ).toThrow(/append-only/);
    expect(rowsOf()).toEqual(before);
  });

  test("a check id is positive: an insert with check_id -1 or 0 is refused, and appends keep working", () => {
    for (const checkId of [-1, 0])
      expect(() => rawInsert(rawPassed({ check_id: checkId })), String(checkId)).toThrow(/CHECK/);
    expect(rowsOf()).toEqual([]);
    expect(checks.append(passed("co_1")).checkId).toBe(1);
    expect(checks.append(passed("co_2")).checkId).toBe(2);
  });

  test("a check id written out by hand is at most the next one", () => {
    checks.append(passed("co_1"));
    for (const checkId of [3, 1000])
      for (const verb of ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"])
        expect(
          () => rawInsert(rawPassed({ check_id: checkId }), verb),
          `${verb} ${checkId}`,
        ).toThrow(/ids are assigned in order/);
    expect(rawInsert(rawPassed({ check_id: 2 })).changes).toBe(1);
    expect(checks.append(passed("co_1")).checkId).toBe(3);
  });

  test("a passed row missing any registry field or either evidence hash is refused", () => {
    expect(rawInsert(rawPassed()).changes).toBe(1);
    for (const column of [
      "registry_name",
      "registry_filing_id",
      "filing_key",
      "registry_status",
      "formation_date",
      "registered_agent",
      "existence_evidence_sha256",
      "control_evidence_sha256",
      "control_evidence_kind",
    ])
      expect(() => rawInsert(rawPassed({ [column]: null })), column).toThrow(/CHECK/);
    expect(rowsOf()).toHaveLength(1);
  });

  test("a failed row needs a reason code and a reason; a revoked or reinstated row needs a reason", () => {
    const row = (result: string, extra: Record<string, unknown>) => ({
      company_id: "co_1",
      result,
      operator: "ops.example",
      operator_os_user: "ops",
      checked_at: 1_790_000_000,
      ...extra,
    });
    expect(() => rawInsert(row("failed", { reason: "Not found." }))).toThrow(/CHECK/);
    expect(() => rawInsert(row("failed", { reason_code: "filing_not_found" }))).toThrow(/CHECK/);
    expect(() => rawInsert(row("revoked", {}))).toThrow(/CHECK/);
    expect(() => rawInsert(row("reinstated", {}))).toThrow(/CHECK/);
    expect(() => rawInsert(row("approved", { reason: "Unknown result." }))).toThrow(/CHECK/);
    expect(rowsOf()).toEqual([]);
    expect(
      rawInsert(row("failed", { reason_code: "filing_not_found", reason: "Not found." })).changes,
    ).toBe(1);
    expect(rawInsert(row("revoked", { reason: "Recorded in error." })).changes).toBe(1);
    expect(rawInsert(row("reinstated", { reason: "The revocation was a mistake." })).changes).toBe(
      1,
    );
  });
});

describe("append validates the shape of a check", () => {
  test("it refuses a bad operator name, a non-date, an upper-case hash and a 301-code-point field, and writes nothing", () => {
    const bad: [string, Partial<NewCompanyCheck>][] = [
      ["operator", { operator: "Ops" }],
      ["operator", { operator: "o" }],
      ["operator", { operator: "o".repeat(41) }],
      ["operator", { operator: "ops example" }],
      ["operator", { operator: "ops/example" }],
      ["formationDate", { formationDate: "2026-02-30" }],
      ["formationDate", { formationDate: "2025-02-29" }],
      ["formationDate", { formationDate: "1900-02-29" }],
      ["formationDate", { formationDate: "2026-13-01" }],
      ["formationDate", { formationDate: "2026-00-10" }],
      ["formationDate", { formationDate: "2026-01-00" }],
      ["formationDate", { formationDate: "2026-04-31" }],
      ["formationDate", { formationDate: "0000-01-01" }],
      ["formationDate", { formationDate: "2026-1-01" }],
      ["formationDate", { formationDate: "20260101" }],
      ["formationDate", { formationDate: "2026-01-01T00:00:00Z" }],
      ["formationDate", { formationDate: "1 January 2026" }],
      ["existenceEvidenceSha256", { existenceEvidenceSha256: `0x${"AB".repeat(32)}` as Hex }],
      ["controlEvidenceSha256", { controlEvidenceSha256: `0x${"aB".repeat(32)}` as Hex }],
      ["existenceEvidenceSha256", { existenceEvidenceSha256: `0x${"ab".repeat(31)}` as Hex }],
      ["controlEvidenceSha256", { controlEvidenceSha256: "ab".repeat(32) as Hex }],
      ["registryName", { registryName: "a".repeat(301) }],
      ["registeredAgent", { registeredAgent: "\u{1d49c}".repeat(301) }],
      ["reason", { reason: "é".repeat(301) }],
      ["registryStatus", { registryStatus: "Active\tstanding" }],
      ["reason", { reason: "first line\nsecond line" }],
      ["registryName", { registryName: "Example​Holdings LLC" }],
      ["registeredAgent", { registeredAgent: "‮Example Agent" }],
      ["registryFilingId", { registryFilingId: "TEST-0001\u0000" }],
      ["operatorOsUser", { operatorOsUser: "" }],
      ["companyId", { companyId: "" }],
      ["checkedAt", { checkedAt: 0 }],
      ["checkedAt", { checkedAt: -1 }],
      ["checkedAt", { checkedAt: 1_790_000_000.5 }],
      ["checkedAt", { checkedAt: 1_790_000_000_000 }],
      ["checkedAt", { checkedAt: Number.NaN }],
      ["result", { result: "approved" as CompanyCheckResult }],
      ["controlEvidenceKind", { controlEvidenceKind: "passport" as ControlEvidenceKind }],
      ["reasonCode", { reasonCode: "typo" as CheckReasonCode }],
    ];
    for (const [field, over] of bad)
      expect(() => checks.append(passed("co_1", over)), `${field} ${JSON.stringify(over)}`).toThrow(
        new RegExp(`^company check: ${field} `),
      );
    expect(rowsOf()).toEqual([]);
  });

  test("its refusal never repeats the value it refused", () => {
    expect(() => checks.append(passed("co_1", { registeredAgent: "Ada Example\n" }))).toThrow(
      /^(?![\s\S]*Ada Example)/,
    );
  });

  test("it accepts the edges: 300 code points, astral characters counted once, leap days, a reason on a pass", () => {
    const edge = checks.append(
      passed("co_1", {
        operator: "ab",
        registryName: "a".repeat(300),
        // 300 code points, 600 UTF-16 units.
        registeredAgent: "\u{1d49c}".repeat(300),
        formationDate: "2000-02-29",
        reason: "Matched the registry entry.",
      }),
    );
    expect(edge.registeredAgent).toBe("\u{1d49c}".repeat(300));
    expect(edge.formationDate).toBe("2000-02-29");
    expect(
      checks.append(passed("co_2", { operator: `o.${"_-".repeat(19)}` })).operator,
    ).toHaveLength(40);
    expect(checks.append(passed("co_3", { formationDate: "1999-12-31" })).checkId).toBe(3);
  });
});

describe("passedElsewhere", () => {
  test("finds another company whose latest check passed, whatever the hyphenation and the letter case", () => {
    checks.append(passed("co_b", { registryFilingId: "test-00-01" }));
    for (const key of [
      "TEST0001",
      filingKeyOf("TEST-0001"),
      filingKeyOf("test-00-01"),
      "test-0001",
      "Test-00-01",
    ])
      expect(checks.passedElsewhere(key, "co_a"), key).toBe("co_b");
    // Never the company asking, and never another filing.
    expect(checks.passedElsewhere("TEST0001", "co_b")).toBeUndefined();
    expect(checks.passedElsewhere("TEST0002", "co_a")).toBeUndefined();
    // A company that failed first and passed later is found.
    checks.append(failed("co_c", { registryFilingId: "TEST-0002", reasonCode: "name_mismatch" }));
    checks.append(passed("co_c", { registryFilingId: "TEST0002" }));
    expect(checks.passedElsewhere("TEST-0002", "co_a")).toBe("co_c");
  });

  test("ignores a company whose latest check is revoked or failed", () => {
    checks.append(passed("co_b", { registryFilingId: "TEST-0001" }));
    checks.append(revoked("co_b"));
    expect(checks.passedElsewhere("TEST0001", "co_a")).toBeUndefined();

    // The failed check names the same filing: it is still not a pass.
    checks.append(passed("co_c", { registryFilingId: "test-0001" }));
    checks.append(failed("co_c", { registryFilingId: "TEST-0001", reasonCode: "not_active" }));
    expect(checks.passedElsewhere("TEST0001", "co_a")).toBeUndefined();

    // A reinstated company waits for a new check, so it is not a pass either.
    checks.append(
      revoked("co_b", { result: "reinstated", reason: "The revocation was a mistake." }),
    );
    expect(checks.passedElsewhere("TEST0001", "co_a")).toBeUndefined();

    // Once it passes again, it is found again.
    checks.append(passed("co_b", { registryFilingId: "TEST-0001" }));
    expect(checks.passedElsewhere("TEST0001", "co_a")).toBe("co_b");
  });
});
