import { type Address, isAddressEqual } from "viem";
import { ApiError } from "../errors";
import { opsLog } from "../observability/opsLog";
import type { BindingState, LegalBodyRecord } from "../persistence/legalBodyRepository";
import { parseSqliteUtc } from "../util/sqliteTime";
import { type LegalBodyOrderDeps, assertThisDeployment } from "./orders";

/**
 * THE BINDING CHECK: whether the identity's pointer names an order's body, and what follows.
 *
 * Once its body is created, an order is bound to its identity only while the identity's owner
 * keeps a pointer to that body in the identity's metadata, under `LEGAL_BODY_POINTER_KEY`. The
 * factory decides what counts as a pointer (`linkedLegalBody`: among other things, the body must be
 * active), so the check asks the factory and nothing else, and reads everything at ONE block: the
 * head first, then the pointer at the head's number and, when a linked body stops passing, the
 * body's status at that same number. The row's state is a cache of that answer, moved only by the
 * repository's compare-and-set:
 *
 *   deployed | broken | superseded ──the pointer names the body──▶ linked
 *   linked ──the pointer names nothing or another body──▶ broken, with the reason the body's
 *     status gives: `not_linked` while it is active, `winding_down` while its dissolution can
 *     still be vetoed (a veto makes it active again), `dissolved` once that is final
 *
 * Linking a body breaks any other body linked for the same identity, in the same transaction
 * (`markLinked`, reason `replaced`), and starts each one's broken schedule over. Nothing else moves
 * here: a body never linked stays `deployed` or `superseded` until its pointer is written, and a
 * broken one stays `broken`.
 *
 * ONE WRITER PER ORDER: the caller holds the order's lock (`orderLockKey`), the sweeper or the
 * binding refresh door. This module takes no lock: the lock is not re-entrant.
 *
 * A CHAIN THAT CANNOT ANSWER IS `unknown`: no state moves, the schedule moves forward by its
 * interval, so one failing row does not stay due, and one line names the stage and the error's
 * NAME, never its message (a transport error's message can carry the node's URL).
 *
 * THE SCHEDULE (`nextBindingSchedule`), in unix milliseconds. As in the resolve schedule, the
 * row's interval is the wait its NEXT check applies (the deploy leaves the row due at once with an
 * interval of a minute): a check waits that long and stores twice that, up to the leg's cap; a
 * check after which the row is in another state than before starts that state's leg over, at the
 * leg's first interval. The legs:
 *  - never linked (`deployed`, or `superseded` with no pointer ever seen): a minute, doubling to
 *    an hour, until 7 days after `deployedAt`;
 *  - `linked`: every 24 hours, for as long as it is linked;
 *  - broken (`broken`, or `superseded` after a pointer was seen): an hour, doubling to 24 hours,
 *    until 30 days after the row's last state move (`updatedAt`, which only a move changes). A
 *    body found winding down stays on this leg, so a veto is seen, but carries no pointer intent:
 *    the factory does not count a pointer to it while it winds down;
 *  - a body found dissolved: no further check and no pointer intent, since a dissolution, once
 *    final, cannot be undone. A refresh still reads it.
 */

/** The identity-metadata key the owner writes the pointer under, as the factory reads it. */
export const LEGAL_BODY_POINTER_KEY = "legalBody";

/**
 * What the identity's owner should do for an order: point the identity at its body. It names the
 * action, the identity, the body and the chain, and holds no calldata: the caller encodes the
 * pointer and the metadata write itself, from a pinned ABI.
 */
export interface PointerIntent {
  action: "setLegalBodyPointer";
  agentId: string;
  body: Address;
  chainId: number;
}

