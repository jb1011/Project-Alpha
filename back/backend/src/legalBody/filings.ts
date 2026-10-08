import { addDays, isCalendarDate, yearOf } from "../util/wyomingCalendar";

/**
 * FILING FACTS of a Wyoming LLC: when its annual reports are due, and whether the last report an
 * operator recorded at the check covers the last due date. Pure: every answer is a function of the
 * values given, every date among them a Wyoming calendar date written `YYYY-MM-DD`.
 *
 * A Wyoming annual report is due on the first day of the formation month, every year from the year
 * after formation.
 */

/**
 * The days of grace after a due date. Past due and not covered by a recorded report, a company is
 * beyond grace from the day after the last of them: for a report due on 1 March, the 60th day
 * (30 April) is within grace and the 61st beyond. To be confirmed by counsel.
 */
export const REPORT_GRACE_DAYS = 60;

/**
 * - `not_yet_due`: no due date has passed;
 * - `filed`: a report recorded at the check covers the last due date passed;
 * - `past_due_unverified`: a due date has passed and no recorded report covers it. The report may
 *   well have been filed: nobody has confirmed it;
 * - `unverified`: no formation date that due dates can be counted from: none recorded, one that is
 *   not a calendar date, or one after today.
 */
export type FilingStatus = "not_yet_due" | "filed" | "past_due_unverified" | "unverified";

/** The filing fields of a statement. `""` and `0` stand for "none" and "unknown". */
export interface FilingFacts {
  /** The formation date, or "". */
  filedAt: string;
  filingStatus: FilingStatus;
  /** The year of the recorded report that counts, or 0 when none does. */
  lastFiledPeriod: number;
  /** The date that report was filed on, or "" when unknown. */
  lastFiledAt: string;
  /** "operator" when a recorded report counts: an operator saw it on the registry at the check. */
  lastFiledConfirmedBy: "" | "operator";
  /** The earliest due date on or after today, or "" when unverified. */
  nextDue: string;
  /** The latest due date strictly before today, or "" when none has passed. */
  lastDuePassed: string;
  /** Past due, and today is more than REPORT_GRACE_DAYS after the last due date passed. */
  beyondGrace: boolean;
}

/**
 * The latest due date strictly before `today` (`""` when none is), and the earliest on or after
 * it: a report due today is not yet late. A formation date after `today` has no due date passed.
 * Throws when either date is not a calendar date.
 */
export function dueDates(
  formationDate: string,
  today: string,
): { lastDuePassed: string; nextDue: string } {
  if (!isCalendarDate(formationDate))
    throw new Error("dueDates: formationDate must be a calendar date written YYYY-MM-DD");
  if (!isCalendarDate(today))
    throw new Error("dueDates: today must be a calendar date written YYYY-MM-DD");
  const firstYear = yearOf(formationDate) + 1;
  const dueIn = (year: number): string =>
    `${String(year).padStart(4, "0")}-${formationDate.slice(5, 7)}-01`;
  // Only the due date in today's year can fall on either side of today: those of earlier years are
  // before it, those of later years after. Before the first report year, the first one is next.
  const year = Math.max(firstYear, yearOf(today));
  if (dueIn(year) < today) return { lastDuePassed: dueIn(year), nextDue: dueIn(year + 1) };
  return { lastDuePassed: year > firstYear ? dueIn(year - 1) : "", nextDue: dueIn(year) };
}

/**
 * The filing facts on `today`, the Wyoming date of the statement, from the company's formation date
 * and the last annual report recorded at the check:
 * - with no formation date, one that is not a calendar date, or one after `today`, no due date can
 *   be counted: every field is empty, and the status is `unverified`;
 * - the due dates are those of `dueDates`;
 * - the recorded report counts when its period is a year from the formation year plus 1 to the year
 *   of `today`, and is ignored otherwise;
 * - `not_yet_due` when no due date has passed; `filed` when the report counts and its period is at
 *   least the year of the last due date passed; `past_due_unverified` otherwise;
 * - beyond grace when past due and `today` is after the last due date passed plus
 *   REPORT_GRACE_DAYS.
 *
 * Throws when `today` is not a calendar date: it is the caller's clock, not a fact about the company.
 */
export function filingFacts(p: {
  formationDate: string | null;
  lastReport: { period: number; filedOn: string | null } | null;
  today: string;
}): FilingFacts {
  const { formationDate, lastReport, today } = p;
  if (!isCalendarDate(today))
    throw new Error("filingFacts: today must be a calendar date written YYYY-MM-DD");
  // Calendar dates written YYYY-MM-DD compare as text, here and for the grace window below.
  if (formationDate === null || !isCalendarDate(formationDate) || formationDate > today)
    return {
      filedAt: "",
      filingStatus: "unverified",
      lastFiledPeriod: 0,
      lastFiledAt: "",
      lastFiledConfirmedBy: "",
      nextDue: "",
      lastDuePassed: "",
      beyondGrace: false,
    };
  const { lastDuePassed, nextDue } = dueDates(formationDate, today);
  const report =
    lastReport !== null &&
    Number.isSafeInteger(lastReport.period) &&
    lastReport.period >= yearOf(formationDate) + 1 &&
    lastReport.period <= yearOf(today)
      ? lastReport
      : null;
  const filingStatus: FilingStatus =
    lastDuePassed === ""
      ? "not_yet_due"
      : report !== null && report.period >= yearOf(lastDuePassed)
        ? "filed"
        : "past_due_unverified";
  return {
    filedAt: formationDate,
    filingStatus,
    lastFiledPeriod: report === null ? 0 : report.period,
    lastFiledAt: report?.filedOn ?? "",
    lastFiledConfirmedBy: report === null ? "" : "operator",
    nextDue,
    lastDuePassed,
    beyondGrace:
      filingStatus === "past_due_unverified" && today > addDays(lastDuePassed, REPORT_GRACE_DAYS),
  };
}
