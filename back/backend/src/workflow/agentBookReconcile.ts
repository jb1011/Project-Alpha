import type { Address, Hex } from "viem";
import type { AgentBookRegistrar } from "../adapters/worldid/agentBookRegistrar";
import type { AgentBookRepository, AgentBookRow } from "../persistence/agentBookRepository";
import type { WorldStore } from "../persistence/worldStore";

/**
 * The §6 reconciliation rules (design 2026-08-25 v3), contract state first:
 *   1. pending past expiry -> expired.
 *   2. a receipt with status 0 -> failed (fast path).
 *   3. getNextNonce(pocket) at `safe` moved past the row's nonce -> lookupHuman at `safe`:
 *      equal to our nullifier -> confirmed; different -> disputed (and cached, so the dials stop
 *      serving the stale id).
 *   4. nonce unmoved and the row older than STALE_AFTER_MS: re-broadcast the stored raw tx while
 *      the submitter's EVM nonce has not passed ours; once it has, the tx was replaced -> failed.
 * Transport failures change nothing: "could not tell" is never a state.
 */
export interface ReconcileDeps {
  repo: AgentBookRepository;
  registrar: Pick<
    AgentBookRegistrar,
    "getNextNonce" | "lookupHuman" | "broadcast" | "receiptStatus" | "submitterNonce"
  >;
  store: Pick<WorldStore, "cacheLookup">;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export const STALE_AFTER_MS = 10 * 60_000;

/** SQLite's `CURRENT_TIMESTAMP` is `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker, hence the
 *  appended `Z`. A timestamp we cannot parse makes the row STALE, never fresh: the stale branch
 *  re-broadcasts a transaction the chain would reject as a duplicate, while a wrongly-fresh row
 *  would sit in `submitted` forever with nobody ever asking about it again. */
const ageMs = (row: AgentBookRow, now: number): number => {
  const stamped = Date.parse(`${row.updatedAt}Z`);
  return Number.isNaN(stamped) ? Number.POSITIVE_INFINITY : now - stamped;
};

/**
 * Is the on-chain vouch ours?
 *
 * NUMERICALLY, never as strings: the submit route stores the nullifier as World handed it over
 * (zero-padded, `0x0badf00d`) while `lookupHuman` returns viem's minimal hex for the same number
 * (`0xbadf00d`). A stored value that is not a parseable number cannot be matched to anything on
 * chain, so it is simply not ours — which routes the row to `disputed`, the branch that shows a
 * human the id the contract actually holds.
 */
function sameHuman(human: string | null, nullifier: string | null): boolean {
  if (human === null || nullifier === null) return false;
  try {
    return BigInt(human) === BigInt(nullifier);
  } catch {
    return false;
  }
}

export async function reconcileRow(row: AgentBookRow, deps: ReconcileDeps): Promise<AgentBookRow> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const reload = () => deps.repo.findBySession(row.sessionId) ?? row;

  if (row.status === "pending") {
    if (row.expiresAt < now()) deps.repo.transition(row.sessionId, "pending", "expired");
    return reload();
  }
  if (row.status !== "submitted") return row;

  try {
    if (row.txHash) {
      const receipt = await deps.registrar.receiptStatus(row.txHash as Hex);
      if (receipt === "reverted") {
        deps.repo.transition(row.sessionId, "submitted", "failed", { errorCode: "reverted" });
        log("agentbook_failed", { entity: row.entityKey, reason: "reverted" });
        return reload();
      }
    }
    const agent = row.address as Address;
    const nonce = await deps.registrar.getNextNonce(agent, "safe");
    if (nonce > BigInt(row.nonce)) {
      const human = await deps.registrar.lookupHuman(agent, "safe");
      if (sameHuman(human, row.nullifier)) {
        // No patch: `transition` to `confirmed` clears the last-attempt error code in SQL.
        deps.repo.transition(row.sessionId, "submitted", "confirmed");
        log("agentbook_confirmed", { entity: row.entityKey });
      } else {
        deps.repo.transition(row.sessionId, "submitted", "disputed");
        deps.store.cacheLookup(agent, human, now());
        log("agentbook_disputed", { entity: row.entityKey });
      }
      return reload();
    }
    if (ageMs(row, now()) < STALE_AFTER_MS) return row;
    const chainNonce = await deps.registrar.submitterNonce();
    if (row.submitterNonce !== null && chainNonce > row.submitterNonce) {
      deps.repo.transition(row.sessionId, "submitted", "failed", { errorCode: "replaced" });
      log("agentbook_failed", { entity: row.entityKey, reason: "replaced" });
      return reload();
    }
    if (row.rawTx) {
      const hash = await deps.registrar.broadcast(row.rawTx as Hex);
      deps.repo.setTxHash(row.sessionId, hash);
      log("agentbook_rebroadcast", { entity: row.entityKey });
    }
    return reload();
  } catch (e) {
    // The error NAME and nothing else: an RPC's prose can carry the calldata, and the calldata
    // carries the proof.
    log("agentbook_reconcile_unavailable", {
      entity: row.entityKey,
      errorName: e instanceof Error ? e.name : "unknown",
    });
    return row;
  }
}

export async function reconcileAgentBook(
  deps: ReconcileDeps,
): Promise<{ checked: number; changed: number }> {
  let checked = 0;
  let changed = 0;
  for (const row of deps.repo.listInFlight()) {
    checked += 1;
    const after = await reconcileRow(row, deps);
    if (after.status !== row.status || after.txHash !== row.txHash) changed += 1;
  }
  return { checked, changed };
}
