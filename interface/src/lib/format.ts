/**
 * Date formatting, in MILLISECONDS — always, everywhere.
 *
 * The unit is in the parameter name and in this paragraph because the copies these replace did not
 * agree on it: the formation card's took unix SECONDS (`new Date(unixSeconds * 1000)`) while the
 * guardian record's took milliseconds, both were called `formatDate`, and both were one import away
 * from each other. A caller that picked the wrong one would render a filing date in 1970 or in the
 * year 57000 — a wrong fact on a legal surface, from a refactor that looked like a tidy-up.
 *
 * So there is one function, it takes milliseconds, and a caller holding unix seconds multiplies at
 * the call site where the unit is visible: `formatDate(filedAt * 1000)`.
 */

/** Day precision — filing dates, verification dates. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Day + time — deadlines a user is counting down to, where the hour matters. */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}
