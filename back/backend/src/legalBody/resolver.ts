import { type Address, type Hex, isAddressEqual } from "viem";
import {
  type LegalBodyCreated,
  LegalBodyGasTooHighError,
  type SubmitCreateResult,
} from "../adapters/arc/legalBodyChain";
import { ContractRevertError } from "../adapters/arc/relay";
import { opsLog } from "../observability/opsLog";
import type {
  DeploySubmission,
  LapseReason,
  LegalBodyRecord,
} from "../persistence/legalBodyRepository";
import { checkLink } from "./checkLink";
import {
  CreateCapError,
  MAX_CREATE_SUBMISSIONS_PER_ORDER,
  linkOfRow,
  submitCreateFor,
} from "./create";
import { type LegalBodyOrderDeps, companyEligible } from "./orders";

/**
 * THE RESOLVER: one reserved order settled from the chain.
 *
 * A reserved order holds an identity for a link its owner signed, and every create submitted for
 * it is recorded before it was sent (hash, raw bytes, nonce). The resolver reads what the chain
 * says now and takes the first rule of `resolveOrder` that matches: it adopts a body the row's
 * owner created, lapses an order whose body was made for someone else or whose deadline the chain
 * has passed, submits the create again when its bytes are dead, waits while the node's pool holds
 * their nonce, sends the same bytes again when the node lost them, and fills a nonce of the
 * platform key that nothing holds, since nothing above it can be mined until it is filled.
 *
 * EVERY DECISION COMES FROM THE CHAIN: `createdState`, `createOutcome`, `findCreation` and the
 * executor's two nonce counts. A hash is written only when the chain named it, from a receipt or
 * from the factory's log. Nothing is sent that was not recorded: a fresh create goes through
 * `submitCreateFor`, which records before it sends, and a re-send sends recorded bytes only.
 *
 * ONE WRITER PER ORDER: the caller holds the order's lock (`orderLockKey`): the sweeper, or the
 * link door, which runs one pass when its own create reverted. This module never takes that lock
 * or any other order's: the lock is not re-entrant, and a second take would wait for ever. Every
 * move is a compare-and-set: a row another order moved meanwhile (the give-way of a new owner's
 * link) loses nothing but this pass, which answers `not_reserved`.
 *
 * A CHAIN THAT CANNOT ANSWER IS `unknown`: no state moves, the schedule backs off, and one line
 * names the error, never its message (a transport error's message can carry the node's URL).
 * Rules 8 and 9a name their own answer to a failed re-send: `waiting`.
 *
 * NOBODY CAN STOP THE CALLER: every answer but `deployed`, `lapsed` and `not_reserved` moves the
 * row's schedule (the resolve schedule), so a row that cannot be settled backs off instead of
 * staying due. A row is logged once per outcome, never once per pass, and a throw is a warning,
 * never a page.
 *
 * A BODY THE CHAIN CREATED WHOSE CREATION CANNOT BE LOCATED IS AN ERROR: the row answers `unknown`
 * on every pass, past its deadline too, since rule 1 comes before rule 3, so it never lapses and
 * its identity stays held. No hash is invented for it: one error line says so, for a person to
 * look at.
 */

export type ResolveOutcome =
  | "deployed"
  | "lapsed"
  | "resubmitted"
  | "rebroadcast"
  | "waiting"
  | "unknown"
  | "not_reserved";

/** Milliseconds: the first interval of the resolve schedule, after the reserve and after a
 *  resubmission. It doubles after each `waiting`, `unknown` or `rebroadcast`... */
export const RESOLVE_FIRST_INTERVAL_MS = 30_000;
/** ...up to this many milliseconds. */
export const RESOLVE_MAX_INTERVAL_MS = 600_000;
/** Milliseconds: the binding check's first interval once a body is deployed. */
const DEPLOYED_CHECK_INTERVAL_MS = 60_000;
/** The `act` of the note that keeps the head the search for a creation stops at. */
const CREATION_SEARCH_NOTE = "creation_search";
/** The `why` of an `unknown` whose body exists but whose creation no search found. */
const CREATION_NOT_FOUND = "creation_not_found";

