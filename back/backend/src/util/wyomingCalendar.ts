/**
 * WYOMING CALENDAR DATES: a day as Wyoming's clock reads it, written `YYYY-MM-DD`. Wyoming keeps
 * Denver's time (`America/Denver`, with daylight saving time). A formation date, the date an annual
 * report was filed on and the date one is due are such days, never instants: the registry writes
 * no time of day and no zone.
 *
 * Arithmetic on a calendar date works on its midnight in UTC, never on a local time, so no daylight
 * saving change can move it by a day.
 */

export const WYOMING_TIME_ZONE = "America/Denver";

const DAY_MS = 86_400_000;
const CALENDAR_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** The year, month and day of an instant on Wyoming's clock, each as digits. */
const WYOMING_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: WYOMING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const pad = (n: number, digits: number): string => String(n).padStart(digits, "0");

/**
 * The Wyoming calendar date of a unix time in SECONDS. Throws on anything but a whole number of
 * seconds, zero or more, and on a time whose year has more than four digits (a time in
 * milliseconds is one, for tens of thousands of years).
 */
export function wyomingDate(unixSeconds: number): string {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0)
    throw new Error("wyomingDate: the time must be a whole number of unix seconds, zero or more");
  const instant = new Date(unixSeconds * 1000);
  const parts = Number.isNaN(instant.getTime()) ? [] : WYOMING_DAY.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  if (!isCalendarDate(date)) throw new Error("wyomingDate: the time is past the year 9999");
  return date;
}

/** A real date of the Gregorian calendar, written YYYY-MM-DD: no 30 February, no year 0. */
export function isCalendarDate(s: string): boolean {
  if (typeof s !== "string") return false;
  const parts = CALENDAR_DATE.exec(s);
  if (!parts) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
}

function partsOf(date: string): { year: number; month: number; day: number } {
  if (!isCalendarDate(date)) throw new Error("not a calendar date written YYYY-MM-DD");
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

/**
 * The date `days` calendar days after `date`, or before it when `days` is negative. Throws on a
 * non-date, a day count that is not a whole number, and an answer outside the years 1 to 9999.
 */
export function addDays(date: string, days: number): string {
  const { year, month, day } = partsOf(date);
  if (!Number.isSafeInteger(days)) throw new Error("addDays: days must be a whole number");
  // setUTCFullYear, never Date.UTC: Date.UTC reads a year from 0 to 99 as 1900 plus that year.
  const midnight = new Date(0);
  midnight.setUTCFullYear(year, month - 1, day);
  const shifted = new Date(midnight.getTime() + days * DAY_MS);
  const answer = `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`;
  if (!isCalendarDate(answer))
    throw new Error("addDays: the answer is outside the years 1 to 9999");
  return answer;
}

/** The year of a calendar date. Throws on a non-date. */
export function yearOf(date: string): number {
  return partsOf(date).year;
}
