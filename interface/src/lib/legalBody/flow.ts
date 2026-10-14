/**
 * Where a person is in the legal-body flow, derived from the server's state on every visit.
 *
 * Two pure steps:
 *  1. `selectLegalBodyThread` picks WHICH company or order the page is about, from every company
 *     and every order of the tenant plus the two handles this browser remembers;
 *  2. `deriveLegalBodyPhase` says which screen that thread is on, and why.
 *
 * Sign-in and the human gate are not phases: the flow renders them before either step runs. A
 * phase is never stored, and no clock is read here: the time comes in as `nowMs`. The local memory
 * is a hint, never the truth: an id it holds that the server does not list for this tenant is
 * ignored, and the owner choice and the identity it holds count only while the order is a draft
 * (the server knows no identity before the link).
 */
import type {
  Address,
  CheckReasonCode,
  CompanyView,
  FormationDocument,
  LapseReason,
  LegalBodyConfig,
  LegalBodyOrderView,
} from "@/lib/api/types";
import type { LegalBodyMemory, OwnerChoice } from "@/lib/legalBody/storage";

export type LegalBodyPhase =
  | "company"
  | "agreement"
  | "identity"
  | "link"
  | "pointer"
  | "payment"
  | "done"
  | "closed";

/** The company step's own screens. On sandbox the check is written at the declaration, so only
 *  `form` is reached in normal use. */
export type CompanyStep = "form" | "loading" | "evidence" | "waiting" | "failed" | "revoked";

/** Who signs and sends: the signed-in wallet in this browser, or another key elsewhere. */
export type OwnerBranch = "browser" | "paste";

export type LegalBodyNotice =
  | { kind: "expired" }
  | { kind: "lapsed"; reason: LapseReason | null }
  | { kind: "superseded"; by: string | null }
  | { kind: "replaced"; by: string | null }
  | { kind: "abandoned" }
  | { kind: "order_revoked" }
  | { kind: "other_deployment" }
  | { kind: "company_failed"; reasonCode: CheckReasonCode | null }
  | { kind: "company_revoked" }
  | { kind: "company_awaiting_check" }
  | { kind: "company_abandoned" }
  | { kind: "creating" }
  | { kind: "winding_down" }
  | { kind: "dissolved" }
  | { kind: "broken_reason_unknown" }
  | { kind: "identity_taken"; agentId: string };

export type LegalBodyDerivation = {
  phase: LegalBodyPhase;
  notice?: LegalBodyNotice;
  /** Only on `company`. */
  companyStep?: CompanyStep;
  /** On `link` and `pointer`. While the order is a draft it comes from the owner choice; from
   *  `reserved` on, from the identity owner the order recorded. */
  branch?: OwnerBranch;
};

export type LegalBodyFlowInput = {
  config: Extract<LegalBodyConfig, { available: true }>;
  /** The guardian: the signed-in wallet. */
  sessionAddress: Address;
  nowMs: number;
  /** The thread's company, or null for a new declaration. */
  company: CompanyView | null;
  /** The company's uploads, fetched on production only; null while not fetched. */
  documents: FormationDocument[] | null;
  /** Every order of the tenant, for the identity step's refusal. */
  orders: LegalBodyOrderView[];
  /** The thread's order, or null. */
  order: LegalBodyOrderView | null;
  /** Local, read only while the order is a draft. */
  ownerChoice: OwnerChoice | null;
  /** Local, read only while the order is a draft: the identity picked or just registered. */
  agentId: string | null;
};

/** A draft can be linked for 24 hours from its creation. */
export const DRAFT_LIFETIME_MS = 86_400_000;

/** Address equality without trusting either side's casing: a served address is checksummed, a
 *  session address may not be. Null or undefined never equals anything. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/** `createdAt` as milliseconds, or NaN when it cannot be parsed. */
function createdMs(order: LegalBodyOrderView): number {
  return Date.parse(order.createdAt);
}

/**
 * Whether a draft's 24 hours are over. `createdAt` is ISO 8601 in UTC; a value that cannot be
 * parsed counts as expired, so a link is never offered on a draft whose age is unknown. An order
 * past the draft is never an expired draft.
 */
