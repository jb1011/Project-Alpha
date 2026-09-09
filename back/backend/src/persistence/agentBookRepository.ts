import type Database from "better-sqlite3";

/**
 * AgentBook registrations (design 2026-08-25 v3 §4.4).
 *
 * Same CAS discipline as `oaAnchorRepository`: every state move is `UPDATE … WHERE status = ?` and
 * reports whether this caller won it. The partial unique index on `submitted` is the atomic
 * in-flight claim; a `pending` row is a session and never blocks a restart (expiry is its guard).
 */
export type AgentBookStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "disputed"
  | "failed"
  | "expired";

export interface AgentBookRow {
  id: number;
  sessionId: string;
  entityKey: string;
  tenantId: string;
  address: string;
  nonce: string;
  status: AgentBookStatus;
  nullifier: string | null;
  rawTx: string | null;
  submitterNonce: number | null;
  txHash: string | null;
  attempt: number;
  errorCode: string | null;
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBookRepository {
  createSession(p: {
    sessionId: string;
    entityKey: string;
    tenantId: string;
    address: string;
    nonce: string;
    expiresAt: number;
  }): AgentBookRow;
  findBySession(sessionId: string): AgentBookRow | undefined;
  /**
   * The row that answers for this entity RIGHT NOW: the in-flight `submitted` one if there is one,
   * otherwise the newest.
   *
   * Not simply the newest (design §5.2, altitude F10): a second session can be opened while a
   * first is `submitted` — the lifetime cap allows three and the partial unique index only refuses
   * the second *claim* — and when that second session expires it becomes the newest row. Serving
   * it would let the status route fall through to the chain's "not registered" while our own
   * transaction is on its way, which is exactly the terminal answer over an in-flight row §5.2
   * forbids. At most one `submitted` row per entity exists, so "the in-flight one" is unambiguous.
   */
  currentForEntity(entityKey: string): AgentBookRow | undefined;
  /**
   * Every row of this entity that carries a NULLIFIER, newest first.
   *
   * "Is this vouch ours?" is a question about all of them, never about `currentForEntity`'s single
   * answer (re-review R1): a `pending` session and the `expired` row it becomes carry no nullifier,
   * so they can match nothing on chain — and one of them is the newest row from the moment a
   * guardian opens the dialog in a second tab and walks away. Asked of that row alone, the entry we
   * wrote ourselves came back a stranger's, permanently.
   *
   * Only rows a proof was actually submitted for, which is also what keeps the result small: those
   * are bounded by what the lifetime cap lets onto the chain, while the abandoned sessions are
   * capped per tenant per hour and not per entity at all.
   */
  rowsWithNullifierForEntity(entityKey: string): AgentBookRow[];
  /** Rows that count toward the per-entity lifetime cap (D13). */
  countLifetime(entityKey: string): number;
  /** Sessions this tenant created since `sinceMs` (epoch ms), for the per-tenant window. */
  countSessionsSince(tenantId: string, sinceMs: number): number;
  /** Confirmed vouches from this tenant, for the "already vouched for N agents" dialog line. */
  countConfirmedForTenant(tenantId: string): number;
  listInFlight(): AgentBookRow[];
  /** pending -> submitted, writing what a crash must not lose. "inflight" = another submission for
   *  this entity holds the partial unique index. */
  claimSubmit(
    sessionId: string,
    p: { nullifier: string; rawTx: string; submitterNonce: number },
  ): "won" | "lost" | "inflight";
  setTxHash(sessionId: string, txHash: string): void;
  /** CAS state move. `errorCode` is the LAST-ATTEMPT diagnostic, meaningful only on a `failed` or
   *  `disputed` row: a transition to `confirmed` CLEARS it, so a row that succeeded on a retry does
   *  not keep advertising the transport error that made the earlier attempt fail. */
  transition(
    sessionId: string,
    from: AgentBookStatus,
    to: AgentBookStatus,
    patch?: { errorCode?: string },
  ): boolean;
  bumpAttempt(sessionId: string, errorCode: string): void;
}

const COLS = `id, session_id, entity_key, tenant_id, address, nonce, status, nullifier, raw_tx,
  submitter_nonce, tx_hash, attempt, error_code, expires_at, created_at, updated_at`;

type Raw = {
  id: number;
  session_id: string;
  entity_key: string;
  tenant_id: string;
  address: string;
  nonce: string;
  status: AgentBookStatus;
  nullifier: string | null;
  raw_tx: string | null;
  submitter_nonce: number | null;
  tx_hash: string | null;
  attempt: number;
  error_code: string | null;
  expires_at: number;
  created_at: string;
  updated_at: string;
};

const toRow = (r: Raw): AgentBookRow => ({
  id: r.id,
  sessionId: r.session_id,
  entityKey: r.entity_key,
  tenantId: r.tenant_id,
  address: r.address,
  nonce: r.nonce,
  status: r.status,
  nullifier: r.nullifier,
  rawTx: r.raw_tx,
  submitterNonce: r.submitter_nonce,
  txHash: r.tx_hash,
  attempt: r.attempt,
  errorCode: r.error_code,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteAgentBookRepository implements AgentBookRepository {
  constructor(private readonly db: Database.Database) {}

  createSession(p: {
    sessionId: string;
    entityKey: string;
    tenantId: string;
    address: string;
    nonce: string;
    expiresAt: number;
  }): AgentBookRow {
    this.db
      .prepare(
        `INSERT INTO agentbook_registrations
           (session_id, entity_key, tenant_id, address, nonce, status, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      // `address` is lowercased here; `tenant_id` is stored as the auth layer gives it (EIP-55
      // checksummed). The two columns are therefore NEVER directly comparable.
      .run(p.sessionId, p.entityKey, p.tenantId, p.address.toLowerCase(), p.nonce, p.expiresAt);
    const row = this.findBySession(p.sessionId);
    if (!row) throw new Error(`agentbook session ${p.sessionId} vanished after insert`);
    return row;
  }

  findBySession(sessionId: string): AgentBookRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLS} FROM agentbook_registrations WHERE session_id = ?`)
      .get(sessionId) as Raw | undefined;
    return r ? toRow(r) : undefined;
  }

  currentForEntity(entityKey: string): AgentBookRow | undefined {
    // `status = 'submitted'` is 1 or 0 in SQLite, so DESC puts the in-flight row first and the
    // ordinary "newest wins" rule decides everything else. One query, and `idx_agentbook_entity`
    // still serves it.
    const r = this.db
      .prepare(
        `SELECT ${COLS} FROM agentbook_registrations WHERE entity_key = ?
          ORDER BY (status = 'submitted') DESC, id DESC LIMIT 1`,
      )
      .get(entityKey) as Raw | undefined;
    return r ? toRow(r) : undefined;
  }

  rowsWithNullifierForEntity(entityKey: string): AgentBookRow[] {
    // One statement, and `idx_agentbook_entity` serves it exactly as it serves `currentForEntity`.
    return (
      this.db
        .prepare(
          `SELECT ${COLS} FROM agentbook_registrations
            WHERE entity_key = ? AND nullifier IS NOT NULL ORDER BY id DESC`,
        )
        .all(entityKey) as Raw[]
    ).map(toRow);
  }

  countLifetime(entityKey: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agentbook_registrations
          WHERE entity_key = ? AND status IN ('submitted','confirmed','disputed')`,
      )
      .get(entityKey) as { n: number };
    return r.n;
  }

  countSessionsSince(tenantId: string, sinceMs: number): number {
    // created_at is a SQLite UTC timestamp; compare in seconds.
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agentbook_registrations
          WHERE tenant_id = ? AND strftime('%s', created_at) * 1000 >= ?`,
      )
      .get(tenantId, sinceMs) as { n: number };
    return r.n;
  }

  countConfirmedForTenant(tenantId: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agentbook_registrations
          WHERE tenant_id = ? AND status = 'confirmed'`,
      )
      .get(tenantId) as { n: number };
    return r.n;
  }

  listInFlight(): AgentBookRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLS} FROM agentbook_registrations
            WHERE status IN ('pending','submitted') ORDER BY id`,
        )
        .all() as Raw[]
    ).map(toRow);
  }

