/**
 * Filing facts: the filing fields of a legal body's statement, a pure function of the company's
 * formation date, the last annual report recorded at the operator's check, and `today`, the
 * Wyoming date of the statement. A Wyoming annual report is due on the first day of the formation
 * month, every year from the year after formation. A recorded report counts when its year is from
 * the year after formation to the year of today. Past due and not covered by a report, a company is
 * beyond grace from the 61st day after the last due date passed.
 */
import { describe, expect, test } from "vitest";
import { type FilingFacts, REPORT_GRACE_DAYS, filingFacts } from "../../src/legalBody/filings";

interface Case {
  formationDate: string | null;
  lastReport: { period: number; filedOn: string | null } | null;
  today: string;
  expected: FilingFacts;
}

/** No recorded report counts: the three report fields hold their sentinels. */
const NO_REPORT = { lastFiledPeriod: 0, lastFiledAt: "", lastFiledConfirmedBy: "" } as const;

/** Nothing can be computed: every field empty. */
const UNVERIFIED: FilingFacts = {
  filedAt: "",
  filingStatus: "unverified",
  ...NO_REPORT,
  nextDue: "",
  lastDuePassed: "",
  beyondGrace: false,
};

const factsOf = (c: Case): FilingFacts =>
  filingFacts({ formationDate: c.formationDate, lastReport: c.lastReport, today: c.today });