export function isDraftExpired(order: LegalBodyOrderView, nowMs: number): boolean {
  if (order.state !== "draft") return false;
  const created = createdMs(order);
  return !Number.isFinite(created) || !(created + DRAFT_LIFETIME_MS > nowMs);
}

/**
 * An order the flow can still move: a draft under 24 hours, a body on its way, a body waiting for
 * its pointer, or a body whose pointer was cleared. A deployed body stays live past the backend's
 * 7-day open window: the pointer can still be written, and a refresh still links it.
 */
export function isLiveOrder(order: LegalBodyOrderView, nowMs: number): boolean {
  switch (order.state) {
    case "draft":
      return !order.revoked && !isDraftExpired(order, nowMs);
    case "reserved":
      return true;
    case "deployed":
      return !order.revoked;
    case "broken":
      return order.brokenReason === "not_linked";
    default:
      return false;
  }
}

/** A customer's own company, as opposed to one filed through formation. */
function isCustomerCompany(company: CompanyView | null): company is CompanyView {
  return company !== null && company.provider === "customer";
}

/** A company the flow can continue from: declared, not abandoned, and its check readable and not
 *  revoked (a revoked company can take no order). Its orders are weighed by the caller. */
function isOpenCompany(company: CompanyView): boolean {
  if (!isCustomerCompany(company) || company.state === "abandoned") return false;
  const state = company.verification?.state;
  return state === "awaiting_check" || state === "verified" || state === "failed";
}

/** A body that stood behind its identity and was not replaced: its page is the done page. */
function isFinished(order: LegalBodyOrderView): boolean {
  return order.state === "linked" || (order.state === "broken" && order.brokenReason !== "replaced");
}

// ---------------------------------------------------------------------------------------------
// 1. Which thread
// ---------------------------------------------------------------------------------------------

export type LegalBodyThreadRef =
  | { kind: "company"; companyId: string }
  | { kind: "order"; companyId: string; orderId: string };

export type LegalBodyThread =
  | LegalBodyThreadRef
  /** A remembered order that has closed since: shown once, with its reason. The screen forgets
   *  the order's id once it has rendered it. */
  | { kind: "closed-order"; companyId: string; orderId: string }
  /** Nothing open: the done page of a finished body. */
  | { kind: "done"; companyId: string; orderId: string }
  | { kind: "chooser"; threads: LegalBodyThreadRef[] }
  | { kind: "new-company" };

/**
 * Which company or order the page is about, in this order:
 *  1. the remembered order, when the server lists it for one of the tenant's companies, whatever
 *     its state: live, it is the thread; finished, its done page; closed, shown once;
 *  2. the remembered company, when it is open: its one live order, or itself when it has no live
 *     order and no linked body;
 *  3. every live order and every open company with neither: one is the thread, several make a
 *     chooser, none leaves the newest linked body's done page, or a new company.
 * An order whose company is not among the tenant's is ignored throughout.
 */
export function selectLegalBodyThread(input: {
  companies: CompanyView[];
  orders: LegalBodyOrderView[];
  stored: Pick<LegalBodyMemory, "companyId" | "orderId"> | null;
  nowMs: number;
}): LegalBodyThread {
  const { companies, stored, nowMs } = input;
  const byId = new Map(companies.map((c) => [c.companyId, c]));
  const orders = input.orders.filter((o) => byId.has(o.companyId));
  const ordersOf = (companyId: string) => orders.filter((o) => o.companyId === companyId);
  const live = (o: LegalBodyOrderView) => isLiveOrder(o, nowMs);
  const linked = (o: LegalBodyOrderView) => o.state === "linked";

  if (stored?.orderId) {
    const o = orders.find((x) => x.id === stored.orderId);
    if (o) {
      if (live(o)) return { kind: "order", companyId: o.companyId, orderId: o.id };
      if (isFinished(o)) return { kind: "done", companyId: o.companyId, orderId: o.id };
      return { kind: "closed-order", companyId: o.companyId, orderId: o.id };
    }
  }

  if (stored?.companyId) {
    const c = byId.get(stored.companyId);
    if (c && isOpenCompany(c)) {
      const own = ordersOf(c.companyId);
      const open = own.filter(live);
      if (open.length === 1) return { kind: "order", companyId: c.companyId, orderId: open[0].id };
      if (open.length === 0 && !own.some(linked)) return { kind: "company", companyId: c.companyId };
    }
  }

  const threads: LegalBodyThreadRef[] = orders
    .filter(live)
    .map((o) => ({ kind: "order", companyId: o.companyId, orderId: o.id }));
  for (const c of companies) {
    // A company with a live order is that order's thread; one with a linked body is finished.
    if (isOpenCompany(c) && !ordersOf(c.companyId).some((o) => live(o) || linked(o)))
      threads.push({ kind: "company", companyId: c.companyId });
  }
  if (threads.length === 1) return threads[0];
  if (threads.length > 1) return { kind: "chooser", threads };

  const newest = orders
    .filter(linked)
    .reduce<LegalBodyOrderView | null>(
      (best, o) => (best === null || timeOf(o) > timeOf(best) ? o : best),
      null,
    );
  if (newest) return { kind: "done", companyId: newest.companyId, orderId: newest.id };
  return { kind: "new-company" };
}

