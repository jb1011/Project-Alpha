import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { filingKeyOf } from "./companyDeclarationRepository";

/**
 * THE OPERATOR'S CHECKS of a customer's declaration, append-only: a pass, a failure, a revocation
 * and a reinstatement are each a new row, and a company's standing is derived from its rows by the
 * caller, never stored. The table, and the guards the database itself holds (no update, no delete,
 * no insert over an existing check, what a passed or a failed row must carry), are
 * `company_checks` in db.ts.
 *
 * `append` checks the SHAPE of a check before writing it. Whether a check may be recorded at all
 * (the company's current state, a stale view, a filing passed elsewhere) is the caller's decision.
 */

export type CompanyCheckResult = "passed" | "failed" | "revoked" | "reinstated";
export type ControlEvidenceKind = "ein_letter" | "articles_and_resolution" | "other";
export type CheckReasonCode =
  | "name_mismatch"
  | "filing_not_found"
  | "not_active"
  | "control_not_shown"
  | "other";

export interface CompanyCheck {
  checkId: number;
  companyId: string;
  result: CompanyCheckResult;
  operator: string;
  operatorOsUser: string;
  checkedAt: number; // seconds
  registryName: string | null;
  registryFilingId: string | null;
  filingKey: string | null;
  registryStatus: string | null;
  formationDate: string | null; // YYYY-MM-DD, a Wyoming calendar date
  registeredAgent: string | null;
  existenceEvidenceSha256: Hex | null;
  controlEvidenceSha256: Hex | null;
  controlEvidenceKind: ControlEvidenceKind | null;
  reasonCode: CheckReasonCode | null;
  reason: string | null;
}

export type NewCompanyCheck = Omit<CompanyCheck, "checkId" | "filingKey">;

export interface CompanyCheckRepository {
  /**
   * Validates the shape of the check and throws on a bad one, before writing anything; the
   * message names the field and the rule, never the value. The filing key is derived from the
   * registry filing id. Returns the stored check.
   */
  append(c: NewCompanyCheck): CompanyCheck;
  /** The check with the highest id. */
  latest(companyId: string): CompanyCheck | undefined;
  /** Oldest first. */
  list(companyId: string): CompanyCheck[];
  /** Another company whose LATEST check passed with this filing key. */
  passedElsewhere(filingKey: string, exceptCompanyId: string): string | undefined;
}

interface Row {
  check_id: number;
  company_id: string;
  result: CompanyCheckResult;
  operator: string;
  operator_os_user: string;
  checked_at: number;
  registry_name: string | null;
  registry_filing_id: string | null;
  filing_key: string | null;
  registry_status: string | null;
  formation_date: string | null;
  registered_agent: string | null;
  existence_evidence_sha256: string | null;
  control_evidence_sha256: string | null;
  control_evidence_kind: ControlEvidenceKind | null;
  reason_code: CheckReasonCode | null;
  reason: string | null;
}

function toCheck(r: Row): CompanyCheck {
  return {
    checkId: r.check_id,
    companyId: r.company_id,
    result: r.result,
    operator: r.operator,
    operatorOsUser: r.operator_os_user,
    checkedAt: r.checked_at,
    registryName: r.registry_name,
    registryFilingId: r.registry_filing_id,
    filingKey: r.filing_key,
    registryStatus: r.registry_status,
    formationDate: r.formation_date,
    registeredAgent: r.registered_agent,
    existenceEvidenceSha256: r.existence_evidence_sha256 as Hex | null,
    controlEvidenceSha256: r.control_evidence_sha256 as Hex | null,
    controlEvidenceKind: r.control_evidence_kind,
    reasonCode: r.reason_code,
    reason: r.reason,
  };
}

const RESULTS: readonly CompanyCheckResult[] = ["passed", "failed", "revoked", "reinstated"];
const EVIDENCE_KINDS: readonly ControlEvidenceKind[] = [
  "ein_letter",
  "articles_and_resolution",
  "other",
];
const REASON_CODES: readonly CheckReasonCode[] = [
  "name_mismatch",
  "filing_not_found",
  "not_active",
  "control_not_shown",
  "other",
];

const OPERATOR_NAME = /^[a-z0-9._-]{2,40}$/;
/** One spelling per hash, so a stored hash compares as text with the same hash from anywhere. */
const SHA256 = /^0x[0-9a-f]{64}$/;
const CALENDAR_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MAX_TEXT_CODE_POINTS = 300;
/** Control, format, surrogate, private-use and unassigned characters: line breaks, tabs, NULs,
 *  zero-width and direction-changing characters among them. */
const OTHER_CHARACTER = /\p{C}/u;
/** The largest time in unix seconds accepted. A time in milliseconds is past it for centuries. */
const MAX_UNIX_SECONDS = 99_999_999_999;

/** A refusal names the field and the rule, never the value: a registered agent can be a person. */
function refuse(field: string, rule: string): never {
  throw new Error(`company check: ${field} ${rule}`);
}

function requiredText(field: string, value: unknown): string {
  const text = optionalText(field, value);
  if (text === null) refuse(field, "is required");
  return text;
}

/** Null, or text of 1 to 300 code points holding no character of class `\p{C}`. */
function optionalText(field: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") refuse(field, "must be text");
  if (value.length === 0) refuse(field, "must not be empty");
  if ([...value].length > MAX_TEXT_CODE_POINTS)
    refuse(field, `must be at most ${MAX_TEXT_CODE_POINTS} characters`);
  if (OTHER_CHARACTER.test(value))
    refuse(field, "must not hold a control, format or other invisible character");
  return value;
}