/** What one pass decided, with the facts its log line carries. */
type Settled =
  | { outcome: "deployed"; txHash: Hex; from: "receipt" | "factory_log" }
  | { outcome: "lapsed"; reason: LapseReason }
  | { outcome: "resubmitted"; txHash: Hex; nonce: number }
  | { outcome: "rebroadcast"; nonce: number; why: "lost_bytes" | "nonce_gap" }
  | { outcome: "waiting"; why: string; facts?: Record<string, string | number> }
  | { outcome: "unknown"; stage: string; errorName?: string; why?: string }
  | { outcome: "not_reserved" };

/** A chain call that threw. Never leaves this module: the pass answers `unknown`. */
class ChainUnknown extends Error {
  constructor(
    readonly stage: string,
    readonly errorName: string,
  ) {
    super(`the chain could not answer at ${stage}`);
    this.name = "ChainUnknown";
  }
}

const nameOf = (err: unknown) => (err instanceof Error ? err.name : "not_an_error");

/** One chain call: its throw becomes `ChainUnknown`, naming the stage and the error's name. */
async function fromChain<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new ChainUnknown(stage, nameOf(err));
  }
}

/** A reserved row's link, which the schema requires of every row past `draft`. */
interface ReservedLink {
  bodyAddress: Address;
  identityOwner: Address;
  linkDeadline: number;
}

function reservedLink(row: LegalBodyRecord): ReservedLink {
  const { bodyAddress, identityOwner, linkDeadline } = row;
  if (bodyAddress === null || identityOwner === null || linkDeadline === null)
    throw new Error(`legal body ${row.legalBodyId} is reserved without its link`);
  return { bodyAddress, identityOwner, linkDeadline };
}

/**
 * Settle one reserved order from the chain. The caller holds the order's lock.
 *
 * Anything but a `reserved` row is `not_reserved`, with no chain call. Then the head is read, the
 * order's submissions listed (`s` is the newest), and the body's state asked at the head, for the
 * ROW's owner: after a legitimate transfer, a fresh owner read would call a good body foreign.
 * The first rule that matches decides:
 *
 *  1. `created`: the hash is the chain's. `createOutcome` on each recorded hash, newest first,
 *     the first `created` winning; with none, the factory's log, from the block the link was
 *     accepted at to the head of the first pass that searched (kept in a `note`, so the search
 *     does not grow). Found: `deployed`. Not found: `unknown`, the row as it was, with an error
 *     line (`legal_body_creation_unlocatable`).
 *  2. `foreign`: `lapsed` (`foreign_body`), at the head's time.
 *  3. The head's time is past the deadline: `lapsed` (`deadline_passed`). Safe on a lagging node
 *     too: the factory refuses a link after its deadline, and every later block is later still.
 *  4. No submission recorded: the re-submit step.
 *  5. `createOutcome(s)`: `created` is `deployed`, from that receipt; `reverted` is the re-submit
 *     step; `absent` goes on.
 *  6. The executor's MINED count is above `s.nonce`: `s`'s nonce is spent. `createOutcome(s)` once
 *     more: `created` is `deployed`; anything else means the bytes are dead: the re-submit step.
 *  7. The node's PENDING count is above `s.nonce`: `waiting`. The pool holds that nonce, with these
 *     bytes or another platform transaction, and nothing is sent over it.
 *  8. It equals `s.nonce`: the node lost these bytes, and their nonce is the next one. The same
 *     bytes are sent again (`rebroadcast`; a throw is `waiting`), never a fresh create, which the
 *     sender's floor could number above the free nonce.
 *  9. It is below `s.nonce`: a gap, which must be filled before `s` can be mined.
 *     (a) bytes recorded at the gap's nonce, by any order of this deployment in any state: those
 *         bytes are sent again (`rebroadcast`; a throw is `waiting`). They fill the nonce,
 *         whatever they do then;
 *     (b) otherwise the re-submit step, recording only a create signed AT the gap's nonce. If it
 *         sent nothing: `waiting`, with one error line naming both nonces.
 *
 * The re-submit step, in this order: three submissions already is `waiting`, with no chain call;
 * a revoked order, or a company no longer eligible, is `waiting`; the link is checked again with
 * the row's own link and signature (a throw is `unknown`; a refusal, or an acceptance for another
 * owner than the row's, is `waiting`, and rule 3 lapses the row at its deadline); then
 * `submitCreateFor`: `resubmitted`, or `waiting` for a create not recorded, a cap or a refusal.
 */
