import type Database from "better-sqlite3";
import type { Hex } from "../types";

/**
 * OA bundle-manifest anchor cycles (design 2026-08-19 §3/§7). One row PER MANIFEST VERSION —
 * deliberately NOT keyed like `bridge_legs` on (entity, step): a bridge has exactly one of each
 * leg, whereas an entity accumulates v1, v2, v3… and a superseding version must be able to
 * coexist with the one it supersedes (audit H1).
 *
 * Same CAS discipline as `formationRepository`: every state move is
 * `UPDATE … WHERE state = ?` and reports whether this caller won it, because the sweeper is an
 * unattended periodic driver of MANAGER transactions and "executed exactly once" cannot rest on a
 * single-process mutex. The monotonic rules that live above this repo (schedule/execute only when
 * `version > entities.oa_manifest_version`; a vetoed row parks the WHOLE pipeline) are what stop
 * a stale manifest from landing after a newer one — the repo just refuses to lose a race.
 *
 * ── THE PROJECTION (review F2) ──────────────────────────────────────────────────────────────
 *
 * `oa_anchors` is the TRUTH about an entity's anchor history; the five `entities.oa_*` columns are
 * a PROJECTION of it that the monitor's compromise rule, the guardian card and the tenant view
 * read. They used to be written by six different call sites in the anchor loop, each deciding for
 * itself what "pending" meant — and one of them (a supersede with no successor) simply forgot,
 * leaving the entity advertising a pending amendment that no longer existed. So the projection is
 * RECOMPUTED FROM THE ROWS, by this module and nothing else, inside the same transaction as the
 * CAS that changed them: `transitionAndProject` and `claimVersionAndProject` are the only writers
 * of those columns anywhere in the codebase.
 */
export type OaAnchorState =
  | "pending"
  | "scheduled"
  | "executed"
  | "vetoed"
  | "superseded"
  | "failed";

/** Cycles still in flight: the single-pending rule's domain, and the sweeper's due-work set. */
export const OPEN_STATES = ["pending", "scheduled"] as const;

/**
 * Cycles that park the entity's WHOLE pipeline until a human acts (design §7, audit H4).
 *
 * `vetoed` ends on chain via `liftVeto` or by an operator acknowledgement; `failed` only by the
 * acknowledgement. Exported beside the state union because three modules ask "is this a hold?" and
 * a fourth list of the same two strings is a fourth chance to disagree.
 */
export const HOLD_STATES = ["vetoed", "failed"] as const;

/** `'a','b'` — states interpolated into a prepared statement. Constants, never user input. */
const sqlStates = (states: readonly OaAnchorState[]): string =>
  states.map((s) => `'${s}'`).join(",");

export interface OaAnchorRecord {
  entityKey: string;
  version: number;
  manifestHash: Hex;
  state: OaAnchorState;
  scheduleTx: Hex | null;
  executeTx: Hex | null;
  /** Unix seconds the timelock lets the amendment execute; feeds the guardian veto countdown. */
  executableAt: number | null;
  attempt: number;
  error: string | null;
  /** Epoch ms before which a parked cycle is not retried, and the interval that produced it.
   *  Written when a cycle is parked WITHOUT burning an attempt — a transport failure on a
   *  broadcast or a receipt read says nothing about whether the amendment is going through, so it
   *  must never count toward abandonment, and the interval is then the row's only memory of how
   *  many times this has happened (the `parkFormationStep` rule, applied to anchors). */
  nextRetryAt: number | null;
  retryIntervalMs: number | null;
  /** SQLite UTC timestamp of the last write. The sweeper compares it against the entity's
   *  formation-step timestamps to answer "could the facts have moved since this cycle last did?"
   *  without reading (and re-hashing) a single manifest — see `formationSweeper` (F6). */
  updatedAt: string;
}

/** What a transition may write alongside the state move. */
export interface OaAnchorFields {
  scheduleTx?: Hex;
  executeTx?: Hex;
  /**
   * CLEAR the tx column rather than leaving it (review F1).
   *
   * The tx columns are COALESCEd so persisting one leg's broadcast never wipes the other's — a
   * crash resumes by ADOPTING a persisted tx rather than re-broadcasting. But a cycle RESUMED from
   * a hold has a `schedule_tx` that describes a schedule the chain no longer holds (the guardian's
   * cancel deleted it), and COALESCE made that stale hash immortal: the schedule leg read
   * `scheduledAt == 0`, found the old mined tx, and parked "refusing to re-broadcast blindly"
   * forever. An explicit sentinel, not a magic value, so "leave it alone" and "there is no tx any
   * more" stay different statements.
   */
  clearScheduleTx?: boolean;
  clearExecuteTx?: boolean;
  executableAt?: number;
  error?: string | null;
  nextRetryAt?: number;
  retryIntervalMs?: number;
}

