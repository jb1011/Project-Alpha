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

/** One transfer that is known to have landed, and the amount it moved. */
export type Landed = { txHash: Hex; amount: bigint | undefined };

/**
 * What a resolution pass found. Both halves can be non-empty at once, deliberately: a landed
 * transfer is a fact worth recording even while a sibling is still unreadable (gate N7 — a pass
 * adopts EVERY landed submission, because adopting one and leaving the other under-counts the
 * tenant's quota by a whole transfer).
 */
export type Resolution = {
  /** Every submission confirmed mined in this pass, oldest first. */
  landed: Landed[];
  /** Set when something is still neither mined nor settled: no new transfer may be sent. */
  unresolved?: Hex;
};

/**
 * Ask the chain about every unresolved submission of one entity and decide what may happen next.
 *
 * FIVE rules. They are the AgentBook reconciler's rules (`workflow/agentBookReconcile.ts`) applied
 * to money, and the first one is the one whose absence cost a second transfer (gate N8):
 *
 *  1. the receipt READ BROKE (a throttled RPC, a dead endpoint) → we know NOTHING. Refuse, send
 *     nothing, re-broadcast nothing, record nothing. `receiptOutcome` distinguishes this from a
 *     definitive absence by type, and rethrows; catching it here would be guessing.
 *  2. receipt says SUCCESS  → landed; adopt it, send nothing.
 *  3. receipt says REVERTED → record `reverted`; it moved nothing, so a new send is correct.
 *  4. DEFINITIVELY ABSENT, **and** the platform account's MINED nonce has moved past this
 *     transaction's nonce, **and** the submission is older than {STALE_AFTER_MS} → ask for the
 *     receipt ONE more time (it may have mined in the gap between the two reads — the registrar's
 *     rule, and skipping it turns a success into a failure), and if it is still definitively
 *     absent, record `dropped`. Terminal: the nonce is spent by something else, these bytes can
 *     never mine, and a new send is allowed. Its S5 entry stays, conservatively.
 *  5. anything else absent → the transaction is still pending, or the node never accepted it.
 *     Re-broadcast the SAME signed bytes (idempotent; at worst the node already has them) and stay
 *     unresolved. ⚠ Never re-SIGN here: a new signature is a new nonce, which is how one transfer
 *     becomes two.
 *
 * ALL THREE conditions of rule 4 are load-bearing. The nonce alone is satisfied by our own
 * transaction mining; the second read alone is satisfied by a throttle answering twice; and
 * without the age gate the rule ran seconds after a broadcast, so a founder pressing Retry at 90
 * seconds could declare a pending transfer dead.
 *
 * A row from before the raw-tx design (no `rawTx`/`nonce`) simply skips rules 4 and 5 and stays
 * unresolved — the old, safe behaviour.
 */
export async function resolveSubmissions(
  deps: {
    repo: EntityRepository;
    arc: Pick<ArcAdapter, "receiptOutcome" | "platformNonce" | "sendRawFundTreasury">;
    now?: () => number;
    log?: typeof opsLog;
  },
  key: string,
): Promise<Resolution> {
  const log = deps.log ?? opsLog;
  const now = deps.now ?? Date.now;
  const out: Resolution = { landed: [] };
  for (const row of deps.repo.listUnresolvedFundSubmissions(key)) {
    const txHash = row.txHash as Hex;
    const amount = parseAmount(row.amount);
    // Rule 1 lives in the ABSENCE of a catch: `receiptOutcome` throws when the read broke, and that
    // throw leaves this entity alone — no verdict, no re-broadcast, no new send. The saga turns it
    // into the unconfirmed sentence, which is the honest answer to "did my money move?".
    const outcome = await deps.arc.receiptOutcome(txHash);
    if (outcome === "success") {
      out.landed.push({ txHash, amount });
      continue;
    }
    if (outcome === "reverted") {
      deps.repo.recordFundResolutionOnce(key, txHash, "reverted", JSON.stringify({ outcome }));
      continue;
    }
    // ── Definitively absent. Pending, or gone for good?
    if (row.nonce !== null && olderThan(row.createdAt, STALE_AFTER_MS, now())) {
      const chainNonce = await deps.arc.platformNonce();
      if (chainNonce > row.nonce) {
        // The chain moved past our nonce. It could have moved past it by mining OUR transaction,
        // in the window between the receipt read above and this one — so ask again before calling
        // a success a failure. A broken read here throws, exactly as in rule 1.
        if ((await deps.arc.receiptOutcome(txHash)) === "success") {
          out.landed.push({ txHash, amount });
          continue;
        }
        deps.repo.recordFundResolutionOnce(
          key,
          txHash,
          "dropped",
          JSON.stringify({ nonce: row.nonce, chainNonce }),
        );
        log("fund_submission_dropped", { entity: key, txHash, nonce: row.nonce, chainNonce });
        continue;
      }
    }
    if (row.rawTx) {
      // Rule 5. A failure here changes nothing — the submission is already recorded and the next
      // pass will try again — so it must not turn into the caller's error.
      try {
        await deps.arc.sendRawFundTreasury(row.rawTx as Hex);
        log("fund_submission_rebroadcast", { entity: key, txHash });
      } catch {
        log("fund_submission_rebroadcast_failed", { entity: key, txHash });
      }
    }
    out.unresolved ??= txHash;
  }
  return out;
}

/**
 * How long a submission is left alone before the nonce rule may call it dropped.
 *
 * The reconciler's `STALE_AFTER_MS`, the same number for the same reason: below it, "no receipt"
 * is the ordinary condition of a transaction that is simply waiting to be mined.
 */
