import type { Hono } from "hono";
import type { DoolaComplianceEvent } from "../../adapters/doola/types";
import type { AuthVars } from "../../auth/middleware";
import { COMPLIANCE_ANNUAL_REPORT, formationUnavailableMessage } from "../../formation";
import { providerRefOf } from "../../formation/status";
import type { ApiDeps } from "../app";
import { ApiError, requireOwnedCompany } from "../errors";

/**
 * `GET /companies/:companyId/compliance` — the FIRST consumption of `getComplianceCalendar`
 * (design §5/§7).
 *
 * The client method has existed since PR 1 and has never been called. §7 says exactly how it is
 * to be called, and every clause of that sentence is a decision:
 *
 *  - **lazy on view.** Nothing warms this. A sweeper that polled every company's calendar would
 *    be a partner API call per company per tick, forever, for a page most owners open twice a
 *    year — and it would keep calling for companies nobody is looking at.
 *  - **an in-process `Map<companyId, {at, events}>` with a 24h TTL.** The `/transparency` route's
 *    precedent, with a TTL two orders of magnitude longer because the data is: a compliance
 *    calendar moves when a state deadline moves, which is annual. A restart re-fetches, which is
 *    the correct behaviour for a cache holding somebody else's data.
 *  - **NO TABLE.** Re-derivable partner data does not belong in the replicated store. Persisting
 *    it would put a second copy of doola's answer into Litestream→R2, into every backup, and into
 *    the set of things that can be stale without anybody noticing.
 *
 * The failure mode is a REFUSAL, not an empty list. "doola did not answer" and "this company has
 * no compliance obligations" are opposite facts, and a page that rendered the first as the second
 * would tell an owner their annual report is not due when nobody asked.
 */
export interface ComplianceEventView {
  type: string | null;
  state: string | null;
  nextDueDate: string | null;
  lastFiledDate: string | null;
  status: string | null;
}

export interface ComplianceView {
  companyId: string;
  /**
   * doola's company id, or null when no filing has been opened yet.
   *
   * Null is not an error: a `ready` company that has not been sent has nothing to have a calendar
   * ABOUT, and the honest answer is an empty list with the reason visible — not a provider call
   * that would 404, and not a refusal.
   */
  providerRef: string | null;
  /** Epoch ms this answer was fetched from the provider; null when nothing was fetched. */
  fetchedAt: number | null;
  events: ComplianceEventView[];
  /**
   * The Wyoming annual report, as a PLACEHOLDER (§7).
   *
   * It is a separate field rather than a synthesized row inside `events`, because `events` is
   * doola's answer and this is our admission that we do not yet know who files it. Merging them
   * would make an open question look like partner data. See `COMPLIANCE_ANNUAL_REPORT`.
   */
  annualReport: typeof COMPLIANCE_ANNUAL_REPORT;
}

/** What the route reads from the provider. ONE method, narrowed at the seam. */
export interface ComplianceReader {
  getComplianceCalendar(companyId: string): Promise<DoolaComplianceEvent[]>;
}

/** 24 hours. A compliance calendar moves when a state deadline moves. */
export const COMPLIANCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many companies' calendars one process will hold (§7).
 *
 * The cache was unbounded, and "in-process with a 24h TTL" is not a bound: an entry is only ever
 * removed by being READ after it expired, so a company looked at once and never again stays in
 * the map until the process restarts. On a box serving thousands of tenants that is a slow leak
 * whose size is "every company anybody ever opened", holding a partner's data long past the day
 * it was fetched.
 *
 * 500 is chosen to be far above any plausible concurrent working set (this page is opened maybe
 * twice a year per company) and far below anything that matters for memory. Eviction is LRU by
 * `Map` insertion order — the oldest key is the first one `keys()` yields — and every hit
 * re-inserts, so a company somebody is actually watching is never the one evicted.
 */
export const COMPLIANCE_CACHE_MAX = 500;