/** An order's binding as the API shows it: no bigint, no text read from the chain. */
export interface BindingView {
  state: BindingState;
  /** A uint256 in decimal. */
  agentId: string | null;
  bodyAddress: Address | null;
  intent: PointerIntent | null;
  /** Unix seconds: the sighting of the pointer that opened the latest linked stretch. */
  pointerSeenAt: number | null;
  /** Unix milliseconds: the next scheduled check, if any. */
  nextCheckAt: number | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The reasons this check writes on a `broken` event, one per status of the body. */
const NOT_LINKED = "not_linked";
const WINDING_DOWN = "winding_down";
const DISSOLVED = "dissolved";
const BREAK_REASONS = {
  active: NOT_LINKED,
  winding_down: WINDING_DOWN,
  dissolved: DISSOLVED,
} as const;
/** The breaks a pointer cannot mend: the factory counts no pointer to such a body. */
const NO_INTENT_REASONS: readonly string[] = [WINDING_DOWN, DISSOLVED];

/** The states a binding check reads the chain for: a body exists, so a pointer can name it. */
const CHECKABLE_STATES: readonly BindingState[] = ["deployed", "linked", "broken", "superseded"];
/** The states whose body the owner is invited to point at. */
const POINTABLE_STATES: readonly BindingState[] = ["deployed", "broken", "superseded"];

/** Which leg of the schedule a row is on. */
type Leg = "never_linked" | "linked" | "broken";

/** Each leg's first interval and cap, in milliseconds. */
const LEG_INTERVALS: Record<Leg, { firstMs: number; capMs: number }> = {
  never_linked: { firstMs: MINUTE_MS, capMs: HOUR_MS },
  linked: { firstMs: DAY_MS, capMs: DAY_MS },
  broken: { firstMs: HOUR_MS, capMs: DAY_MS },
};
/** How long a body never linked is checked, from its creation. */
const NEVER_LINKED_CHECKED_FOR_MS = 7 * DAY_MS;
/** How long a broken body is checked, from its last state move. */
const BROKEN_CHECKED_FOR_MS = 30 * DAY_MS;

function legOf(row: LegalBodyRecord): Leg | undefined {
  switch (row.bindingState) {
    case "deployed":
      return "never_linked";
    case "superseded":
      return row.pointerSeenAt === null ? "never_linked" : "broken";
    case "linked":
      return "linked";
    case "broken":
      return "broken";
    default:
      return undefined;
  }
}

/**
 * The reason of the row's newest break, for a row that was linked once and is not linked now
 * (`broken`, or `superseded` after a pointer was seen); undefined for any other row, which an
 * older break no longer describes.
 */
function breakReason(
  row: LegalBodyRecord,
  latestBrokenReason: string | undefined,
): string | undefined {
  return legOf(row) === "broken" ? latestBrokenReason : undefined;
}

/** The instant the row's leg stops being checked, in unix milliseconds; none for `linked`. */
function legEndsAt(row: LegalBodyRecord, leg: Leg): number | undefined {
  switch (leg) {
    case "never_linked":
      if (row.deployedAt === null)
        throw new Error(`legal body ${row.legalBodyId} is ${row.bindingState} without deployedAt`);
      // `deployedAt` is a chain time, in seconds.
      return row.deployedAt * 1_000 + NEVER_LINKED_CHECKED_FOR_MS;
    case "broken":
      // Stored UTC text; `Date.parse` alone would read it as local time.
      return parseSqliteUtc(row.updatedAt) + BROKEN_CHECKED_FOR_MS;
    case "linked":
      return undefined;
  }
}

/** The pointer the owner should write for this order, or none: only a created body that is not
 *  linked now, and never one last found winding down or dissolved, which a pointer would not link
 *  (a winding-down body that a veto made active again is linked by the check if its pointer
 *  still names it). */
export function pointerIntent(
  row: LegalBodyRecord,
  latestBrokenReason: string | undefined,
): PointerIntent | undefined {
  const reason = breakReason(row, latestBrokenReason);
  if (
    !POINTABLE_STATES.includes(row.bindingState) ||
    (reason !== undefined && NO_INTENT_REASONS.includes(reason))
  )
    return undefined;
  const { agentId, bodyAddress } = row;
  if (agentId === null || bodyAddress === null) return undefined;
  return { action: "setLegalBodyPointer", agentId, body: bodyAddress, chainId: row.chainId };
}

/**
 * The row's next check, or undefined: stop (see THE SCHEDULE above). `moved` says the row is in
 * another state than at its previous check, which starts the new state's leg over. The returned
 * `intervalMs` is the wait the check after `nextAt` will apply.
 */
export function nextBindingSchedule(
  row: LegalBodyRecord,
  nowMs: number,
  moved: boolean,
  latestBrokenReason: string | undefined,
): { nextAt: number; intervalMs: number } | undefined {
  const leg = legOf(row);
  if (leg === undefined || breakReason(row, latestBrokenReason) === DISSOLVED) return undefined;
  const endsAt = legEndsAt(row, leg);
  if (endsAt !== undefined && nowMs >= endsAt) return undefined;
  const { firstMs, capMs } = LEG_INTERVALS[leg];
  const stored = row.bindingCheckIntervalMs;
  // An interval stored by another leg (the deploy's minute on a row now linked) is brought into
  // this leg's range.
  const waitMs = moved || stored === null ? firstMs : Math.min(Math.max(stored, firstMs), capMs);
  return { nextAt: nowMs + waitMs, intervalMs: Math.min(waitMs * 2, capMs) };
}

export function toBindingView(
  row: LegalBodyRecord,
  latestBrokenReason: string | undefined,
): BindingView {
  return {
    state: row.bindingState,
    agentId: row.agentId,
    bodyAddress: row.bodyAddress,
    intent: pointerIntent(row, latestBrokenReason) ?? null,
    pointerSeenAt: row.pointerSeenAt,
    nextCheckAt: row.nextBindingCheckAt,
  };
}

/** What the chain said, read at one block, and the move it calls for. */
type Reading =
  | { move: "none" }
  | { move: "link"; seenAt: number; block: number }
  | { move: "break"; reason: (typeof BREAK_REASONS)[keyof typeof BREAK_REASONS]; block: number };

/** What this check moved. */
type Moved =
  | { outcome: "linked"; replaced: string[]; block: number }
  | { outcome: "broken"; reason: string; block: number }
  | { outcome: "unchanged" };

/**
 * One binding check. The caller holds the order's lock.
 *
 *  1. A row in no checkable state (`deployed`, `linked`, `broken`, `superseded`) is
 *     `not_checkable`, with no chain call, and its schedule is cleared, except a `reserved` row's:
 *     that schedule settles the order, and only its deploy or its lapse ends it. An unknown id is
 *     `not_checkable` too, and so is a row of another factory or chain than this deployment's,
 *     left as it is: the factory read here says nothing about a body another factory created.
 *  2. The head, then `linkedLegalBody(agentId, head.number)`: the factory's whole predicate.
 *  3. It names the row's body: a row not linked yet is marked linked, seen at the head's time
 *     (`linked`), and each body that link replaced is checked again an hour later, with an
 *     interval of an hour; a linked row is `unchanged`.
 *  4. It names nothing or another body: a linked row's body status is read at the same block, and
 *     the row is broken with the reason that status gives: `not_linked` (active), `winding_down`
 *     or `dissolved` (`broken`). Any other row is `unchanged`.
 *  5. The schedule is set from `nextBindingSchedule`, or cleared, in the transaction of the move.
 * A throw from the chain is `unknown`: nothing moves, and the schedule moves forward by its
 * interval. A throw from the database is not the chain's, and propagates.
 */
export async function checkBinding(
  deps: LegalBodyOrderDeps,
  id: string,
): Promise<"linked" | "broken" | "unchanged" | "unknown" | "not_checkable"> {
  // 1.
  const row = deps.repo.findById(id);
  if (row === undefined) return "not_checkable";
  if (!CHECKABLE_STATES.includes(row.bindingState)) {
    if (row.bindingState !== "reserved" && row.nextBindingCheckAt !== null)
      deps.repo.scheduleBindingCheck(id, null, null);
    return "not_checkable";
  }
  if (!ofThisDeployment(deps, row)) return "not_checkable";
  const { agentId, bodyAddress } = row;
  if (agentId === null || bodyAddress === null)
    throw new Error(`legal body ${id} is ${row.bindingState} without its identity or body`);
  const agent = BigInt(agentId);

  // 2. to 4.: the chain's answer, at one block.
  let reading: Reading;
  let stage = "head";
  try {
    const head = await deps.chain.head();
    const block = Number(head.number);
    stage = "linked_legal_body";
    const linked = await deps.chain.linkedLegalBody(agent, head.number);
    if (linked !== undefined && isAddressEqual(linked, bodyAddress)) {
      reading =
        row.bindingState === "linked"
          ? { move: "none" }
          : { move: "link", seenAt: Number(head.timestamp), block };
    } else if (row.bindingState === "linked") {
      stage = "body_status";
      const status = await deps.chain.bodyStatus(bodyAddress, head.number);
      reading = { move: "break", reason: BREAK_REASONS[status], block };
    } else {
      reading = { move: "none" };
    }
  } catch (err) {
    opsLog("legal_body_binding", {
      level: "warn",
      orderId: id,
      outcome: "unknown",
      stage,
      errorName: err instanceof Error ? err.name : "not_an_error",
    });
    deps.transaction(() => reschedule(deps, row));
    return "unknown";
  }

  // 3. to 5.: the move and the schedule, in one transaction; the line once it is committed.
  const moved = deps.transaction((): Moved => {
    const made = applyReading(deps, id, reading);
    reschedule(deps, row);
    return made;
  });
  logMove(id, moved);
  return moved.outcome;
}

/** A row of this deployment, by the one rule the doors apply (`assertThisDeployment`). */
function ofThisDeployment(deps: LegalBodyOrderDeps, row: LegalBodyRecord): boolean {
  try {
    assertThisDeployment(deps, row);
    return true;
  } catch (err) {
    if (err instanceof ApiError) return false;
    throw err;
  }
}

/** The move the reading calls for, by compare-and-set: a move the row no longer allows is not
 *  made, and the check is `unchanged`. */
function applyReading(deps: LegalBodyOrderDeps, id: string, reading: Reading): Moved {
  switch (reading.move) {
    case "link": {
      const linked = deps.repo.markLinked(id, reading.seenAt);
      if (linked.outcome !== "linked") return { outcome: "unchanged" };
      // Each body this link replaced is broken now, and its broken schedule starts at its first
      // interval rather than at the day its linked schedule held. A schedule moves no state, so
      // this write on another order's row needs no lock of its own.
      const { firstMs } = LEG_INTERVALS.broken;
      const nowMs = (deps.now ?? Date.now)();
      for (const replacedId of linked.replaced)
        deps.repo.scheduleBindingCheck(replacedId, nowMs + firstMs, firstMs);
      return { outcome: "linked", replaced: linked.replaced, block: reading.block };
    }
    case "break":
      // A JSON number: the event writer redacts a string of nine digits or more.
      return deps.repo.markBroken(id, { reason: reading.reason, observedAtBlock: reading.block })
        ? { outcome: "broken", reason: reading.reason, block: reading.block }
        : { outcome: "unchanged" };
    case "none":
      return { outcome: "unchanged" };
  }
}

/**
 * The row's next check, from the row as it is now. `moved` compares its state with the one the
 * check began with, so a move made by another order's transaction meanwhile (a replacement)
 * starts the new leg over too.
 */
function reschedule(deps: LegalBodyOrderDeps, before: LegalBodyRecord): void {
  const id = before.legalBodyId;
  const row = deps.repo.findById(id);
  if (row === undefined) throw new Error(`legal body ${id} vanished during its binding check`);
  const next = nextBindingSchedule(
    row,
    (deps.now ?? Date.now)(),
    row.bindingState !== before.bindingState,
    deps.repo.latestBrokenReason(id),
  );
  if (next !== undefined) deps.repo.scheduleBindingCheck(id, next.nextAt, next.intervalMs);
  else if (row.nextBindingCheckAt !== null) deps.repo.scheduleBindingCheck(id, null, null);
}

/** One line per move; an unchanged binding writes none. */
function logMove(orderId: string, moved: Moved): void {
  switch (moved.outcome) {
    case "linked":
      opsLog("legal_body_binding", {
        level: "info",
        orderId,
        outcome: "linked",
        block: moved.block,
        ...(moved.replaced.length > 0 ? { replaced: moved.replaced } : {}),
      });
      return;
    case "broken":
      opsLog("legal_body_binding", {
        level: "info",
        orderId,
        outcome: "broken",
        reason: moved.reason,
        block: moved.block,
      });
      return;
    case "unchanged":
      return;
  }
}
