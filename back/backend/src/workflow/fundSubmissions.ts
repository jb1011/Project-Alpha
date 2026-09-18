import type { ArcAdapter } from "../adapters/arc/arcAdapter";
import { PriorTransferUnconfirmedError } from "../errors";
import { opsLog } from "../observability/opsLog";
import type { EntityRepository } from "../persistence/entityRepository";
import type { EntityRecord, Hex } from "../types";

/**
 * THE LEDGER OF BROADCAST TREASURY TRANSFERS — three rows, one question: did the money move?
 *
 * A treasury top-up is two facts, not one, and the gap between them is where platform funds get
 * sent twice. This module owns both the vocabulary and the resolution:
 *
 *  - `submitted` — the transfer was BROADCAST and its hash is known. Written before anything waits
 *    for a receipt, in the same transaction as the S5 outflow record. From this moment the money
 *    is presumed gone.
 *  - `funded` — the receipt says it succeeded.
 *  - `reverted` — the receipt says it failed. The money did not move.
 *
 * An UNRESOLVED SUBMISSION is a `submitted` row with no `funded` or `reverted` row carrying the
 * same hash. Keyed by HASH, never by recency — that distinction is the whole of finding N1
 * (2026-09-18). The first design read "the last `fundTreasury` event", and the runner's own
 * `failed` row, appended a moment later, made every submission look settled: the reconcile never
 * ran, and the first Retry moved the same USDC a second time. Rows may be appended after a
 * submission by anyone, for any reason; only a settlement of the same hash closes it.
 *
 * Two callers resolve submissions, and they must behave identically, which is why the logic is
 * here rather than in either of them: the saga's step 7 (before it considers sending anything) and
 * the boot sweep (so a process that died inside a receipt wait heals with no user retry at all).
 */

/** What a resolution pass decided about one entity's outstanding transfers. */
export type Resolution =
  /** A broadcast landed: finalise from this hash, send nothing. */
  | { kind: "funded"; txHash: Hex; amount: bigint | undefined }
  /** Everything outstanding reverted (or there was nothing outstanding): a new send is correct. */
  | { kind: "clear" }
  /** At least one transfer is still unreadable: neither finalise nor send. */
  | { kind: "unresolved"; txHash: Hex };

/**
 * Ask the chain about every unresolved submission of one entity and decide what may happen next.
 *
 * Records a `reverted` event for each settled-and-failed transfer as it goes: that is durable
 * progress, and it is what lets a later attempt stop asking about it.
 *
 * ⚠ ORDER OF PRECEDENCE when an entity somehow has several outstanding (a restart can leave one;
 * two would need a second process, which today's single-VPS deployment does not have):
 * `unresolved` beats `funded` beats `clear`. An unreadable receipt means we cannot say what this
 * entity's funding totals, and the only safe answer to "should I send more?" is no.
 */
export async function resolveSubmissions(
  deps: { repo: EntityRepository; arc: Pick<ArcAdapter, "receiptOutcome"> },
  key: string,
): Promise<Resolution> {
  let landed: { txHash: Hex; amount: bigint | undefined } | undefined;
  for (const row of deps.repo.listUnresolvedFundSubmissions(key)) {
    const txHash = row.txHash as Hex;
    const outcome = await deps.arc.receiptOutcome(txHash);
    if (outcome === "unknown") return { kind: "unresolved", txHash };
    if (outcome === "success") {
      landed ??= { txHash, amount: parseAmount(row.amount) };
      continue;
    }
    deps.repo.recordEvent(key, "fundTreasury", "reverted", txHash, JSON.stringify({ outcome }));
  }
  return landed ? { kind: "funded", ...landed } : { kind: "clear" };
}

/**
 * Record a broadcast: the `submitted` row and the S5 outflow, atomically.
 *
 * ONE transaction on purpose. They are two statements about the same event — "a transfer with this
 * hash is in flight" and "the platform has committed this much" — and a crash between them leaves
 * either a transfer nobody will reconcile or a meter reading with nothing behind it.
 *
 * The outflow is recorded HERE, before the receipt is known, rather than on success. A rolling
 * brake that only counts confirmed transfers fails OPEN precisely when the chain is unhealthy,
 * which is when it is most needed.
 */
