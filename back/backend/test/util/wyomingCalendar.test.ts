/**
 * Wyoming calendar dates: the day Wyoming's clock reads (Denver's, with daylight saving time),
 * written YYYY-MM-DD, and calendar arithmetic on such days.
 */
import { describe, expect, test } from "vitest";
import {
  WYOMING_TIME_ZONE,
  addDays,
  isCalendarDate,
  wyomingDate,
  yearOf,
} from "../../src/util/wyomingCalendar";

/** The unix seconds of an instant written in ISO 8601. */
const seconds = (iso: string): number => Date.parse(iso) / 1000;

describe("wyomingDate", () => {
  test("reads the clock of Denver", () => {
    expect(WYOMING_TIME_ZONE).toBe("America/Denver");
  });

  test("in winter (UTC-7) the day turns at 07:00 UTC", () => {
    expect(wyomingDate(seconds("2026-01-15T06:59:59Z"))).toBe("2026-01-14");
    expect(wyomingDate(seconds("2026-01-15T07:00:00Z"))).toBe("2026-01-15");
  });

  test("in summer (UTC-6) the day turns at 06:00 UTC", () => {
    expect(wyomingDate(seconds("2026-07-15T05:59:59Z"))).toBe("2026-07-14");
    expect(wyomingDate(seconds("2026-07-15T06:00:00Z"))).toBe("2026-07-15");
  });

  test("on the days the clock changes, each midnight follows the offset of its own moment", () => {
    // Daylight saving time starts on 8 March 2026 at 02:00 local time, and ends on 1 November.
    expect(wyomingDate(seconds("2026-03-08T06:59:59Z"))).toBe("2026-03-07");
    expect(wyomingDate(seconds("2026-03-08T07:00:00Z"))).toBe("2026-03-08");
    expect(wyomingDate(seconds("2026-03-09T05:59:59Z"))).toBe("2026-03-08");
    expect(wyomingDate(seconds("2026-03-09T06:00:00Z"))).toBe("2026-03-09");
    expect(wyomingDate(seconds("2026-11-01T05:59:59Z"))).toBe("2026-10-31");
    expect(wyomingDate(seconds("2026-11-01T06:00:00Z"))).toBe("2026-11-01");
    expect(wyomingDate(seconds("2026-11-02T06:59:59Z"))).toBe("2026-11-01");
    expect(wyomingDate(seconds("2026-11-02T07:00:00Z"))).toBe("2026-11-02");
  });

  test("the year and a leap day turn on the same clock", () => {
    expect(wyomingDate(seconds("2027-01-01T06:59:59Z"))).toBe("2026-12-31");
    expect(wyomingDate(seconds("2027-01-01T07:00:00Z"))).toBe("2027-01-01");
    expect(wyomingDate(seconds("2028-03-01T06:59:59Z"))).toBe("2028-02-29");
    // Zero is a time like any other: the evening of 31 December 1969 in Wyoming.
    expect(wyomingDate(0)).toBe("1969-12-31");
  });

  test("throws on a time that is not a whole number of seconds, zero or more", () => {
    for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(() => wyomingDate(bad), String(bad)).toThrow();
  });

  test("throws on a time in milliseconds: its year has more than four digits", () => {
    expect(() => wyomingDate(Date.parse("2026-10-07T12:00:00Z"))).toThrow();
  });
});

describe("isCalendarDate", () => {
  test("accepts a real date of the Gregorian calendar", () => {
    for (const date of ["2028-02-29", "2000-02-29", "2026-04-30", "0001-01-01", "9999-12-31"])
      expect(isCalendarDate(date), date).toBe(true);
  });

  test("refuses a date that does not exist, and any other spelling", () => {
    for (const bad of [
      "2027-02-29",
      "1900-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "2026-04-31",
      "0000-01-01",
      "2026-1-01",
      "20260101",
      "2026/01/01",
      "2026-01-01T00:00:00Z",
      " 2026-01-01",
      "2026-01-01\n",
      "",
    ])
      expect(isCalendarDate(bad), JSON.stringify(bad)).toBe(false);
    expect(isCalendarDate(20260101 as unknown as string)).toBe(false);
  });
});

describe("addDays", () => {
  test("across a month, a year and a leap day", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-04-30", 1)).toBe("2026-05-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  test("counts any number of days, both ways", () => {
    expect(addDays("2026-03-01", 0)).toBe("2026-03-01");
    expect(addDays("2026-03-01", 60)).toBe("2026-04-30");
    expect(addDays("2026-03-01", 61)).toBe("2026-05-01");
    expect(addDays("2026-03-01", -365)).toBe("2025-03-01");
    expect(addDays("2028-01-01", 366)).toBe("2029-01-01");
  });

  test("keeps a year below 100 as it is written", () => {
    expect(addDays("0050-01-01", 1)).toBe("0050-01-02");
    expect(addDays("0001-12-31", 1)).toBe("0002-01-01");
  });

  test("throws on a non-date, a day count that is not a whole number, and an answer outside the years 1 to 9999", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow();
    expect(() => addDays("not a date", 1)).toThrow();
    expect(() => addDays("2026-01-01", 1.5)).toThrow();
    expect(() => addDays("2026-01-01", Number.NaN)).toThrow();
    expect(() => addDays("0001-01-01", -1)).toThrow();
    expect(() => addDays("9999-12-31", 1)).toThrow();
  });
});

describe("yearOf", () => {
  test("is the year of a calendar date, and throws on a non-date", () => {
    expect(yearOf("2026-10-07")).toBe(2026);
    expect(yearOf("0999-01-01")).toBe(999);
    expect(() => yearOf("2026-02-30")).toThrow();
    expect(() => yearOf("2026")).toThrow();
  });
});
