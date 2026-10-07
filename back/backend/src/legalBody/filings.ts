import { isCalendarDate, yearOf } from "../util/wyomingCalendar";

/**
 * FILING FACTS of a Wyoming LLC: when its annual reports are due. Pure: every answer is a function
 * of the dates given, all of them Wyoming calendar dates written `YYYY-MM-DD`.
 *
 * A Wyoming annual report is due on the first day of the formation month, every year from the year
 * after formation.
 */

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