describe("filingFacts", () => {
  test("the grace window is 60 days", () => {
    expect(REPORT_GRACE_DAYS).toBe(60);
  });

  describe("formed in March 2023, no report recorded: past due from the day after 1 March, beyond grace from its 61st day", () => {
    test.each<[string, Case]>([
      [
        "seen on 2026-10-07: past due since 2026-03-01, beyond grace",
        {
          formationDate: "2023-03-10",
          lastReport: null,
          today: "2026-10-07",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2027-03-01",
            lastDuePassed: "2026-03-01",
            beyondGrace: true,
          },
        },
      ],
      [
        "the day after the due date: past due, within grace",
        {
          formationDate: "2023-03-10",
          lastReport: null,
          today: "2026-03-02",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2027-03-01",
            lastDuePassed: "2026-03-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "the 60th day after it, 2026-04-30: still within grace",
        {
          formationDate: "2023-03-10",
          lastReport: null,
          today: "2026-04-30",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2027-03-01",
            lastDuePassed: "2026-03-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "the 61st day, 2026-05-01: beyond grace",
        {
          formationDate: "2023-03-10",
          lastReport: null,
          today: "2026-05-01",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2027-03-01",
            lastDuePassed: "2026-03-01",
            beyondGrace: true,
          },
        },
      ],
    ])("%s", (_name, c) => {
      expect(factsOf(c)).toEqual(c.expected);
    });
  });

  describe("formed in March 2023, seen on 2026-10-07, with a report recorded at the check", () => {
    test.each<[string, Case]>([
      [
        "a 2026 report covers the due date of 2026-03-01: filed, next due 2027-03-01",
        {
          formationDate: "2023-03-10",
          lastReport: { period: 2026, filedOn: "2026-02-20" },
          today: "2026-10-07",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "filed",
            lastFiledPeriod: 2026,
            lastFiledAt: "2026-02-20",
            lastFiledConfirmedBy: "operator",
            nextDue: "2027-03-01",
            lastDuePassed: "2026-03-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "a 2026 report with no filing date recorded: filed, the date unknown",
        {
          formationDate: "2023-03-10",
          lastReport: { period: 2026, filedOn: null },
          today: "2026-10-07",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "filed",
            lastFiledPeriod: 2026,
            lastFiledAt: "",
            lastFiledConfirmedBy: "operator",
            nextDue: "2027-03-01",
            lastDuePassed: "2026-03-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "a 2025 report counts but does not cover 2026-03-01: past due, beyond grace",
        {
          formationDate: "2023-03-10",
          lastReport: { period: 2025, filedOn: "2025-02-11" },
          today: "2026-10-07",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "past_due_unverified",
            lastFiledPeriod: 2025,
            lastFiledAt: "2025-02-11",
            lastFiledConfirmedBy: "operator",
            nextDue: "2027-03-01",
            lastDuePassed: "2026-03-01",
            beyondGrace: true,
          },
        },
      ],
    ])("%s", (_name, c) => {
      expect(factsOf(c)).toEqual(c.expected);
    });
  });

  describe("not yet due: no due date has passed", () => {
    test.each<[string, Case]>([
      [
        "formed on 2026-01-15, seen on 2026-10-07: next due 2027-01-01",
        {
          formationDate: "2026-01-15",
          lastReport: null,
          today: "2026-10-07",
          expected: {
            filedAt: "2026-01-15",
            filingStatus: "not_yet_due",
            ...NO_REPORT,
            nextDue: "2027-01-01",
            lastDuePassed: "",
            beyondGrace: false,
          },
        },
      ],
      [
        "formed today: a formation date equal to today is not after it",
        {
          formationDate: "2026-10-07",
          lastReport: null,
          today: "2026-10-07",
          expected: {
            filedAt: "2026-10-07",
            filingStatus: "not_yet_due",
            ...NO_REPORT,
            nextDue: "2027-10-01",
            lastDuePassed: "",
            beyondGrace: false,
          },
        },
      ],
      [
        "formed in November last year: the first due date is still ahead",
        {
          formationDate: "2025-11-20",
          lastReport: null,
          today: "2026-10-07",
          expected: {
            filedAt: "2025-11-20",
            filingStatus: "not_yet_due",
            ...NO_REPORT,
            nextDue: "2026-11-01",
            lastDuePassed: "",
            beyondGrace: false,
          },
        },
      ],
      [
        "a report of the first year recorded before its due date counts, and the status stays not yet due",
        {
          formationDate: "2025-11-20",
          lastReport: { period: 2026, filedOn: "2026-09-01" },
          today: "2026-10-07",
          expected: {
            filedAt: "2025-11-20",
            filingStatus: "not_yet_due",
            lastFiledPeriod: 2026,
            lastFiledAt: "2026-09-01",
            lastFiledConfirmedBy: "operator",
            nextDue: "2026-11-01",
            lastDuePassed: "",
            beyondGrace: false,
          },
        },
      ],
      [
        "the same report once its due date has passed: filed",
        {
          formationDate: "2025-11-20",
          lastReport: { period: 2026, filedOn: "2026-09-01" },
          today: "2026-11-02",
          expected: {
            filedAt: "2025-11-20",
            filingStatus: "filed",
            lastFiledPeriod: 2026,
            lastFiledAt: "2026-09-01",
            lastFiledConfirmedBy: "operator",
            nextDue: "2027-11-01",
            lastDuePassed: "2026-11-01",
            beyondGrace: false,
          },
        },
      ],
    ])("%s", (_name, c) => {
      expect(factsOf(c)).toEqual(c.expected);
    });
  });

  describe("a due date equal to today is not passed", () => {
    test.each<[string, Case]>([
      [
        "the first due date, on the day it falls: not yet due",
        {
          formationDate: "2025-10-20",
          lastReport: null,
          today: "2026-10-01",
          expected: {
            filedAt: "2025-10-20",
            filingStatus: "not_yet_due",
            ...NO_REPORT,
            nextDue: "2026-10-01",
            lastDuePassed: "",
            beyondGrace: false,
          },
        },
      ],
      [
        "the day after it: past due, within grace",
        {
          formationDate: "2025-10-20",
          lastReport: null,
          today: "2026-10-02",
          expected: {
            filedAt: "2025-10-20",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2027-10-01",
            lastDuePassed: "2026-10-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "on the day a report is due, the previous year's report still covers the last due date passed",
        {
          formationDate: "2023-03-10",
          lastReport: { period: 2025, filedOn: "2025-02-11" },
          today: "2026-03-01",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "filed",
            lastFiledPeriod: 2025,
            lastFiledAt: "2025-02-11",
            lastFiledConfirmedBy: "operator",
            nextDue: "2026-03-01",
            lastDuePassed: "2025-03-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "the day after, the same report no longer does: past due, within grace",
        {
          formationDate: "2023-03-10",
          lastReport: { period: 2025, filedOn: "2025-02-11" },
          today: "2026-03-02",
          expected: {
            filedAt: "2023-03-10",
            filingStatus: "past_due_unverified",
            lastFiledPeriod: 2025,
            lastFiledAt: "2025-02-11",
            lastFiledConfirmedBy: "operator",
            nextDue: "2027-03-01",
            lastDuePassed: "2026-03-01",
            beyondGrace: false,
          },
        },
      ],
    ])("%s", (_name, c) => {
      expect(factsOf(c)).toEqual(c.expected);
    });
  });

  describe("a formation in December: due on 1 December, the grace window running into the next year", () => {
    test.each<[string, Case]>([
      [
        "no report, seen on 2026-10-07: past due since 2025-12-01, beyond grace",
        {
          formationDate: "2024-12-31",
          lastReport: null,
          today: "2026-10-07",
          expected: {
            filedAt: "2024-12-31",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2026-12-01",
            lastDuePassed: "2025-12-01",
            beyondGrace: true,
          },
        },
      ],
      [
        "no report, the 60th day, 2026-01-30: within grace",
        {
          formationDate: "2024-12-31",
          lastReport: null,
          today: "2026-01-30",
          expected: {
            filedAt: "2024-12-31",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2026-12-01",
            lastDuePassed: "2025-12-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "no report, the 61st day, 2026-01-31: beyond grace",
        {
          formationDate: "2024-12-31",
          lastReport: null,
          today: "2026-01-31",
          expected: {
            filedAt: "2024-12-31",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2026-12-01",
            lastDuePassed: "2025-12-01",
            beyondGrace: true,
          },
        },
      ],
      [
        "a 2025 report, seen on 2026-10-07: filed",
        {
          formationDate: "2024-12-31",
          lastReport: { period: 2025, filedOn: "2025-11-14" },
          today: "2026-10-07",
          expected: {
            filedAt: "2024-12-31",
            filingStatus: "filed",
            lastFiledPeriod: 2025,
            lastFiledAt: "2025-11-14",
            lastFiledConfirmedBy: "operator",
            nextDue: "2026-12-01",
            lastDuePassed: "2025-12-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "the same report, seen on 2026-12-02: past due, within grace",
        {
          formationDate: "2024-12-31",
          lastReport: { period: 2025, filedOn: "2025-11-14" },
          today: "2026-12-02",
          expected: {
            filedAt: "2024-12-31",
            filingStatus: "past_due_unverified",
            lastFiledPeriod: 2025,
            lastFiledAt: "2025-11-14",
            lastFiledConfirmedBy: "operator",
            nextDue: "2027-12-01",
            lastDuePassed: "2026-12-01",
            beyondGrace: false,
          },
        },
      ],
    ])("%s", (_name, c) => {
      expect(factsOf(c)).toEqual(c.expected);
    });
  });

  describe("a formation on 29 February: due on 1 February, the grace window counted in real days, leap year or not", () => {
    test.each<[string, Case]>([
      [
        "before the first due date, 2025-02-01: not yet due",
        {
          formationDate: "2024-02-29",
          lastReport: null,
          today: "2025-01-31",
          expected: {
            filedAt: "2024-02-29",
            filingStatus: "not_yet_due",
            ...NO_REPORT,
            nextDue: "2025-02-01",
            lastDuePassed: "",
            beyondGrace: false,
          },
        },
      ],
      [
        "2026, the 60th day after 1 February, 2026-04-02: within grace",
        {
          formationDate: "2024-02-29",
          lastReport: null,
          today: "2026-04-02",
          expected: {
            filedAt: "2024-02-29",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2027-02-01",
            lastDuePassed: "2026-02-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "2026, the 61st day, 2026-04-03: beyond grace",
        {
          formationDate: "2024-02-29",
          lastReport: null,
          today: "2026-04-03",
          expected: {
            filedAt: "2024-02-29",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2027-02-01",
            lastDuePassed: "2026-02-01",
            beyondGrace: true,
          },
        },
      ],
      [
        "2028, a leap year: the 60th day is 2028-04-01, within grace",
        {
          formationDate: "2024-02-29",
          lastReport: null,
          today: "2028-04-01",
          expected: {
            filedAt: "2024-02-29",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2029-02-01",
            lastDuePassed: "2028-02-01",
            beyondGrace: false,
          },
        },
      ],
      [
        "2028, the 61st day, 2028-04-02: beyond grace",
        {
          formationDate: "2024-02-29",
          lastReport: null,
          today: "2028-04-02",
          expected: {
            filedAt: "2024-02-29",
            filingStatus: "past_due_unverified",
            ...NO_REPORT,
            nextDue: "2029-02-01",
            lastDuePassed: "2028-02-01",
            beyondGrace: true,
          },
        },
      ],
    ])("%s", (_name, c) => {
      expect(factsOf(c)).toEqual(c.expected);
    });
  });

  describe("a recorded report counts only when its year is from the year after formation to the year of today", () => {
    // Formed in March 2023 and seen on 2026-10-07: the years that count are 2024 to 2026.
    const pastDueWithoutReport: FilingFacts = {
      filedAt: "2023-03-10",
      filingStatus: "past_due_unverified",
      ...NO_REPORT,
      nextDue: "2027-03-01",
      lastDuePassed: "2026-03-01",
      beyondGrace: true,
    };

    test.each<[string, number]>([
      ["the formation year", 2023],
      ["a year after the year of today", 2027],
      ["a year long before formation", 1990],
      ["a year long after today", 2200],
      ["a period that is not a whole year", 2025.5],
      ["a period that is not a number", Number.NaN],
    ])("%s is ignored", (_name, period) => {
      expect(
        filingFacts({
          formationDate: "2023-03-10",
          lastReport: { period, filedOn: "2026-02-20" },
          today: "2026-10-07",
        }),
      ).toEqual(pastDueWithoutReport);
    });

    test("the first report year, the year after formation, counts", () => {
      expect(
        filingFacts({
          formationDate: "2023-03-10",
          lastReport: { period: 2024, filedOn: "2024-02-15" },
          today: "2026-10-07",
        }),
      ).toEqual({
        ...pastDueWithoutReport,
        lastFiledPeriod: 2024,
        lastFiledAt: "2024-02-15",
        lastFiledConfirmedBy: "operator",
      });
    });

    test("formed this year: no report year has begun, so a report of this year is ignored", () => {
      expect(
        filingFacts({
          formationDate: "2026-01-15",
          lastReport: { period: 2026, filedOn: "2026-02-01" },
          today: "2026-10-07",
        }),
      ).toEqual({
        filedAt: "2026-01-15",
        filingStatus: "not_yet_due",
        ...NO_REPORT,
        nextDue: "2027-01-01",
        lastDuePassed: "",
        beyondGrace: false,
      });
    });
  });

  describe("unverified: no formation date, one that is not a calendar date, or one after today", () => {
    test.each<[string, string | null]>([
      ["a formation date after today", "2026-10-08"],
      ["no formation date", null],
      ["30 February", "2026-02-30"],
      ["a date not written YYYY-MM-DD", "2026-1-15"],
      ["a time instead of a date", "2026-01-15T00:00:00Z"],
      ["an empty string", ""],
    ])("%s: every field empty, and the recorded report dropped", (_name, formationDate) => {
      expect(
        filingFacts({
          formationDate,
          lastReport: { period: 2026, filedOn: "2026-02-20" },
          today: "2026-10-07",
        }),
      ).toEqual(UNVERIFIED);
    });

    test("each answer is an object of its own", () => {
      const first = filingFacts({ formationDate: null, lastReport: null, today: "2026-10-07" });
      first.filedAt = "2026-01-15";
      expect(filingFacts({ formationDate: null, lastReport: null, today: "2026-10-07" })).toEqual(
        UNVERIFIED,
      );
    });
  });

  test("throws when today is not a calendar date, whatever the formation date", () => {
    for (const today of ["", "2026-02-30", "October", "2026-10-07T12:00:00Z"])
      for (const formationDate of ["2023-03-10", null])
        expect(
          () => filingFacts({ formationDate, lastReport: null, today }),
          `${JSON.stringify(today)} ${formationDate}`,
        ).toThrow(/^filingFacts: today must be a calendar date written YYYY-MM-DD$/);
  });
});