function optionalHash(field: string, value: unknown): Hex | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256.test(value))
    refuse(field, "must be 0x and 64 lower-case hex digits");
  return value as Hex;
}

/** A real date of the Gregorian calendar, written YYYY-MM-DD: no 30 February, no year 0. */
function isCalendarDate(value: string): boolean {
  const parts = CALENDAR_DATE.exec(value);
  if (!parts) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
}

function optionalDate(field: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isCalendarDate(value))
    refuse(field, "must be a calendar date written YYYY-MM-DD");
  return value;
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (!(allowed as readonly unknown[]).includes(value))
    refuse(field, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

/** The check as it is stored: every field validated, and nothing a caller added besides. */
function validated(c: NewCompanyCheck): NewCompanyCheck {
  const operator = c.operator;
  if (typeof operator !== "string" || !OPERATOR_NAME.test(operator))
    refuse("operator", `must match ${OPERATOR_NAME.source}`);
  const checkedAt = c.checkedAt;
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 1 || checkedAt > MAX_UNIX_SECONDS)
    refuse("checkedAt", `must be a whole number of unix seconds (1 to ${MAX_UNIX_SECONDS})`);
  return {
    companyId: requiredText("companyId", c.companyId),
    result: oneOf("result", c.result, RESULTS),
    operator,
    operatorOsUser: requiredText("operatorOsUser", c.operatorOsUser),
    checkedAt,
    registryName: optionalText("registryName", c.registryName),
    registryFilingId: optionalText("registryFilingId", c.registryFilingId),
    registryStatus: optionalText("registryStatus", c.registryStatus),
    formationDate: optionalDate("formationDate", c.formationDate),
    registeredAgent: optionalText("registeredAgent", c.registeredAgent),
    existenceEvidenceSha256: optionalHash("existenceEvidenceSha256", c.existenceEvidenceSha256),
    controlEvidenceSha256: optionalHash("controlEvidenceSha256", c.controlEvidenceSha256),
    controlEvidenceKind:
      c.controlEvidenceKind === null
        ? null
        : oneOf("controlEvidenceKind", c.controlEvidenceKind, EVIDENCE_KINDS),
    reasonCode: c.reasonCode === null ? null : oneOf("reasonCode", c.reasonCode, REASON_CODES),
    reason: optionalText("reason", c.reason),
  };
}

export class SqliteCompanyCheckRepository implements CompanyCheckRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      append: db.prepare(
        `INSERT INTO company_checks
           (company_id, result, operator, operator_os_user, checked_at, registry_name,
            registry_filing_id, filing_key, registry_status, formation_date, registered_agent,
            existence_evidence_sha256, control_evidence_sha256, control_evidence_kind,
            reason_code, reason)
         VALUES (@company_id, @result, @operator, @operator_os_user, @checked_at, @registry_name,
                 @registry_filing_id, @filing_key, @registry_status, @formation_date,
                 @registered_agent, @existence_evidence_sha256, @control_evidence_sha256,
                 @control_evidence_kind, @reason_code, @reason)
         RETURNING *`,
      ),
      latest: db.prepare(
        "SELECT * FROM company_checks WHERE company_id = ? ORDER BY check_id DESC LIMIT 1",
      ),
      list: db.prepare("SELECT * FROM company_checks WHERE company_id = ? ORDER BY check_id"),
      // A company counts only when the check carrying the key is its latest: one revoked, failed
      // or reinstated since does not hold the filing any more.
      passedElsewhere: db.prepare(
        `SELECT c.company_id AS company_id FROM company_checks c
          WHERE c.filing_key = @filing_key
            AND c.result = 'passed'
            AND c.company_id <> @except_company_id
            AND c.check_id = (SELECT MAX(l.check_id) FROM company_checks l
                               WHERE l.company_id = c.company_id)
          ORDER BY c.check_id
          LIMIT 1`,
      ),
    };
  }

  append(c: NewCompanyCheck): CompanyCheck {
    const v = validated(c);
    const row = this.stmts.append.get({
      company_id: v.companyId,
      result: v.result,
      operator: v.operator,
      operator_os_user: v.operatorOsUser,
      checked_at: v.checkedAt,
      registry_name: v.registryName,
      registry_filing_id: v.registryFilingId,
      filing_key: v.registryFilingId === null ? null : filingKeyOf(v.registryFilingId),
      registry_status: v.registryStatus,
      formation_date: v.formationDate,
      registered_agent: v.registeredAgent,
      existence_evidence_sha256: v.existenceEvidenceSha256,
      control_evidence_sha256: v.controlEvidenceSha256,
      control_evidence_kind: v.controlEvidenceKind,
      reason_code: v.reasonCode,
      reason: v.reason,
    }) as Row;
    return toCheck(row);
  }

  latest(companyId: string): CompanyCheck | undefined {
    const r = this.stmts.latest.get(companyId) as Row | undefined;
    return r ? toCheck(r) : undefined;
  }

  list(companyId: string): CompanyCheck[] {
    return (this.stmts.list.all(companyId) as Row[]).map(toCheck);
  }

  passedElsewhere(filingKey: string, exceptCompanyId: string): string | undefined {
    const r = this.stmts.passedElsewhere.get({
      filing_key: filingKeyOf(filingKey),
      except_company_id: exceptCompanyId,
    }) as { company_id: string } | undefined;
    return r?.company_id;
  }
}