export async function resolveOrder(deps: LegalBodyOrderDeps, id: string): Promise<ResolveOutcome> {
  const row = deps.repo.findById(id);
  if (row === undefined || row.bindingState !== "reserved") return "not_reserved";

  let settled: Settled;
  try {
    settled = await settle(deps, row);
  } catch (err) {
    if (!(err instanceof ChainUnknown)) throw err;
    settled = { outcome: "unknown", stage: err.stage, errorName: err.errorName };
  }

  const { outcome } = settled;
  if (outcome !== "deployed" && outcome !== "lapsed" && outcome !== "not_reserved")
    moveSchedule(deps, row, outcome);
  logOnChange(id, settled);
  return outcome;
}

/** The rules, in order. A chain call that throws escapes as `ChainUnknown`. */
async function settle(deps: LegalBodyOrderDeps, row: LegalBodyRecord): Promise<Settled> {
  const id = row.legalBodyId;
  const { bodyAddress, identityOwner, linkDeadline } = reservedLink(row);
  const head = await fromChain("head", () => deps.chain.head());
  const subs = deps.repo.listDeploySubmissions(id);
  const state = await fromChain("created_state", () =>
    deps.chain.createdState({ bodyAddress, identityOwner, blockNumber: head.number }),
  );

  // 1.
  if (state === "created") return adoptCreation(deps, row, bodyAddress, subs, head.number);
  // 2.
  if (state === "foreign") return lapse(deps, id, "foreign_body", head.timestamp);
  // 3.
  if (head.timestamp > BigInt(linkDeadline))
    return lapse(deps, id, "deadline_passed", head.timestamp);
  // 4.
  const s = subs[0];
  if (s === undefined) return resubmit(deps, row, subs);

  // 5.
  const outcome = await fromChain("create_outcome", () =>
    deps.chain.createOutcome(s.txHash, { bodyAddress }),
  );
  if (outcome.status === "created") return deployed(deps, id, outcome.created, "receipt");
  if (outcome.status === "reverted") return resubmit(deps, row, subs);

  // 6.
  const mined = await fromChain("executor_nonce", () => deps.chain.executorNonce());
  if (mined > s.nonce) {
    const again = await fromChain("create_outcome", () =>
      deps.chain.createOutcome(s.txHash, { bodyAddress }),
    );
    if (again.status === "created") return deployed(deps, id, again.created, "receipt");
    return resubmit(deps, row, subs);
  }

  // 7.
  const pending = await fromChain("executor_pending_nonce", () =>
    deps.chain.executorPendingNonce(),
  );
  if (pending > s.nonce) return { outcome: "waiting", why: "nonce_in_pool" };

  // 8.
  if (pending === s.nonce) return rebroadcast(deps, s, "lost_bytes");

  // 9a.
  const filler = deps.repo.deploySubmissionAtNonce(deps.deployment, pending);
  if (filler !== undefined) return rebroadcast(deps, filler, "nonce_gap");
  // 9b.
  const filled = await resubmit(deps, row, subs, pending);
  if (filled.outcome === "resubmitted") return filled;
  return {
    outcome: "waiting",
    why: "executor_nonce_gap",
    facts: { pendingNonce: pending, submittedNonce: s.nonce },
  };
}

/**
 * Rule 1: the body exists and its creator is the row's owner. The hash is the one the chain names:
 * a recorded hash whose receipt reads `created` (newest first), or else the factory's log, from
 * the block the link was accepted at up to the head the first search stopped at, kept so that a
 * search repeated on later passes covers the same blocks and does not grow.
 */
