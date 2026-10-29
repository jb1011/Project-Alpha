/**
 * The legal bodies on the public transparency page: whether the section shows, what it says, and
 * what each row shows.
 *
 * The page fetches its view once and keeps one failure state for that fetch. This section reads the
 * same view and decides on its own keys, so an older backend (no list key) shows no section, and a
 * list the backend could not read says so in a sentence: never an empty table, never a zero count.
 * Each row says its environment out loud, amber for sandbox, and links its statement from the
 * row's own `links.statement`, never from a URL this bundle builds.
 *
 * Every decision is here; the section only renders the answers.
 */
import type { TransparencyLegalBody, TransparencyView } from "@/lib/api/types";
import { addressUrl } from "@/lib/chain";
import { linkableUrl } from "@/lib/legalBody/standing";

export type TransparencySection =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "rows"; rows: TransparencyLegalBody[]; count: number };

/**
 * What the legal-body section shows.
 *
 * `absent` when the page failed or has no view yet (the page says that itself), and when the view
 * has no `legalBodies` key (a backend that does not serve statements); `unavailable` when the
 * backend says the list could not be read (`legalBodiesAvailable === false`), or when the list key
 * holds something that is not a list; `empty` when the list is available and has nothing in it.
 * `stats.legalBodies` plays no part: the list decides.
 */
export function transparencySection(
  view: TransparencyView | null,
  failed: boolean,
): TransparencySection {
  if (failed || view === null) return { kind: "absent" };
  if (view.legalBodiesAvailable === false) return { kind: "unavailable" };
  const list: unknown = view.legalBodies;
  if (list === undefined) return { kind: "absent" };
  if (!Array.isArray(list)) return { kind: "unavailable" };
  if (list.length === 0) return { kind: "empty" };
  const rows = list as TransparencyLegalBody[];
  return { kind: "rows", rows, count: rows.length };
}

/**
 * The stat tile's value, or null for no tile.
 *
 * A tile only where the view gives the number, and none when the list could not be read: the
 * backend then serves a count of zero, which would read as "none" where the truth is "not known".
 */
export function legalBodiesStatValue(view: TransparencyView | null): string | null {
  if (view === null) return null;
  const n: unknown = view.stats.legalBodies;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (view.legalBodiesAvailable === false) return null;
  return String(n);
}

export type TransparencyRowPresentation = {
  key: string;
  agentId: string;
  legalName: string;
  filingNumber: string;
  /** The body's address as served, and its explorer page when it is an address. */
  body: { address: string; href: string | null };
  linkedSince: string;
  /** The environment word as served: amber for anything but production. */
  environment: { label: string; tone: "amber" | "neutral" };
  /** The row's own statement URL: its text always, a link only over http or https. */
  statement: { text: string; href: string | null };
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** One row of the section, as a stranger reads it. */
export function transparencyRow(row: TransparencyLegalBody): TransparencyRowPresentation {
  const address = String(row.legalBody);
  const environment = String(row.environment);
  const statement = String(row.links?.statement ?? "");
  const linkedSince = String(row.linkedSince);
  return {
    key: `${row.chainId}:${row.agentId}:${address.toLowerCase()}`,
    agentId: String(row.agentId),
    legalName: String(row.legalName),
    filingNumber: String(row.filingNumber),
    body: { address, href: ADDRESS.test(address) ? addressUrl(address) : null },
    linkedSince: ISO_DATE.test(linkedSince) ? linkedSince.slice(0, 10) : linkedSince,
    environment: { label: environment, tone: environment === "production" ? "neutral" : "amber" },
    statement: { text: statement, href: linkableUrl(statement) },
  };
}