interface Row {
  entity_key: string;
  version: number;
  manifest_hash: string;
  state: OaAnchorState;
  schedule_tx: string | null;
  execute_tx: string | null;
  executable_at: number | null;
  attempt: number;
  error: string | null;
  next_retry_at: number | null;
  retry_interval_ms: number | null;
  updated_at: string;
}

function toRecord(r: Row): OaAnchorRecord {
  return {
    entityKey: r.entity_key,
    version: r.version,
    manifestHash: r.manifest_hash as Hex,
    state: r.state,
    scheduleTx: (r.schedule_tx as Hex) ?? null,
    executeTx: (r.execute_tx as Hex) ?? null,
    executableAt: r.executable_at,
    attempt: r.attempt,
    error: r.error,
    nextRetryAt: r.next_retry_at,
    retryIntervalMs: r.retry_interval_ms,
    updatedAt: r.updated_at,
  };
}

/** The slice of the anchor store its callers use. An interface so the onboarding saga can take
 *  it as a seam (tests fake it; production passes the sqlite one over the SAME db handle, which
 *  is what lets the anchor row commit inside the entity row's transaction). */
export interface OaAnchorRepository {
  claimVersion(entityKey: string, version: number, manifestHash: Hex): boolean;
  /** `claimVersion` + the projection recompute, in ONE transaction. The only way to open a cycle
   *  and have the entity's pending pair describe it. */
  claimVersionAndProject(entityKey: string, version: number, manifestHash: Hex): boolean;
  find(entityKey: string, version: number): OaAnchorRecord | undefined;
  versionsOf(entityKey: string): OaAnchorRecord[];
  findPending(entityKey: string): OaAnchorRecord | undefined;
  listByState(state: OaAnchorState): OaAnchorRecord[];
  /** Every cycle still in flight anywhere in the deployment — the sweeper's due-work query. ONE
   *  statement rather than two `listByState` calls, so a cycle that moves between the two states
   *  mid-tick cannot be seen twice or missed entirely. */
  listOpen(): OaAnchorRecord[];
  /**
   * The anchor sweeper's INCREMENTAL due-work set (review F6).
   *
   * It used to be "every entity with a confirmed formation step", which is every entity that has
   * ever been formed — a set that only grows, and each member cost a manifest read, a keccak and a
   * canonical re-serialization on every tick, forever, to conclude nothing had changed.
   *
   * Three things are due, and nothing else is:
   *  - an OPEN cycle (something is pending or scheduled and the chain may have moved);
   *  - a HELD cycle (a veto may have been lifted, or a hold acknowledged);
   *  - an entity whose facts moved since its last anchor write — a confirmed formation step
   *    whose `updated_at` is at or after the newest `oa_anchors` write for that entity, or an
   *    entity with no anchor rows at all.
   *
   * `>=` rather than `>` deliberately: both columns are `CURRENT_TIMESTAMP`, i.e. one-SECOND
   * resolution, and the fast path confirms a step and opens its version inside the same second.
   * Strict `>` would drop exactly that entity from the set forever. The cost of `>=` is that a
   * same-second entity stays a candidate — which the cheap gates in `advanceAnchor` then dismiss
   * without touching a file.
   */
  listDueEntityKeys(limit: number): string[];
  transition(
    entityKey: string,
    version: number,
    from: OaAnchorState,
    to: OaAnchorState,
    fields?: OaAnchorFields,
  ): boolean;
  /**
   * CAS the state AND recompute the entity's projection columns, in ONE transaction.
   *
   * The ONLY writer of `oa_manifest_pending_hash`, `oa_manifest_pending_version`,
   * `oa_amendment_executable_at`, `oa_manifest_anchored_hash`, `oa_manifest_version` and the
   * `oa_hash` mirror. See the module doc: six call sites each deciding what "pending" meant is how
   * a supersede with no successor left an entity advertising an amendment that did not exist.
   */
  transitionAndProject(
    entityKey: string,
    version: number,
    from: OaAnchorState,
    to: OaAnchorState,
    fields?: OaAnchorFields,
  ): boolean;
  bumpAttempt(entityKey: string, version: number, from: OaAnchorState): number | undefined;
  /**
   * Park a cycle IN PLACE and burn an attempt, returning the new count (review F5).
   *
   * For a DECODED CONTRACT REVERT and nothing else. A revert is a verdict — `NotManager`,
   * `NotActive`, a custom error — and retrying it forever is how a broken deployment stays
   * silently broken. A transport failure is the opposite (it says nothing about whether the
   * amendment is going through) and takes `transition`'s no-burn park instead.
   */
  parkWithAttempt(
    entityKey: string,
    version: number,
    state: OaAnchorState,
    fields: { error: string; nextRetryAt: number; retryIntervalMs: number },
  ): number | undefined;
  /**
   * The OPERATOR ACK that ends a HOLD (design §7, audit H4).
   *
   * Two cycle states park the entity's WHOLE anchor pipeline rather than just themselves: a
   * guardian `vetoed` (a stop sign, not a per-hash speed bump a re-versioning backend routes
   * around) and a `failed` one, which today means the scheduled manifest no longer re-hashes to
   * its anchor — a fact a human has to look at, because the amendment is still live on chain and
   * only the guardian can stop it.
   *
   * A veto can also end on chain, via `liftVeto`, which the loop observes. This is the other exit:
   * a human deciding the version is dead and the pipeline should move on. Deliberately a state
   * move rather than a flag column — `superseded` already MEANS "this cycle will never be
   * anchored", and the acknowledgement is exactly that statement.
   */
  acknowledgeHold(entityKey: string, version: number): boolean;
}

