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
  confirmedBlock: number | null;
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
  latestForEntity(entityKey: string): AgentBookRow | undefined;
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
  transition(
    sessionId: string,
    from: AgentBookStatus,
    to: AgentBookStatus,
    patch?: { errorCode?: string; confirmedBlock?: number },
  ): boolean;
  bumpAttempt(sessionId: string, errorCode: string): void;
}

const COLS = `id, session_id, entity_key, tenant_id, address, nonce, status, nullifier, raw_tx,
  submitter_nonce, tx_hash, confirmed_block, attempt, error_code, expires_at, created_at, updated_at`;

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
  confirmed_block: number | null;
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
  confirmedBlock: r.confirmed_block,
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

  latestForEntity(entityKey: string): AgentBookRow | undefined {
    const r = this.db
      .prepare(
        `SELECT ${COLS} FROM agentbook_registrations WHERE entity_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(entityKey) as Raw | undefined;
    return r ? toRow(r) : undefined;
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
    patch: { errorCode?: string; confirmedBlock?: number } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE agentbook_registrations
            SET status = ?, error_code = COALESCE(?, error_code),
                confirmed_block = COALESCE(?, confirmed_block), updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ? AND status = ?`,
      )
      .run(to, patch.errorCode ?? null, patch.confirmedBlock ?? null, sessionId, from);
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
