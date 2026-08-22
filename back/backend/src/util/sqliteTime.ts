/**
 * The two halves of "SQLite's TEXT timestamp", in ONE module (M4).
 *
 * The schema writes `CURRENT_TIMESTAMP`, which SQLite renders as `"YYYY-MM-DD HH:MM:SS"` in UTC
 * with no zone marker. Two functions cross that boundary in opposite directions, and they lived
 * in two unrelated modules — the formatter in the formation door, the parser in the sweeper — so
 * the format they agree on was written down twice and asserted in neither place.
 *
 * The format is also why the CALLER supplies the instant rather than the SQL: `datetime('now')`
 * inside a statement cannot be moved by an injected clock, and every window these two express
 * (retry backoff, PII retention, event retention, the 24h spend ceiling) is tested against one.
 */

/** A `CURRENT_TIMESTAMP`-shaped UTC instant, so a comparison against the schema's TEXT columns is
 *  a plain lexicographic one. */
export function sqliteUtcTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** The inverse: a stored `"YYYY-MM-DD HH:MM:SS"` as epoch ms. Anything unreadable — null, empty,
 *  prose — is 0, which reads as "infinitely old" and makes a corrupt timestamp a reason to act
 *  rather than a reason to stall forever. */
export function parseSqliteUtc(ts: string | null | undefined): number {
  if (!ts) return 0;
  const ms = Date.parse(`${ts.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : 0;
}