export function recordSubmission(
  deps: {
    repo: EntityRepository;
    outflows?: { record(path: "fund_treasury", amountAtomic: bigint, ref: string | null): void };
  },
  key: string,
  txHash: Hex,
  amount: bigint,
): void {
  deps.repo.transaction(() => {
    deps.repo.recordEvent(
      key,
      "fundTreasury",
      "submitted",
      txHash,
      JSON.stringify({ amount: amount.toString() }),
    );
    deps.outflows?.record("fund_treasury", amount, txHash);
  });
}

/**
 * Settle an entity as funded from a transfer that is known to have landed.
 *
 * `error: null` explicitly, not by inheritance: the row may be carrying the "sent but unconfirmed"
 * sentence from the attempt that broadcast this very transfer, and leaving it there would show a
 * failure beside a treasury that is full.
 */
export function finaliseFunded(
  repo: EntityRepository,
  rec: EntityRecord,
  txHash: Hex,
  amount: bigint,
  reconciled: boolean,
): EntityRecord {
  const funded: EntityRecord = { ...rec, status: "funded", fundTxHash: txHash, error: null };
  repo.transaction(() => {
    repo.upsert(funded);
    repo.recordEvent(
      rec.idempotencyKey,
      "fundTreasury",
      "funded",
      txHash,
      // `amount` is what MOVED, which on a reconcile is the earlier attempt's figure rather than
      // this call's — `sumFundedByTenant` reads this field, so a quota that counted the requested
      // amount instead of the sent one would be fiction.
      JSON.stringify({ amount: amount.toString(), ...(reconciled ? { reconciled } : {}) }),
    );
  });
  return funded;
}

/**
 * THE BOOT SWEEP (gate N2): resolve every outstanding transfer in the deployment, once.
 *
 * Without it a process that died inside a receipt wait leaves a `submitted` row that nothing will
 * ever look at — `listInFlight` selects only the pre-`bound` statuses, so `reconcileInFlight` does
 * not see a mid-fund entity — and the entity stays stuck until a human retries. With it, the state
 * heals by itself: the transfer that landed becomes `funded` before anyone asks.
 *
 * Called AFTER `serve()` in `api/main.ts`, beside the AgentBook reconcile and for the same reason:
 * each unresolved row costs a chain round trip, and a slow RPC must never keep the socket from
 * opening. It is a no-op — and makes no call at all — when nothing is outstanding, which is the
 * normal case.
 */
export async function sweepUnresolvedFunding(deps: {
  repo: EntityRepository;
  arc: Pick<ArcAdapter, "receiptOutcome">;
  log?: typeof opsLog;
}): Promise<{ checked: number; finalised: number; reverted: number; unresolved: number }> {
  const log = deps.log ?? opsLog;
  const rows = deps.repo.listUnresolvedFundSubmissions();
  const out = { checked: rows.length, finalised: 0, reverted: 0, unresolved: 0 };
  for (const row of rows) {
    const txHash = row.txHash as Hex;
    const rec = deps.repo.findByIdempotencyKey(row.idempotencyKey);
    if (!rec) continue;
    const outcome = await deps.arc.receiptOutcome(txHash);
    if (outcome === "success") {
      finaliseFunded(deps.repo, rec, txHash, parseAmount(row.amount) ?? 0n, true);
      out.finalised++;
    } else if (outcome === "reverted") {
      deps.repo.recordEvent(
        row.idempotencyKey,
        "fundTreasury",
        "reverted",
        txHash,
        JSON.stringify({ outcome }),
      );
      out.reverted++;
    } else {
      // Still unreadable. Left exactly as it is — and still counted against the tenant's cap,
      // because the money is still presumed gone.
      out.unresolved++;
    }
    log("fund_submission_swept", { entity: row.idempotencyKey, txHash, outcome });
  }
  return out;
}

/** An entity that must not be funded again yet, as the refusal the caller surfaces. */
export function priorTransferError(txHash: Hex): PriorTransferUnconfirmedError {
  return new PriorTransferUnconfirmedError(txHash);
}

function parseAmount(amount: string | null): bigint | undefined {
  if (amount === null) return undefined;
  try {
    return BigInt(amount);
  } catch {
    // A detail we cannot parse must not crash a reconciliation; the caller falls back to the
    // amount it was asked for.
    return undefined;
  }
}
