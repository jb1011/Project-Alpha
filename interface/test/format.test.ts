/**
 * Dates, in the ONE unit this interface takes.
 *
 * `formatDate` takes MILLISECONDS — always, everywhere — because the two copies it replaced did
 * not agree on it: the formation card's took unix seconds and the guardian record's took
 * milliseconds, both were called `formatDate`, and both were one import away from each other. A
 * caller that picked the wrong one renders a filing date in 1970 or in the year 57000: a wrong
 * fact on a legal surface, from a refactor that looked like a tidy-up.
 */
import { expect, test } from "vitest";
import { formatDate } from "@/lib/format";

const MS = Date.UTC(2026, 8, 8, 12, 0, 0);

test("A3: a company's createdAt is EPOCH MS and needs no reconstruction at the edge", () => {
  // The header used to render `formatDate(Date.parse(`${company.createdAt}Z`))` — a timezone
  // concatenated back onto a wire format that had thrown it away. The backend now serves the
  // number, so the call site is the number.
  expect(formatDate(MS)).toBe(new Date(MS).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }));
  // …and the same instant in the format the wire used to carry, parsed the way the old call site
  // did, is the SAME day. That equality is what makes this a unit change and not a data change.
  expect(formatDate(Date.parse("2026-09-08T12:00:00Z"))).toBe(formatDate(MS));
});

test("A3: seconds where milliseconds are expected is a visible catastrophe, not a rounding error", () => {
  // Why the unit lives in the parameter name and in a test: a filing date served in seconds and
  // rendered here lands in 1970, and one served in ms and multiplied by 1000 lands in the year
  // 57000. Neither looks like a bug in a code review; both are obvious the moment they are dated.
  expect(new Date(formatDate(Math.floor(MS / 1000))).getUTCFullYear()).toBe(1970);
});
