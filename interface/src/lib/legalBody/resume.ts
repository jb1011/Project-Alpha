import type { Address, CompanyView, LegalBodyOrderView } from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import {
  isLiveOrder,
  sameAddress,
  type LegalBodyThread,
  type LegalBodyThreadRef,
} from "@/lib/legalBody/flow";
import type { LegalBodyRailPhase } from "@/lib/legalBody/phases";
import type { LegalBodyMemory, OwnerChoice } from "@/lib/legalBody/storage";

/**
 * Resuming the flow from the server's state, the local memory as a hint.
 *
 * The server decides where a person is (`selectLegalBodyThread`, `deriveLegalBodyPhase`); this
 * module says what the memory holds once a thread is on screen, which of its draft choices count,
 * what a "start another" click overrides until the new order or company exists, and what a jump
 * back on the rail changes before the derivation decides again.
 */

type Memo = Omit<LegalBodyMemory, "tenant">;

const EMPTY: Memo = { companyId: null, orderId: null, ownerChoice: null, agentId: null };

/** The company and order a screen reads for a thread; null for a chooser, which has none yet. */
export function threadRefsOf(
  thread: LegalBodyThread,
): { companyId: string | null; orderId: string | null } | null {
  switch (thread.kind) {
    case "order":
    case "done":
    case "closed-order":
      return { companyId: thread.companyId, orderId: thread.orderId };
    case "company":
      return { companyId: thread.companyId, orderId: null };
    case "new-company":
      return { companyId: null, orderId: null };
    case "chooser":
      return null;
  }
}

/** A patch over a base, always for this tenant. */
export function mergeLegalBodyMemory(
  tenant: Address,
  base: LegalBodyMemory | null,
  patch: Partial<Memo>,
): LegalBodyMemory {
  const b = base ?? { tenant, ...EMPTY };
  const kept: Memo = {
    companyId: b.companyId,
    orderId: b.orderId,
    ownerChoice: b.ownerChoice,
    agentId: b.agentId,
  };
  return { ...kept, ...patch, tenant };
}

/**
 * What the memory holds once `thread` is on screen, or null when it already holds that (and for a
 * chooser, which changes nothing until a pick).
 *
 * The draft choices belong to one order: another order starts with none. A closed order is shown
 * once: its id is dropped after it renders, so the next visit does not show it again.
 */
export function memoryAfterThread(p: {
  tenant: Address;
  stored: LegalBodyMemory | null;
  thread: LegalBodyThread;
}): LegalBodyMemory | null {
  const refs = threadRefsOf(p.thread);
  if (refs === null) return null;
  const orderId = p.thread.kind === "closed-order" ? null : refs.orderId;
  const base = p.stored ?? { tenant: p.tenant, ...EMPTY };
  const sameOrder = orderId !== null && base.orderId === orderId;
  const next: LegalBodyMemory = {
    tenant: p.tenant,
    companyId: refs.companyId,
    orderId,
    ownerChoice: sameOrder ? base.ownerChoice : null,
    agentId: sameOrder ? base.agentId : null,
  };
  const unchanged =
    sameAddress(base.tenant, next.tenant) &&
    base.companyId === next.companyId &&
    base.orderId === next.orderId &&
    base.ownerChoice === next.ownerChoice &&
    base.agentId === next.agentId;
  return unchanged ? null : next;
}

/**
 * The owner choice and the identity the derivation may read: only those made for this thread's
 * order. A choice made for an earlier order would otherwise skip the new one's agreement.
 */
export function draftChoices(
  memory: LegalBodyMemory | null,
  thread: LegalBodyThread,
): { ownerChoice: OwnerChoice | null; agentId: string | null } {
  if (memory && thread.kind === "order" && memory.orderId === thread.orderId)
    return { ownerChoice: memory.ownerChoice, agentId: memory.agentId };
  return { ownerChoice: null, agentId: null };
}

/**
 * A click that starts something new, held in memory only until what it starts exists:
 *  - `another-agent`: a new order on this company (the done page's first button, a closed order's
 *    way out); `known` is the orders there were at the click;
 *  - `another-company`: a new declaration; `known` is the companies there were at the click.
 */
export type LegalBodyIntent =
  | { kind: "another-agent"; companyId: string; known: readonly string[] }
  | { kind: "another-company"; known: readonly string[] };