export class SqliteOaAnchorRepository implements OaAnchorRepository {
  /** Prepared ONCE — same reason as the formation repo: the anchor sweeper runs these on a timer
   *  for the life of the process, and better-sqlite3 caches nothing on our behalf. The tables
   *  exist by construction time (`migrate(db)` runs first at every composition root). */
  private readonly stmts;
  /** better-sqlite3 wraps a nested call in a SAVEPOINT, so these compose with the entity repo's
   *  own transaction — which is what lets a projection commit with the row that caused it. */
  private readonly tx: <T>(fn: () => T) => T;

  constructor(db: Database.Database) {
    this.stmts = {
      claimVersion: db.prepare(
        `INSERT INTO oa_anchors (entity_key, version, manifest_hash, state)
         VALUES (?, ?, ?, 'pending')
         ON CONFLICT(entity_key, version) DO NOTHING`,
      ),
      find: db.prepare("SELECT * FROM oa_anchors WHERE entity_key = ? AND version = ?"),
      versionsOf: db.prepare("SELECT * FROM oa_anchors WHERE entity_key = ? ORDER BY version"),
      findPending: db.prepare(
        `SELECT * FROM oa_anchors
          WHERE entity_key = ? AND state IN (${sqlStates(OPEN_STATES)})
          ORDER BY version DESC LIMIT 1`,
      ),
      listByState: db.prepare(
        "SELECT * FROM oa_anchors WHERE state = ? ORDER BY entity_key, version",
      ),
      listOpen: db.prepare(
        `SELECT * FROM oa_anchors WHERE state IN (${sqlStates(OPEN_STATES)})
          ORDER BY entity_key, version`,
      ),
      // See `listDueEntityKeys`. One statement, so an entity that moves between the two halves
      // mid-tick cannot be seen twice or missed entirely.
      listDue: db.prepare(
        `SELECT k FROM (
           SELECT DISTINCT entity_key AS k FROM oa_anchors
            WHERE state IN (${sqlStates([...OPEN_STATES, ...HOLD_STATES])})
           UNION
           SELECT f.entity_key AS k
             FROM formation_requests f
             LEFT JOIN (SELECT entity_key, MAX(updated_at) AS last
                          FROM oa_anchors GROUP BY entity_key) a
               ON a.entity_key = f.entity_key
            WHERE f.state = 'confirmed'
              AND (a.last IS NULL OR f.updated_at >= a.last)
         ) ORDER BY k LIMIT ?`,
      ),
      transition: db.prepare(
        `UPDATE oa_anchors
            SET state         = @to,
                -- COALESCE so persisting one leg's broadcast never wipes the other's; the CASE is
                -- the explicit "there is no tx any more" sentinel (F1) COALESCE cannot express.
                schedule_tx   = CASE WHEN @clearScheduleTx = 1
                                     THEN NULL ELSE COALESCE(@scheduleTx, schedule_tx) END,
                execute_tx    = CASE WHEN @clearExecuteTx = 1
                                     THEN NULL ELSE COALESCE(@executeTx, execute_tx) END,
                executable_at = COALESCE(@executableAt, executable_at),
                -- NOT coalesced: a successful pass must be able to CLEAR a stale backoff, and
                -- "no schedule" is a value the column has to be able to hold again.
                next_retry_at     = @nextRetryAt,
                retry_interval_ms = @retryIntervalMs,
                error         = @error,
                updated_at    = CURRENT_TIMESTAMP
          WHERE entity_key = @entityKey AND version = @version AND state = @from`,
      ),
      // ONE statement (see the formation repo's twin): an UPDATE followed by a SELECT could read
      // back a number another driver bumped in between.
      bumpAttempt: db.prepare(
        `UPDATE oa_anchors
            SET attempt = attempt + 1, state = 'pending', updated_at = CURRENT_TIMESTAMP
          WHERE entity_key = ? AND version = ? AND state = ?
      RETURNING attempt`,
      ),
      // The revert park: burns an attempt WITHOUT moving the state, and reports the new count in
      // the same statement so the escalation decision cannot read a number another driver bumped.
      parkWithAttempt: db.prepare(
        `UPDATE oa_anchors
            SET attempt = attempt + 1,
                error = @error,
                next_retry_at = @nextRetryAt,
                retry_interval_ms = @retryIntervalMs,
                updated_at = CURRENT_TIMESTAMP
          WHERE entity_key = @entityKey AND version = @version AND state = @state
      RETURNING attempt`,
      ),
      // ── the projection (F2) ────────────────────────────────────────────────────────────────
      newestExecuted: db.prepare(
        `SELECT version, manifest_hash FROM oa_anchors
          WHERE entity_key = ? AND state = 'executed'
          ORDER BY version DESC LIMIT 1`,
      ),
      newestOpen: db.prepare(
        `SELECT version, manifest_hash, executable_at, state FROM oa_anchors
          WHERE entity_key = ? AND state IN (${sqlStates(OPEN_STATES)})
          ORDER BY version DESC LIMIT 1`,
      ),
      project: db.prepare(
        `UPDATE entities
            SET -- COALESCE: an entity NEVER un-anchors. A supersede with no successor clears the
                -- pending pair below and must leave the anchored trio exactly where it was.
                oa_manifest_version       = COALESCE(@anchoredVersion, oa_manifest_version),
                oa_manifest_anchored_hash = COALESCE(@anchoredHash, oa_manifest_anchored_hash),
                -- The on-chain mirror: under the manifest scheme oa_hash IS the anchored
                -- manifest hash (design §4), and the two may never disagree.
                oa_hash                   = COALESCE(@anchoredHash, oa_hash),
                -- NOT coalesced: "nothing is pending" is the value these have to be able to hold
                -- again, and failing to write it is the phantom-pending bug this exists to kill.
                oa_manifest_pending_hash    = @pendingHash,
                oa_manifest_pending_version = @pendingVersion,
                oa_amendment_executable_at  = @executableAt
          WHERE idempotency_key = @entityKey`,
      ),
    };
    this.tx = db.transaction((fn: () => unknown) => fn()) as <T>(fn: () => T) => T;
  }

