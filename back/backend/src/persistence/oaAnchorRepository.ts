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
 */
export type OaAnchorState =
  | "pending"
  | "scheduled"
  | "executed"
  | "vetoed"
  | "superseded"
  | "failed";

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
  };
}

/** The slice of the anchor store its callers use. An interface so the onboarding saga can take
 *  it as a seam (tests fake it; production passes the sqlite one over the SAME db handle, which
 *  is what lets the anchor row commit inside the entity row's transaction). */
export interface OaAnchorRepository {
  claimVersion(entityKey: string, version: number, manifestHash: Hex): boolean;
  find(entityKey: string, version: number): OaAnchorRecord | undefined;
  versionsOf(entityKey: string): OaAnchorRecord[];
  findPending(entityKey: string): OaAnchorRecord | undefined;
  listByState(state: OaAnchorState): OaAnchorRecord[];
  transition(
    entityKey: string,
    version: number,
    from: OaAnchorState,
    to: OaAnchorState,
    fields?: { scheduleTx?: Hex; executeTx?: Hex; executableAt?: number; error?: string | null },
  ): boolean;
  bumpAttempt(entityKey: string, version: number, from: OaAnchorState): number | undefined;
}

export class SqliteOaAnchorRepository implements OaAnchorRepository {
  /** Prepared ONCE — same reason as the formation repo: the anchor sweeper runs these on a timer
   *  for the life of the process, and better-sqlite3 caches nothing on our behalf. The tables
   *  exist by construction time (`migrate(db)` runs first at every composition root). */
  private readonly stmts;

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
          WHERE entity_key = ? AND state IN ('pending','scheduled')
          ORDER BY version DESC LIMIT 1`,
      ),
      listByState: db.prepare(
        "SELECT * FROM oa_anchors WHERE state = ? ORDER BY entity_key, version",
      ),
      transition: db.prepare(
        `UPDATE oa_anchors
            SET state         = ?,
                schedule_tx   = COALESCE(?, schedule_tx),
                execute_tx    = COALESCE(?, execute_tx),
                executable_at = COALESCE(?, executable_at),
                error         = ?,
                updated_at    = CURRENT_TIMESTAMP
          WHERE entity_key = ? AND version = ? AND state = ?`,
      ),
      // ONE statement (see the formation repo's twin): an UPDATE followed by a SELECT could read
      // back a number another driver bumped in between.
      bumpAttempt: db.prepare(
        `UPDATE oa_anchors
            SET attempt = attempt + 1, state = 'pending', updated_at = CURRENT_TIMESTAMP
          WHERE entity_key = ? AND version = ? AND state = ?
      RETURNING attempt`,
      ),
    };
  }

  /** Open a new anchor cycle in `pending`. Returns false when this version already exists —
   *  the claim primitive: re-deriving v2 after a crash must adopt the existing row, never
   *  restart the cycle with a different hash. */
  claimVersion(entityKey: string, version: number, manifestHash: Hex): boolean {
    return this.stmts.claimVersion.run(entityKey, version, manifestHash).changes === 1;
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

  /**
   * COMPARE-AND-SET the state, returning whether THIS caller made the move. The txs are written
   * with COALESCE so persisting a broadcast hash never wipes the other leg's — the
   * broadcast→persist→confirm split depends on `schedule_tx` surviving the execute transition,
   * because a crash resumes by ADOPTING the persisted tx rather than re-broadcasting.
   */
  transition(
    entityKey: string,
    version: number,
    from: OaAnchorState,
    to: OaAnchorState,
    fields: {
      scheduleTx?: Hex;
      executeTx?: Hex;
      executableAt?: number;
      error?: string | null;
    } = {},
  ): boolean {
    const info = this.stmts.transition.run(
      to,
      fields.scheduleTx ?? null,
      fields.executeTx ?? null,
      fields.executableAt ?? null,
      fields.error ?? null,
      entityKey,
      version,
      from,
    );
    return info.changes === 1;
  }

  /** Retry bookkeeping for a transient failure: bump the attempt and return to `pending`.
   *  CAS-guarded like every other move; undefined = this caller lost the race. */
  bumpAttempt(entityKey: string, version: number, from: OaAnchorState): number | undefined {
    const row = this.stmts.bumpAttempt.get(entityKey, version, from) as
      | { attempt: number }
      | undefined;
    return row?.attempt;
  }
}