export const STALE_AFTER_MS = 10 * 60_000;

/** Is a `submitted` row older than `ms`? Unparseable (or missing) timestamps read as YOUNG, which
 *  is the safe direction: an unknown age must never authorise a second transfer. */
function olderThan(createdAt: string | null, ms: number, nowMs: number): boolean {
  if (!createdAt) return false;
  // SQLite's CURRENT_TIMESTAMP is UTC, spelled "YYYY-MM-DD HH:MM:SS" with no zone marker.
  const at = Date.parse(`${createdAt.replace(" ", "T")}Z`);
  return Number.isFinite(at) && nowMs - at > ms;
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
  signed: { txHash: Hex; rawTx: Hex; nonce: number },
  amount: bigint,
): void {
  deps.repo.transaction(() => {
    deps.repo.recordEvent(
      key,
      "fundTreasury",
      "submitted",
      signed.txHash,
      // `rawTx` is what makes a re-broadcast the SAME transaction rather than a second one, and
      // `nonce` is the only way to tell a pending transfer from a dropped one. Both are public
      // facts about a transaction we are about to put on a public chain.
      JSON.stringify({ amount: amount.toString(), rawTx: signed.rawTx, nonce: signed.nonce }),
    );
    deps.outflows?.record("fund_treasury", amount, signed.txHash);
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
    // ⚠ IDEMPOTENT PER HASH, and the guard is IN the INSERT (gates N5 and N10). The boot sweep is awaited
    // after `serve()`, so it walks its queue while `POST /entities/:id/fund` is being served: the
    // sweep and a live saga could both finalise the same transfer, and the measured result was two
    // `funded` rows for one transfer with the tenant's lifetime cap charged twice. A check-then-
    // insert in TypeScript would only narrow that window; `recordFundedOnce` is one statement, so
    // there is no window at all.
    //
    // `amount` is what MOVED, which on a reconcile is the earlier attempt's figure rather than
    // this call's — `sumFundedByTenant` reads this field, so a quota that counted the requested
    // amount instead of the sent one would be fiction.
    repo.recordFundResolutionOnce(
      rec.idempotencyKey,
      txHash,
      "funded",
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
  arc: Pick<ArcAdapter, "receiptOutcome" | "platformNonce" | "sendRawFundTreasury">;
  /**
   * Is a saga already working on this entity? The runner's per-entity `inFlight` lock (gate N5).
   *
   * The sweep runs after `serve()`, so the socket is open and a fund can arrive at any moment
   * during it. Skipping a busy entity is what keeps the sweep from resolving a submission the saga
   * is in the middle of confirming; a skipped row is not lost, it is simply someone else's job
   * right now, and the next boot (or the next attempt) sees it.
   */
  busy?: (key: string) => boolean;
  /** Injectable clock for the age gate — the sweep applies the same three conditions the saga
   *  does, and it runs unattended at boot, when an unhealthy RPC is most likely. */
  now?: () => number;
  log?: typeof opsLog;
}): Promise<{
  checked: number;
  finalised: number;
  reverted: number;
  dropped: number;
  unresolved: number;
  skipped: number;
}> {
  const log = deps.log ?? opsLog;
  const rows = deps.repo.listUnresolvedFundSubmissions();
  const out = {
    checked: rows.length,
    finalised: 0,
    reverted: 0,
    dropped: 0,
    unresolved: 0,
    skipped: 0,
  };
  // One pass per ENTITY, not per row: `resolveSubmissions` already adopts every landed submission
  // an entity has (gate N7), and asking about the same entity twice would re-read receipts that
  // the first pass just settled.
  for (const key of [...new Set(rows.map((r) => r.idempotencyKey))]) {
    if (deps.busy?.(key)) {
      out.skipped += rows.filter((r) => r.idempotencyKey === key).length;
      log("fund_sweep_skipped_busy", { entity: key });
      continue;
    }
    const before = deps.repo.listUnresolvedFundSubmissions(key).length;
    let resolution: Resolution;
    try {
      resolution = await resolveSubmissions(deps, key);
    } catch {
      // A broken receipt read (gate N8). Nothing is concluded and nothing is written; the row
      // stays outstanding for the next boot or the next attempt. One unhealthy read must not end
      // the sweep either — the other entities still deserve theirs.
      out.unresolved += before;
      log("fund_sweep_unreadable", { entity: key });
      continue;
    }
    for (const landed of resolution.landed) {
      const rec = deps.repo.findByIdempotencyKey(key);
      if (!rec) continue;
      finaliseFunded(deps.repo, rec, landed.txHash, landed.amount ?? 0n, true);
      out.finalised++;
    }
    // Whatever is still open after the pass was neither mined nor settled; the rest were closed as
    // `reverted` or `dropped`, and those two are told apart by re-reading the rows.
    const stillOpen = deps.repo.listUnresolvedFundSubmissions(key).length;
    out.unresolved += stillOpen;
    const settled = before - out.finalised - stillOpen;
    if (settled > 0) {
      const closed = deps.repo
        .listEvents(key)
        .filter(
          (e) => e.step === "fundTreasury" && (e.status === "reverted" || e.status === "dropped"),
        )
        .slice(-settled);
      out.reverted += closed.filter((e) => e.status === "reverted").length;
      out.dropped += closed.filter((e) => e.status === "dropped").length;
    }
    log("fund_submission_swept", { entity: key, landed: resolution.landed.length });
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