async function adoptCreation(
  deps: LegalBodyOrderDeps,
  row: LegalBodyRecord,
  bodyAddress: Address,
  subs: DeploySubmission[],
  headNumber: bigint,
): Promise<Settled> {
  const id = row.legalBodyId;
  for (const sub of subs) {
    const outcome = await fromChain("create_outcome", () =>
      deps.chain.createOutcome(sub.txHash, { bodyAddress }),
    );
    if (outcome.status === "created") return deployed(deps, id, outcome.created, "receipt");
  }

  const fromBlock = deps.repo.acceptedAtBlock(id);
  // The reserve writes the block it observed the link at: a row without it was not reserved
  // through the repository, and its search would have no start.
  if (fromBlock === undefined)
    return { outcome: "unknown", stage: "find_creation", why: "no_accepted_block" };
  let toBlock = keptSearchEnd(deps, id);
  if (toBlock === undefined) {
    // A JSON number: the event writer redacts a string of nine digits or more.
    toBlock = Number(headNumber);
    deps.repo.recordEvent(id, "note", "system", null, { act: CREATION_SEARCH_NOTE, toBlock });
  }
  const end = toBlock;
  const found = await fromChain("find_creation", () =>
    deps.chain.findCreation({ bodyAddress, fromBlock: BigInt(fromBlock), toBlock: BigInt(end) }),
  );
  if (found === undefined)
    return { outcome: "unknown", stage: "find_creation", why: CREATION_NOT_FOUND };
  return deployed(deps, id, found, "factory_log");
}

/** The head the first search for this order's creation stopped at, from the system's note. */
function keptSearchEnd(deps: LegalBodyOrderDeps, id: string): number | undefined {
  for (const event of deps.repo.listEvents(id)) {
    if (event.kind !== "note" || event.actor !== "system") continue;
    const detail = event.detail as { act?: unknown; toBlock?: unknown } | null;
    if (detail === null || typeof detail !== "object" || detail.act !== CREATION_SEARCH_NOTE)
      continue;
    const { toBlock } = detail;
    if (typeof toBlock === "number" && Number.isSafeInteger(toBlock) && toBlock >= 0)
      return toBlock;
  }
  return undefined;
}

/** `reserved` → `deployed`, with the hash and the block time the chain gave, and the binding
 *  check scheduled from now, every minute; one transaction. A row moved meanwhile is left alone. */
function deployed(
  deps: LegalBodyOrderDeps,
  id: string,
  created: LegalBodyCreated,
  from: "receipt" | "factory_log",
): Settled {
  const moved = deps.transaction(() => {
    if (!deps.repo.markDeployed(id, { txHash: created.txHash, deployedAt: created.deployedAt }))
      return false;
    deps.repo.scheduleBindingCheck(id, now(deps), DEPLOYED_CHECK_INTERVAL_MS);
    return true;
  });
  return moved
    ? { outcome: "deployed", txHash: created.txHash, from }
    : { outcome: "not_reserved" };
}

/** `reserved` → `lapsed`, at the head's time; the lapse takes the row off the schedule. A row
 *  moved meanwhile is left alone. */
function lapse(
  deps: LegalBodyOrderDeps,
  id: string,
  reason: "foreign_body" | "deadline_passed",
  headTime: bigint,
): Settled {
  return deps.repo.lapse(id, { reason, blockTime: Number(headTime) })
    ? { outcome: "lapsed", reason }
    : { outcome: "not_reserved" };
}

/** Rules 8 and 9a: recorded bytes sent again. A throw is `waiting`: the bytes are the same
 *  transaction, and the next pass reads the counts again. */
async function rebroadcast(
  deps: LegalBodyOrderDeps,
  sub: DeploySubmission,
  why: "lost_bytes" | "nonce_gap",
): Promise<Settled> {
  try {
    await deps.chain.rebroadcastCreate(sub.rawTx);
  } catch (err) {
    return {
      outcome: "waiting",
      why: "rebroadcast_failed",
      facts: { nonce: sub.nonce, errorName: nameOf(err) },
    };
  }
  return { outcome: "rebroadcast", nonce: sub.nonce, why };
}