export function mountComplianceRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  // In PROCESS, keyed by OUR company id, and deliberately not exported: nothing else may read it,
  // nothing warms it, and a restart empties it.
  const cache = new Map<string, { at: number; events: ComplianceEventView[] }>();
  /**
   * The calls currently OUT to doola, one slot per company.
   *
   * Without it, the first N viewers of a company that is not cached each make their own provider
   * call — and they arrive together by construction, because the thing that empties this cache is
   * a restart and the thing that fills it is somebody opening the page. A deploy plus a link in a
   * team chat is N simultaneous requests for one calendar.
   *
   * It also RATE-LIMITS a failing provider without caching the failure: a refusal is never
   * written to `cache` (an empty list and "we could not ask" are opposite facts), but while one
   * call is in flight and failing, every concurrent request shares its outcome rather than adding
   * another to a partner that is already struggling. The slot is released the moment it settles,
   * so the next request retries.
   */
  const inflight = new Map<string, Promise<ComplianceEventView[]>>();

  /** Write, prune what has expired, and evict the oldest until the map is within its bound. */
  function remember(companyId: string, at: number, events: ComplianceEventView[]): void {
    for (const [key, entry] of cache) if (at - entry.at >= COMPLIANCE_TTL_MS) cache.delete(key);
    // Delete-then-set so a re-fetch moves the key to the END of the insertion order, which is
    // what makes the eviction below an LRU rather than a FIFO.
    cache.delete(companyId);
    cache.set(companyId, { at, events });
    while (cache.size > COMPLIANCE_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  app.get("/companies/:companyId/compliance", async (c) => {
    // Ownership FIRST, before any cache read: a cached answer must not be reachable by a tenant
    // who cannot reach the company it belongs to.
    const company = requireOwnedCompany(deps, c);
    const reader = deps.formation?.compliance;
    if (!reader) throw new ApiError("unavailable", 503, formationUnavailableMessage());

    const now = (deps.now ?? Date.now)();
    const providerRef = providerRefOf(deps.formationSteps?.(company.companyId) ?? []);
    if (!providerRef)
      return c.json({
        companyId: company.companyId,
        providerRef: null,
        fetchedAt: null,
        events: [],
        annualReport: COMPLIANCE_ANNUAL_REPORT,
      } satisfies ComplianceView);

    const hit = cache.get(company.companyId);
    if (hit && now - hit.at < COMPLIANCE_TTL_MS) {
      // A read is a use: re-inserting keeps the page somebody is actually watching out of the
      // eviction path.
      cache.delete(company.companyId);
      cache.set(company.companyId, hit);
      return c.json({
        companyId: company.companyId,
        providerRef,
        fetchedAt: hit.at,
        events: hit.events,
        annualReport: COMPLIANCE_ANNUAL_REPORT,
      } satisfies ComplianceView);
    }

    let events: ComplianceEventView[];
    try {
      let pending = inflight.get(company.companyId);
      if (!pending) {
        pending = reader
          .getComplianceCalendar(providerRef)
          .then((raw) => raw.map(toComplianceEventView));
        inflight.set(company.companyId, pending);
        // Released on SETTLE, success or failure. The `catch` is what keeps a failed call from
        // becoming an unhandled rejection on this bookkeeping chain — every caller handles the
        // original promise itself, below.
        void pending.catch(() => {}).finally(() => inflight.delete(company.companyId));
      }
      events = await pending;
    } catch (e) {
      // A refusal, never an empty list — see the module comment. The provider's own message is
      // not propagated: it is free text their operators write, and `describeDoolaError` is the
      // only thing that has redacted it. And it is never CACHED: a failure written to the cache
      // would answer for 24 hours with a fact nobody established.
      throw new ApiError(
        "provider_unavailable",
        502,
        "the filing agent did not answer for this company's compliance calendar — nothing here says what is or is not due",
        { cause: (e as Error).name },
      );
    }
    remember(company.companyId, now, events);
    return c.json({
      companyId: company.companyId,
      providerRef,
      fetchedAt: now,
      events,
      annualReport: COMPLIANCE_ANNUAL_REPORT,
    } satisfies ComplianceView);
  });
}

/**
 * doola's event, projected.
 *
 * Every field of `DoolaComplianceEvent` is optional on the wire, and the projection makes each
 * one explicitly null rather than absent: a renderer that has to tell "the provider did not say"
 * from "the key is missing from this build's type" is a renderer that will guess.
 */
function toComplianceEventView(e: DoolaComplianceEvent): ComplianceEventView {
  return {
    type: e.type ?? null,
    state: e.state ?? null,
    nextDueDate: e.nextDueDate ?? null,
    lastFiledDate: e.lastFiledDate ?? null,
    status: e.status ?? null,
  };
}