  claimSubmit(
    sessionId: string,
    p: { nullifier: string; rawTx: string; submitterNonce: number },
  ): "won" | "lost" | "inflight" {
    try {
      const res = this.db
        .prepare(
          `UPDATE agentbook_registrations
              SET status = 'submitted', nullifier = ?, raw_tx = ?, submitter_nonce = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ? AND status = 'pending'`,
        )
        .run(p.nullifier, p.rawTx, p.submitterNonce, sessionId);
      return res.changes === 1 ? "won" : "lost";
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT") return "inflight";
      throw e;
    }
  }

  setTxHash(sessionId: string, txHash: string): void {
    this.db
      .prepare(
        `UPDATE agentbook_registrations SET tx_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ?`,
      )
      .run(txHash, sessionId);
  }

  transition(
    sessionId: string,
    from: AgentBookStatus,
    to: AgentBookStatus,
    patch: { errorCode?: string } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE agentbook_registrations
            SET status = ?,
                error_code = CASE WHEN ? = 'confirmed' THEN NULL ELSE COALESCE(?, error_code) END,
                updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ? AND status = ?`,
      )
      .run(to, to, patch.errorCode ?? null, sessionId, from);
    return res.changes === 1;
  }

  bumpAttempt(sessionId: string, errorCode: string): void {
    this.db
      .prepare(
        `UPDATE agentbook_registrations
            SET attempt = attempt + 1, error_code = ?, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ?`,
      )
      .run(errorCode, sessionId);
  }
}