/** The re-submit step (see `resolveOrder`). With `onlyAtNonce`, only a create signed at that
 *  nonce is recorded and sent. */
async function resubmit(
  deps: LegalBodyOrderDeps,
  row: LegalBodyRecord,
  subs: DeploySubmission[],
  onlyAtNonce?: number,
): Promise<Settled> {
  const id = row.legalBodyId;
  if (subs.length >= MAX_CREATE_SUBMISSIONS_PER_ORDER)
    return { outcome: "waiting", why: "submission_cap" };
  if (deps.repo.isRevoked(id)) return { outcome: "waiting", why: "order_revoked" };
  if (!companyEligible(deps, row.companyId))
    return { outcome: "waiting", why: "company_not_eligible" };

  const { identityOwner } = reservedLink(row);
  const link = linkOfRow(row);
  const signature = row.linkSignature;
  const operatingAgreementHash = row.oaManifestHash;
  if (signature === null || operatingAgreementHash === null)
    throw new Error(`legal body ${id} is reserved without its signature or agreement`);
  const check = await fromChain("check_link", () =>
    checkLink(deps.chain, {
      link,
      signature,
      expected: {
        tenant: row.tenantId,
        operatingAgreementHash,
        amendmentDelay: BigInt(row.amendmentDelay),
      },
    }),
  );
  if (!check.ok) return { outcome: "waiting", why: "link_refused", facts: { code: check.code } };
  if (!isAddressEqual(check.identityOwner, identityOwner))
    return { outcome: "waiting", why: "link_for_another_owner" };

  let submitted: SubmitCreateResult;
  try {
    submitted = await submitCreateFor(deps, row, onlyAtNonce === undefined ? {} : { onlyAtNonce });
  } catch (err) {
    if (err instanceof CreateCapError)
      return { outcome: "waiting", why: "create_cap", facts: { cap: err.kind } };
    if (isCreateRefusal(err))
      return { outcome: "waiting", why: "create_refused", facts: { errorName: nameOf(err) } };
    throw new ChainUnknown("submit_create", nameOf(err));
  }
  if (submitted.status === "not_recorded") return { outcome: "waiting", why: "not_recorded" };
  return { outcome: "resubmitted", txHash: submitted.txHash, nonce: submitted.nonce };
}

/**
 * The chain's refusal of the create, before anything was sent: a revert with data (named or not:
 * the bytes, not the name, make it deterministic), or the gas ceiling. Anything else that
 * `submitCreate` throws (a platform fault, the fee cap, a node that could not answer) is not an
 * answer about the link.
 */
function isCreateRefusal(err: unknown): boolean {
  return err instanceof ContractRevertError || err instanceof LegalBodyGasTooHighError;
}

const now = (deps: LegalBodyOrderDeps) => (deps.now ?? Date.now)();

/**
 * The resolve schedule. The row's interval is the wait its NEXT move applies: the reserve sets the
 * first check at once with 30 seconds; each `waiting`, `unknown` or `rebroadcast` waits that long
 * and doubles it, up to ten minutes; `resubmitted` waits 30 seconds again and doubles from there.
 * While the link's deadline is still ahead, the check is never later than one second after it, so
 * the order lapses on time; once it has passed, that cap no longer applies, and a row that cannot
 * be settled keeps backing off instead of staying due.
 */
function moveSchedule(deps: LegalBodyOrderDeps, row: LegalBodyRecord, outcome: ResolveOutcome) {
  const nowMs = now(deps);
  const stored = row.bindingCheckIntervalMs ?? RESOLVE_FIRST_INTERVAL_MS;
  const wait =
    outcome === "resubmitted"
      ? RESOLVE_FIRST_INTERVAL_MS
      : Math.min(Math.max(stored, RESOLVE_FIRST_INTERVAL_MS), RESOLVE_MAX_INTERVAL_MS);
  let nextAt = nowMs + wait;
  if (row.linkDeadline !== null) {
    const cap = (row.linkDeadline + 1) * 1_000;
    if (nowMs < cap) nextAt = Math.min(nextAt, cap);
  }
  deps.repo.scheduleBindingCheck(
    row.legalBodyId,
    nextAt,
    Math.min(wait * 2, RESOLVE_MAX_INTERVAL_MS),
  );
}