/** For ordering only: an unparsable `createdAt` sorts oldest. */
function timeOf(order: LegalBodyOrderView): number {
  const ms = createdMs(order);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

// ---------------------------------------------------------------------------------------------
// 2. Which phase
// ---------------------------------------------------------------------------------------------

/**
 * The identity step's refusal: an agentId that already has a body on its way or linked for this
 * tenant, on this deployment. Linking another body would replace it, which is not offered here.
 */
export function identityHasBody(
  orders: LegalBodyOrderView[],
  agentId: string,
  where: { chainId: number; factory: Address },
): boolean {
  return orders.some(
    (o) =>
      o.agentId === agentId &&
      o.chainId === where.chainId &&
      sameAddress(o.factory, where.factory) &&
      (o.state === "linked" || o.state === "reserved" || o.state === "deployed"),
  );
}

/** The `type` the documents route serves for a control upload (`FormationDocument` has no kind). */
export const CONTROL_UPLOAD_TYPE = "evidence_control";

function companyPhase(
  company: CompanyView | null,
  documents: FormationDocument[] | null,
): LegalBodyDerivation {
  if (!isCustomerCompany(company)) return { phase: "company", companyStep: "form" };
  if (company.state === "abandoned")
    return { phase: "company", companyStep: "form", notice: { kind: "company_abandoned" } };
  const verification = company.verification;
  if (!verification) return { phase: "company", companyStep: "loading" };
  switch (verification.state) {
    case "verified":
      return { phase: "agreement" };
    case "failed":
      return {
        phase: "company",
        companyStep: "failed",
        notice: { kind: "company_failed", reasonCode: verification.reasonCode },
      };
    case "revoked":
      return { phase: "company", companyStep: "revoked", notice: { kind: "company_revoked" } };
    case "awaiting_check": {
      // Nobody uploads on sandbox: a company awaiting a check there waits for the operator.
      if (company.environment === "sandbox") return { phase: "company", companyStep: "waiting" };
      if (documents === null) return { phase: "company", companyStep: "loading" };
      const controlIn = documents.some((d) => d.type === CONTROL_UPLOAD_TYPE);
      return { phase: "company", companyStep: controlIn ? "waiting" : "evidence" };
    }
    default:
      // A check state this build does not know reads like a check that could not be read.
      return { phase: "company", companyStep: "loading" };
  }
}

/** The phase after a linked body, or a revoked one: the payment a charging deployment still owes
 *  for the company, else done. A notice always means done: nothing is charged beside it. */
function doneOrPayment(input: LegalBodyFlowInput, notice?: LegalBodyNotice): LegalBodyDerivation {
  if (notice) return { phase: "done", notice };
  const unpaid =
    input.config.paymentRequired &&
    isCustomerCompany(input.company) &&
    input.company.state !== "ready";
  return { phase: unpaid ? "payment" : "done" };
}

/**
 * Which screen the thread is on, and why. With no order it is the company step; with one, the
 * order's state decides, and the local choices count only while that state is `draft`.
 */
export function deriveLegalBodyPhase(input: LegalBodyFlowInput): LegalBodyDerivation {
  const { config, sessionAddress, nowMs, company, documents, orders, order } = input;

  if (order === null) return companyPhase(company, documents);

  // An order made on another deployment (another chain or factory) cannot move here.
  if (order.chainId !== config.chainId || !sameAddress(order.factory, config.factory))
    return { phase: "closed", notice: { kind: "other_deployment" } };

  // From `reserved` on, the server knows who owns the identity: the branch is a fact, not a choice.
  const branch: OwnerBranch = sameAddress(order.identityOwner, sessionAddress) ? "browser" : "paste";

  switch (order.state) {
    case "draft": {
      if (order.revoked) return { phase: "closed", notice: { kind: "order_revoked" } };
      if (isDraftExpired(order, nowMs)) return { phase: "closed", notice: { kind: "expired" } };
      // The company wins while the order is a draft: the link door refuses a company that is
      // abandoned or whose latest check did not pass.
      if (
        !isCustomerCompany(company) ||
        company.state === "abandoned" ||
        company.verification?.state !== "verified"
      ) {
        const back = companyPhase(company, documents);
        return back.notice ? back : { ...back, notice: { kind: "company_awaiting_check" } };
      }
      if (input.ownerChoice === null) return { phase: "agreement" };
      if (input.agentId === null) return { phase: "identity" };
      if (identityHasBody(orders, input.agentId, config))
        return { phase: "identity", notice: { kind: "identity_taken", agentId: input.agentId } };
      return { phase: "link", branch: input.ownerChoice === "this-wallet" ? "browser" : "paste" };
    }
    case "reserved":
      return { phase: "link", branch, notice: { kind: "creating" } };
    case "deployed":
      if (order.revoked) return { phase: "closed", notice: { kind: "order_revoked" } };
      return { phase: "pointer", branch };
    case "broken":
      switch (order.brokenReason) {
        case "not_linked":
          return order.revoked
            ? { phase: "done", notice: { kind: "order_revoked" } }
            : { phase: "pointer", branch };
        case "replaced":
          return { phase: "closed", notice: { kind: "replaced", by: order.replacedBy } };
        case "winding_down":
        case "dissolved":
          return { phase: "done", notice: { kind: order.brokenReason } };
        default:
          // No reason served: never offer the pointer, which could break a replacement.
          return { phase: "done", notice: { kind: "broken_reason_unknown" } };
      }
    case "linked":
      if (order.revoked) return doneOrPayment(input, { kind: "order_revoked" });
      if (company?.verification?.state === "revoked")
        return doneOrPayment(input, { kind: "company_revoked" });
      return doneOrPayment(input);
    case "lapsed":
      return { phase: "closed", notice: { kind: "lapsed", reason: order.lapseReason } };
    case "superseded":
      // Closed by its successor, whatever the reason of its last break says.
      return { phase: "closed", notice: { kind: "superseded", by: order.supersededBy } };
    case "abandoned":
      return { phase: "closed", notice: { kind: "abandoned" } };
    default:
      // A state this build does not know: nothing is offered.
      return { phase: "closed" };
  }
}

// ---------------------------------------------------------------------------------------------
// 3. The pointer step's chain check, before any wallet prompt or copy box
// ---------------------------------------------------------------------------------------------

export type PointerPreflight =
  | { ok: true }
  | { ok: false; reason: "no_identity" | "identity_moved" | "not_this_wallet" };

/**
 * The two chain reads of the pointer step: the identity's current owner and the owner the factory
 * recorded when it created the body. Both must be the order's identity owner; on the browser
 * branch the connected wallet must be that owner too. Otherwise no prompt: the identity changed
 * hands, and a new link from its current owner is needed.
 */
export function pointerPreflight(p: {
  branch: OwnerBranch;
  connected: Address | null;
  identityOwner: Address;
  /** `ownerOf(agentId)`, or "none" when the call reverted: no identity with this id. */
  ownerOf: Address | "none";
  ownerAtCreation: Address;
}): PointerPreflight {
  if (p.ownerOf === "none") return { ok: false, reason: "no_identity" };
  if (!sameAddress(p.ownerOf, p.ownerAtCreation) || !sameAddress(p.ownerOf, p.identityOwner))
    return { ok: false, reason: "identity_moved" };
  if (p.branch === "browser" && !sameAddress(p.connected, p.ownerOf))
    return { ok: false, reason: "not_this_wallet" };
  return { ok: true };
}