  /** Open a new anchor cycle in `pending`. Returns false when this version already exists —
   *  the claim primitive: re-deriving v2 after a crash must adopt the existing row, never
   *  restart the cycle with a different hash. */
  claimVersion(entityKey: string, version: number, manifestHash: Hex): boolean {
    return this.stmts.claimVersion.run(entityKey, version, manifestHash).changes === 1;
  }

  claimVersionAndProject(entityKey: string, version: number, manifestHash: Hex): boolean {
    return this.tx(() => {
      if (!this.claimVersion(entityKey, version, manifestHash)) return false;
      this.project(entityKey);
      return true;
    });
  }

  find(entityKey: string, version: number): OaAnchorRecord | undefined {
    const r = this.stmts.find.get(entityKey, version) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  /** Every cycle of one entity, oldest version first. */
  versionsOf(entityKey: string): OaAnchorRecord[] {
    return (this.stmts.versionsOf.all(entityKey) as Row[]).map(toRecord);
  }

  /** The entity's single in-flight cycle (single-pending rule), if one is open. */
  findPending(entityKey: string): OaAnchorRecord | undefined {
    const r = this.stmts.findPending.get(entityKey) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  /** Rows in one state across the deployment — the sweeper's due-work query. */
  listByState(state: OaAnchorState): OaAnchorRecord[] {
    return (this.stmts.listByState.all(state) as Row[]).map(toRecord);
  }

  listDueEntityKeys(limit: number): string[] {
    return (this.stmts.listDue.all(limit) as { k: string }[]).map((r) => r.k);
  }

  /**
   * COMPARE-AND-SET the state, returning whether THIS caller made the move. The txs are written
   * with COALESCE so persisting a broadcast hash never wipes the other leg's — the
   * broadcast→persist→confirm split depends on `schedule_tx` surviving the execute transition,
   * because a crash resumes by ADOPTING the persisted tx rather than re-broadcasting. `clearXTx`
   * is the explicit exception; see `OaAnchorFields`.
   */
  transition(
    entityKey: string,
    version: number,
    from: OaAnchorState,
    to: OaAnchorState,
    fields: OaAnchorFields = {},
  ): boolean {
    const info = this.stmts.transition.run({
      to,
      scheduleTx: fields.scheduleTx ?? null,
      executeTx: fields.executeTx ?? null,
      clearScheduleTx: fields.clearScheduleTx ? 1 : 0,
      clearExecuteTx: fields.clearExecuteTx ? 1 : 0,
      executableAt: fields.executableAt ?? null,
      nextRetryAt: fields.nextRetryAt ?? null,
      retryIntervalMs: fields.retryIntervalMs ?? null,
      error: fields.error ?? null,
      entityKey,
      version,
      from,
    });
    return info.changes === 1;
  }

  transitionAndProject(
    entityKey: string,
    version: number,
    from: OaAnchorState,
    to: OaAnchorState,
    fields: OaAnchorFields = {},
  ): boolean {
    return this.tx(() => {
      if (!this.transition(entityKey, version, from, to, fields)) return false;
      this.project(entityKey);
      return true;
    });
  }

  /**
   * Recompute the entity's five projection columns FROM THE ROWS.
   *
   * Private on purpose: a caller that could project without having changed anything would be a
   * second opinion about when the projection is true.
   */
  private project(entityKey: string): void {
    const anchored = this.stmts.newestExecuted.get(entityKey) as
      | { version: number; manifest_hash: string }
      | undefined;
    const open = this.stmts.newestOpen.get(entityKey) as
      | { version: number; manifest_hash: string; executable_at: number | null; state: string }
      | undefined;
    this.stmts.project.run({
      entityKey,
      anchoredVersion: anchored?.version ?? null,
      anchoredHash: anchored?.manifest_hash ?? null,
      pendingHash: open?.manifest_hash ?? null,
      pendingVersion: open?.version ?? null,
      // The guardian's countdown exists only for an amendment that is actually SCHEDULED on
      // chain. A cycle demoted back to `pending` keeps its old `executable_at` on the row (it is
      // the record of what the chain once promised) but must not advertise it as a live deadline.
      executableAt: open?.state === "scheduled" ? (open.executable_at ?? null) : null,
    });
  }

  /** Retry bookkeeping for a transient failure: bump the attempt and return to `pending`.
   *  CAS-guarded like every other move; undefined = this caller lost the race. */
  bumpAttempt(entityKey: string, version: number, from: OaAnchorState): number | undefined {
    const row = this.stmts.bumpAttempt.get(entityKey, version, from) as
      | { attempt: number }
      | undefined;
    return row?.attempt;
  }

  parkWithAttempt(
    entityKey: string,
    version: number,
    state: OaAnchorState,
    fields: { error: string; nextRetryAt: number; retryIntervalMs: number },
  ): number | undefined {
    const row = this.stmts.parkWithAttempt.get({ entityKey, version, state, ...fields }) as
      | { attempt: number }
      | undefined;
    return row?.attempt;
  }

  /** Every cycle still in flight, across the deployment. */
  listOpen(): OaAnchorRecord[] {
    return (this.stmts.listOpen.all() as Row[]).map(toRecord);
  }

  /** CAS a HOLD -> `superseded`. See the interface note: the state IS the ack. */
  acknowledgeHold(entityKey: string, version: number): boolean {
    const error = "hold acknowledged by an operator — this version will never be anchored";
    return HOLD_STATES.some((from) =>
      this.transitionAndProject(entityKey, version, from, "superseded", { error }),
    );
  }
}
