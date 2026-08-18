import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Alert, Severity } from "./alerts";

/**
 * The monitor's own SQLite database (`${DATA_DIR}/monitor.db`).
 *
 * Deliberately separate from legalbody.db. Two reasons, both operational: the monitor must never
 * hold a WRITE handle on the money-path database (a wedged watcher must not be able to block an
 * onboarding), and its tables must never enter those migrations — this process is meant to be
 * runnable from a different box, or deleted and restarted from a cold cursor, without touching
 * anything the API owns.
 *
 * Three tables:
 *  - `cursor`      the single last-scanned block; the reason a restart does not re-page.
 *  - `open_grants` grants seen but not yet revoked — the working set rule 2 sweeps for TTL.
 *  - `alerts`      every alert at every severity. This IS the audit log and the guardian
 *                  notification record required by design §8, which is why INFO is written too.
 */

export interface OpenGrant {
  role: string;
  account: string;
  grantedAtBlock: bigint;
  /** ms epoch, taken from the BLOCK timestamp where available — see monitor.ts. */
  grantedAtTs: number;
  alertedCount: number;
}

export interface StoredAlert {
  id: number;
  ts: number;
  severity: Severity;
  rule: string;
  subject: string;
  detail: unknown;
}

export interface MonitorStore {
  /** undefined = cold start; the caller must fall back to `latest - MONITOR_LOOKBACK_BLOCKS`. */
  getCursor(): bigint | undefined;
  setCursor(block: bigint): void;
  /** Idempotent: a re-scan of the same log is a no-op (PRIMARY KEY on role+account). */
  openGrant(g: Omit<OpenGrant, "alertedCount">): void;
  closeGrant(role: string, account: string): void;
  listOpenGrants(): OpenGrant[];
  setGrantAlertedCount(role: string, account: string, count: number): void;
  /** @returns true if this alert is NEW. false means the dedup key was already recorded, and the
   *  caller must not re-emit it to stdout or the webhook. */
  recordAlert(alert: Alert): boolean;
  listAlerts(limit?: number): StoredAlert[];
  close(): void;
}

export function openMonitorDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

export function migrateMonitor(db: Database.Database): void {
  db.exec(`
    -- Single row (id=1). Block numbers are decimal STRINGS: SQLite INTEGER is signed 64-bit and
    -- these are uint256 in principle; strings keep the type honest and round-trip through BigInt.
    CREATE TABLE IF NOT EXISTS cursor (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      last_scanned_block TEXT NOT NULL
    );

    -- Grants that must be revoked. Standing executor grants and DEFAULT_ADMIN_ROLE are NOT stored
    -- here (see rules.ts): they are permanent by design, and a TTL sweep over them would page
    -- forever every 15 minutes — the fastest known way to make an on-call ignore this monitor.
    CREATE TABLE IF NOT EXISTS open_grants (
      role             TEXT NOT NULL,
      account          TEXT NOT NULL,
      granted_at_block TEXT NOT NULL,
      granted_at_ts    INTEGER NOT NULL,
      alerted_count    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (role, account)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      severity  TEXT NOT NULL CHECK (severity IN ('INFO','WARN','CRITICAL')),
      rule      TEXT NOT NULL,
      subject   TEXT NOT NULL,
      detail    TEXT NOT NULL,
      -- Replay guard. A chunk that was scanned but crashed before the cursor advanced is re-read
      -- on the next tick; without this the operator would be paged twice for one event.
      dedup_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
    CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity, ts);
  `);
}

interface GrantRow {
  role: string;
  account: string;
  granted_at_block: string;
  granted_at_ts: number;
  alerted_count: number;
}

export class SqliteMonitorStore implements MonitorStore {
  constructor(private readonly db: Database.Database) {}

  static open(path: string): SqliteMonitorStore {
    const db = openMonitorDatabase(path);
    migrateMonitor(db);
    return new SqliteMonitorStore(db);
  }

  getCursor(): bigint | undefined {
    const row = this.db.prepare("SELECT last_scanned_block AS b FROM cursor WHERE id = 1").get() as
      | { b: string }
      | undefined;
    return row ? BigInt(row.b) : undefined;
  }

  setCursor(block: bigint): void {
    this.db
      .prepare(
        "INSERT INTO cursor (id, last_scanned_block) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block",
      )
      .run(block.toString());
  }

  openGrant(g: Omit<OpenGrant, "alertedCount">): void {
    // DO NOTHING, not DO UPDATE: a re-scan must not reset grantedAtTs, or a replayed chunk would
    // silently restart the TTL clock on a grant that has already been standing too long.
    this.db
      .prepare(
        "INSERT INTO open_grants (role, account, granted_at_block, granted_at_ts) VALUES (?,?,?,?) ON CONFLICT(role, account) DO NOTHING",
      )
      .run(
        g.role.toLowerCase(),
        g.account.toLowerCase(),
        g.grantedAtBlock.toString(),
        g.grantedAtTs,
      );
  }

  closeGrant(role: string, account: string): void {
    this.db
      .prepare("DELETE FROM open_grants WHERE role = ? AND account = ?")
      .run(role.toLowerCase(), account.toLowerCase());
  }

  listOpenGrants(): OpenGrant[] {
    return (
      this.db.prepare("SELECT * FROM open_grants ORDER BY granted_at_ts").all() as GrantRow[]
    ).map((r) => ({
      role: r.role,
      account: r.account,
      grantedAtBlock: BigInt(r.granted_at_block),
      grantedAtTs: r.granted_at_ts,
      alertedCount: r.alerted_count,
    }));
  }

  setGrantAlertedCount(role: string, account: string, count: number): void {
    this.db
      .prepare("UPDATE open_grants SET alerted_count = ? WHERE role = ? AND account = ?")
      .run(count, role.toLowerCase(), account.toLowerCase());
  }

  recordAlert(alert: Alert): boolean {
    const info = this.db
      .prepare(
        "INSERT INTO alerts (ts, severity, rule, subject, detail, dedup_key) VALUES (?,?,?,?,?,?) ON CONFLICT(dedup_key) DO NOTHING",
      )
      .run(
        alert.ts,
        alert.severity,
        alert.rule,
        alert.subject,
        JSON.stringify(alert.detail),
        alert.dedupKey,
      );
    return info.changes === 1;
  }

  listAlerts(limit = 100): StoredAlert[] {
    const rows = this.db
      .prepare(
        "SELECT id, ts, severity, rule, subject, detail FROM alerts ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as {
      id: number;
      ts: number;
      severity: Severity;
      rule: string;
      subject: string;
      detail: string;
    }[];
    return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  close(): void {
    this.db.close();
  }
}