/**
 * The thread with the intent over it. The intent ends by itself once what it started exists, so
 * it can never hold a finished thread back:
 *  - `another-agent`: the company, until an order of it appears that was not there at the click;
 *    then that order while it is live on this deployment, and the selection once it is not (by
 *    then the memory names it, so its done page is the selection's);
 *  - `another-company`: a new declaration, until a company appears that was not there at the
 *    click; then the selection.
 */
export function threadWithIntent(
  thread: LegalBodyThread,
  intent: LegalBodyIntent | null,
  p: {
    companies: CompanyView[];
    orders: LegalBodyOrderView[];
    nowMs: number;
    where: { chainId: number; factory: Address };
  },
): LegalBodyThread {
  if (intent === null) return thread;
  if (intent.kind === "another-company") {
    const appeared = p.companies.some((c) => !intent.known.includes(c.companyId));
    return appeared ? thread : { kind: "new-company" };
  }
  if (!p.companies.some((c) => c.companyId === intent.companyId)) return thread;
  const fresh = p.orders
    .filter((o) => o.companyId === intent.companyId && !intent.known.includes(o.id))
    .sort((a, b) => timeOf(b) - timeOf(a));
  if (fresh.length === 0) return { kind: "company", companyId: intent.companyId };
  const newest = fresh[0];
  const liveHere =
    newest.chainId === p.where.chainId &&
    sameAddress(newest.factory, p.where.factory) &&
    isLiveOrder(newest, p.nowMs);
  return liveHere ? { kind: "order", companyId: intent.companyId, orderId: newest.id } : thread;
}

/** A click that names the thread itself (a pick, a new company, a new order) ends any intent: the
 *  memory now says what the page is about. */
export function patchEndsIntent(patch: Partial<Memo>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(patch, "companyId") ||
    Object.prototype.hasOwnProperty.call(patch, "orderId")
  );
}

function timeOf(order: LegalBodyOrderView): number {
  const ms = Date.parse(order.createdAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * What a jump back on the rail changes in the memory before the derivation decides again: the
 * owner choice and the identity are the only local inputs, read while the order is a draft. Every
 * other phase is the server's: the jump re-renders and the derivation lands where the facts are.
 */
export function jumpMemoryPatch(target: LegalBodyRailPhase): Partial<Memo> | null {
  if (target === "agreement") return { ownerChoice: null, agentId: null };
  if (target === "identity") return { agentId: null };
  return null;
}

/**
 * The flow's clock: the latest of the moment the screen mounted and each read of the server. A
 * draft's 24 hours are measured against it, so the time moves with every read (polling, focus, a
 * click's refetch) and no timer runs for it.
 */
export function flowNowMs(mountedAtMs: number, readAtMs: readonly number[]): number {
  return Math.max(mountedAtMs, ...readAtMs);
}

/* ── The chooser ───────────────────────────────────────────────────────────────────────────── */

export type ChooserRow = {
  key: string;
  ref: LegalBodyThreadRef;
  title: string;
  detail: string;
  identity: string | null;
};

/** One row per open thread: the declared name, and the state in words. */
export function chooserRows(
  threads: LegalBodyThreadRef[],
  companies: CompanyView[],
  orders: LegalBodyOrderView[],
): ChooserRow[] {
  const C = LEGAL_BODY_COPY.chooser;
  const nameOf = (companyId: string) =>
    companies.find((c) => c.companyId === companyId)?.declared?.companyName ?? null;
  return threads.map((ref) => {
    if (ref.kind === "company") {
      return {
        key: `company:${ref.companyId}`,
        ref,
        title: nameOf(ref.companyId) ?? C.unnamed,
        detail: C.companyRow,
        identity: null,
      };
    }
    const order = orders.find((o) => o.id === ref.orderId);
    const state = order?.state;
    const detail =
      state === "draft" || state === "reserved" || state === "deployed" || state === "broken"
        ? C.orderStates[state]
        : C.orderStates.other;
    return {
      key: `order:${ref.orderId}`,
      ref,
      title: order?.companyName ?? nameOf(ref.companyId) ?? C.unnamed,
      detail,
      identity: order?.agentId ? fillCopy(C.identity, { agentId: order.agentId }) : null,
    };
  });
}
