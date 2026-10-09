/**
 * The due dates of a Wyoming LLC's annual report: the first day of the formation month, every year
 * from the year after formation. `lastDuePassed` is the latest due date strictly before today, or
 * "" when none is; `nextDue` is the earliest on or after today. Every date is a Wyoming calendar
 * date, YYYY-MM-DD.
 */
import { describe, expect, test } from "vitest";
import { dueDates } from "../../src/legalBody/filings";
import { addDays } from "../../src/util/wyomingCalendar";

describe("dueDates", () => {
  test("a report is due on the first of the formation month, every year from the year after formation", () => {
    expect(dueDates("2020-01-15", "2026-10-08")).toEqual({
      lastDuePassed: "2026-01-01",
      nextDue: "2027-01-01",
    });
    expect(dueDates("2023-06-20", "2026-03-15")).toEqual({
      lastDuePassed: "2025-06-01",
      nextDue: "2026-06-01",
    });
  });

  test("a due date equal to today is not passed: it is the next one", () => {
    expect(dueDates("2023-06-20", "2026-05-31")).toEqual({
      lastDuePassed: "2025-06-01",
      nextDue: "2026-06-01",
    });
    expect(dueDates("2023-06-20", "2026-06-01")).toEqual({
      lastDuePassed: "2025-06-01",
      nextDue: "2026-06-01",
    });
    expect(dueDates("2023-06-20", "2026-06-02")).toEqual({
      lastDuePassed: "2026-06-01",
      nextDue: "2027-06-01",
    });
    // The first due date itself, on the day it falls.
    expect(dueDates("2025-10-20", "2026-10-01")).toEqual({
      lastDuePassed: "",
      nextDue: "2026-10-01",
    });
  });

  test("a formation in December: due on 1 December, from the next year", () => {
    expect(dueDates("2025-12-31", "2026-11-30")).toEqual({
      lastDuePassed: "",
      nextDue: "2026-12-01",
    });
    expect(dueDates("2025-12-31", "2026-12-02")).toEqual({
      lastDuePassed: "2026-12-01",
      nextDue: "2027-12-01",
    });
    expect(dueDates("2025-12-01", "2027-01-01")).toEqual({
      lastDuePassed: "2026-12-01",
      nextDue: "2027-12-01",
    });
  });

  test("a formation on 29 February: due on 1 February, every year, leap or not", () => {
    expect(dueDates("2024-02-29", "2025-01-31")).toEqual({
      lastDuePassed: "",
      nextDue: "2025-02-01",
    });
    expect(dueDates("2024-02-29", "2025-02-02")).toEqual({
      lastDuePassed: "2025-02-01",
      nextDue: "2026-02-01",
    });
    expect(dueDates("2024-02-29", "2028-02-29")).toEqual({
      lastDuePassed: "2028-02-01",
      nextDue: "2029-02-01",
    });
  });

  test("no due date yet: formed this year, the same day, or after today", () => {
    expect(dueDates("2026-03-10", "2026-10-08")).toEqual({
      lastDuePassed: "",
      nextDue: "2027-03-01",
    });
    // The formation month of the formation year is never a due date.
    expect(dueDates("2026-03-10", "2026-03-31")).toEqual({
      lastDuePassed: "",
      nextDue: "2027-03-01",
    });
    expect(dueDates("2026-10-08", "2026-10-08")).toEqual({
      lastDuePassed: "",
      nextDue: "2027-10-01",
    });
    expect(dueDates("2025-10-20", "2026-09-30")).toEqual({
      lastDuePassed: "",
      nextDue: "2026-10-01",
    });
    expect(dueDates("2027-05-05", "2026-10-08")).toEqual({
      lastDuePassed: "",
      nextDue: "2028-05-01",
    });
  });

  test("agrees with the rule written out year by year, over many formation dates and days", () => {
    /** The rule as the definition reads: every due date, then the last before and the first on or after. */
    const byTheRule = (formationDate: string, today: string) => {
      const month = formationDate.slice(5, 7);
      const first = Number(formationDate.slice(0, 4)) + 1;
      const due: string[] = [];
      for (let year = first; year <= Number(today.slice(0, 4)) + 1; year++)
        due.push(`${year}-${month}-01`);
      if (due.length === 0 || (due.at(-1) as string) < today)
        due.push(`${first + due.length}-${month}-01`);
      return {
        lastDuePassed: due.filter((d) => d < today).at(-1) ?? "",
        nextDue: due.find((d) => d >= today) as string,
      };
    };
    let compared = 0;
    for (let f = "2022-11-03"; f <= "2025-02-28"; f = addDays(f, 13))
      for (let t = "2021-12-30"; t <= "2028-03-02"; t = addDays(t, 17)) {
        expect(dueDates(f, t), `${f} ${t}`).toEqual(byTheRule(f, t));
        compared++;
      }
    expect(compared).toBeGreaterThan(5000);
  });

  test("a formation date that is not a calendar date throws, and so does a today that is not", () => {
    for (const bad of ["2026-02-30", "2026-1-01", "0000-01-01", "2026-01-01T00:00:00Z", ""])
      expect(() => dueDates(bad, "2026-10-08"), JSON.stringify(bad)).toThrow(
        /^dueDates: formationDate must be a calendar date written YYYY-MM-DD$/,
      );
    for (const bad of ["2026-13-01", "today", ""])
      expect(() => dueDates("2020-01-15", bad), JSON.stringify(bad)).toThrow(
        /^dueDates: today must be a calendar date written YYYY-MM-DD$/,
      );
  });
});
