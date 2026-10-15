/**
 * When the legal-body screens ask the server again.
 *
 * Pure: every time comes in as a number, nothing here reads a clock, and nothing here sends a
 * request. A screen asks once per tick and does what the answer says. Only reads follow from
 * these answers, apart from the binding refresh after the pointer transaction, which continues a
 * click and is idempotent under the order's lock: no answer here ever starts a write on its own.
 */
import type { BindingState } from "@/lib/api/types";
import type { CompanyStep } from "@/lib/legalBody/flow";

/** The order, while the create it reserved is not confirmed. */
export const RESERVED_POLL_MS = 5_000;
/** The binding refresh after the pointer transaction, after the first one. */
export const REFRESH_RETRY_MS = 30_000;
/** How long after the pointer transaction the binding is refreshed at all. */
export const REFRESH_WINDOW_MS = 120_000;
/** The company, while it waits on the operator's check on a production deployment. */
export const COMPANY_POLL_MS = 60_000;

/** Every 5 s while the order is `reserved`; never otherwise. */
export function orderPollInterval(state: BindingState): number | false {
  return state === "reserved" ? RESERVED_POLL_MS : false;
}

export type RefreshAction = "refresh" | "wait" | "stop";

/** The two states whose body the pointer is written for: only they can become `linked`. */
function awaitsPointer(state: BindingState): boolean {
  return state === "deployed" || state === "broken";
}

/**
 * After the pointer transaction: refresh at once; then one every 30 s while not linked within 2 min;
 * then stop. Reads only; never a write before the first click.
 *
 * `refreshes` and `lastRefreshAtMs` are the refreshes already made and the time of the latest. A
 * refresh recorded but not yet counted (the second run of a StrictMode effect) answers `wait`, as
 * does a count with no time: an input that does not add up never yields another refresh. A state
 * other than `deployed` or `broken` stops at once, `linked` first among them.
 */
export function refreshPlan(p: {
  refreshes: number;
  startedAtMs: number;
  lastRefreshAtMs: number | null;
  nowMs: number;
  state: BindingState;
}): RefreshAction {
  if (!awaitsPointer(p.state)) return "stop";
  if (p.nowMs - p.startedAtMs >= REFRESH_WINDOW_MS) return "stop";
  if (p.refreshes === 0) return p.lastRefreshAtMs === null ? "refresh" : "wait";
  if (p.lastRefreshAtMs === null) return "wait";
  return p.nowMs - p.lastRefreshAtMs >= REFRESH_RETRY_MS ? "refresh" : "wait";
}

/** Every 60 s while the company waits on the operator's check on production; never otherwise. A
 *  sandbox company is checked at its declaration, so there is nothing to wait for. */
export function companyPollInterval(
  step: CompanyStep,
  environment: "sandbox" | "production",
): number | false {
  return step === "waiting" && environment === "production" ? COMPANY_POLL_MS : false;
}
