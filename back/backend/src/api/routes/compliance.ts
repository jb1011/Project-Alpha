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

export function mountComplianceRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  // In PROCESS, keyed by OUR company id, and deliberately not exported: nothing else may read it,
  // nothing warms it, and a restart empties it.
  const cache = new Map<string, { at: number; events: ComplianceEventView[] }>();

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
    if (hit && now - hit.at < COMPLIANCE_TTL_MS)
      return c.json({
        companyId: company.companyId,
        providerRef,
        fetchedAt: hit.at,
        events: hit.events,
        annualReport: COMPLIANCE_ANNUAL_REPORT,
      } satisfies ComplianceView);

    let events: ComplianceEventView[];
    try {
      events = (await reader.getComplianceCalendar(providerRef)).map(toComplianceEventView);
    } catch (e) {
      // A refusal, never an empty list — see the module comment. The provider's own message is
      // not propagated: it is free text their operators write, and `describeDoolaError` is the
      // only thing that has redacted it.
      throw new ApiError(
        "provider_unavailable",
        502,
        "the filing agent did not answer for this company's compliance calendar — nothing here says what is or is not due",
        { cause: (e as Error).name },
      );
    }
    cache.set(company.companyId, { at: now, events });
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