// ── One line per row per outcome ────────────────────────────────────────────────────────────

/** The most rows whose last logged outcome is remembered; the oldest is forgotten first. */
const MAX_REMEMBERED_ROWS = 1_000;
/** Order id → the key of the last line written for it. */
const lastLogged = new Map<string, string>();

/** What makes two passes' lines the same line: the outcome, and what it is about. */
function logKey(settled: Settled): string {
  switch (settled.outcome) {
    case "resubmitted":
      return `resubmitted:${settled.txHash}`;
    case "rebroadcast":
      return `rebroadcast:${settled.why}:${settled.nonce}`;
    case "waiting":
      return settled.why === "executor_nonce_gap"
        ? `waiting:${settled.why}:${settled.facts?.pendingNonce}:${settled.facts?.submittedNonce}`
        : `waiting:${settled.why}`;
    case "unknown":
      return settled.why === CREATION_NOT_FOUND ? `unknown:${CREATION_NOT_FOUND}` : "unknown";
    default:
      return settled.outcome;
  }
}

/**
 * One line per row per outcome, never one per pass: a line is written when the row's outcome (and
 * what it is about) differs from the last one written for it. A settled row is forgotten. Lines
 * carry ids, nonces, hashes and error NAMES, never an error's message; a throw is a warning, not
 * a page. Two answers are error lines, in place of their usual line: a gap in the platform key's
 * nonces that a pass could not fill, and a body the chain created whose creation no search found.
 */
function logOnChange(id: string, settled: Settled): void {
  if (settled.outcome === "not_reserved") {
    lastLogged.delete(id);
    return;
  }
  const key = logKey(settled);
  if (lastLogged.get(id) !== key) writeLine(id, settled);
  lastLogged.delete(id);
  if (settled.outcome === "deployed" || settled.outcome === "lapsed") return;
  lastLogged.set(id, key);
  if (lastLogged.size > MAX_REMEMBERED_ROWS) {
    const oldest = lastLogged.keys().next().value;
    if (oldest !== undefined) lastLogged.delete(oldest);
  }
}

function writeLine(orderId: string, settled: Settled): void {
  switch (settled.outcome) {
    case "unknown":
      if (settled.why === CREATION_NOT_FOUND) {
        opsLog("legal_body_creation_unlocatable", {
          level: "error",
          orderId,
          stage: settled.stage,
        });
        return;
      }
      opsLog("legal_body_resolve", {
        level: "warn",
        orderId,
        outcome: "unknown",
        stage: settled.stage,
        ...(settled.errorName === undefined ? {} : { errorName: settled.errorName }),
        ...(settled.why === undefined ? {} : { why: settled.why }),
      });
      return;
    case "waiting":
      if (settled.why === "executor_nonce_gap") {
        opsLog("legal_body_executor_nonce_gap", { level: "error", orderId, ...settled.facts });
        return;
      }
      opsLog("legal_body_resolve", {
        level: "info",
        orderId,
        outcome: "waiting",
        why: settled.why,
        ...settled.facts,
      });
      return;
    case "deployed":
      opsLog("legal_body_resolve", {
        level: "info",
        orderId,
        outcome: "deployed",
        txHash: settled.txHash,
        from: settled.from,
      });
      return;
    case "lapsed":
      opsLog("legal_body_resolve", {
        level: "info",
        orderId,
        outcome: "lapsed",
        reason: settled.reason,
      });
      return;
    case "resubmitted":
      opsLog("legal_body_resolve", {
        level: "info",
        orderId,
        outcome: "resubmitted",
        txHash: settled.txHash,
        nonce: settled.nonce,
      });
      return;
    case "rebroadcast":
      opsLog("legal_body_resolve", {
        level: "info",
        orderId,
        outcome: "rebroadcast",
        why: settled.why,
        nonce: settled.nonce,
      });
      return;
    case "not_reserved":
      return;
  }
}
