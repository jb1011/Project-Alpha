import type Database from "better-sqlite3";

/**
 * The inbound-webhook ledger (design 2026-08-19 §3/§6).
 *
 * Three jobs, and it is worth naming them separately because only the first is obvious:
 *
 *  1. **Dedupe.** `event_id` is the PRIMARY KEY and every write is `INSERT OR IGNORE`, so doola's
 *     retry ladder (1m/15m/1h/12h/24h) can deliver the same event five times and exactly one row
 *     — and exactly one processing task — results.
 *  2. **The sweeper's work queue.** `processed_at IS NULL` means "still owed". A webhook that
 *     arrived before the company id was mapped to an entity, or during a doola outage, is not
 *     lost: it sits here until a tick can make sense of it (partial index
 *     `idx_doola_events_pending`).
 *  3. **Forensics.** The raw envelope is persisted so that "what did doola actually send?" is
 *     answerable months later. It is NEVER a source of facts — §5/H2: processors re-fetch
 *     authoritative state from doola's API over TLS, and the payload column is written and read
 *     by nothing except an operator with a SQL prompt.
 *
 * Rows are swept after 30 days by the formation sweeper.
 */
export interface DoolaWebhookEventRecord {
  eventId: string;
  eventName: string;
  /** doola's company id, when the envelope carried one. NULL = nothing to map to an entity. */
  providerRef: string | null;
  /** The raw envelope, verbatim. Forensics only — never parsed for facts. */
  payload: string;
  receivedAt: string;
  processedAt: string | null;
}

interface Row {
  event_id: string;
  event_name: string;
  provider_ref: string | null;
  payload: string;
  received_at: string;
  processed_at: string | null;
}

function toRecord(r: Row): DoolaWebhookEventRecord {
  return {
    eventId: r.event_id,
    eventName: r.event_name,
    providerRef: r.provider_ref,
    payload: r.payload,
    receivedAt: r.received_at,
    processedAt: r.processed_at,
  };
}

/** The narrow surface the receiver and the sweeper share. Injectable so both are testable
 *  without a database, and so a test can poison a single write. */
export interface DoolaEventRepository {
  /**
   * Persist a received envelope. Returns FALSE when the event id was already known — which is
   * the dedupe verdict the receiver turns into "ack 200, schedule nothing".
   */
  record(e: {
    eventId: string;
    eventName: string;
    providerRef: string | null;
    payload: string;
  }): boolean;
  find(eventId: string): DoolaWebhookEventRecord | undefined;
  /** Everything still owed to the sweeper, oldest first. */
  listUnprocessed(limit?: number): DoolaWebhookEventRecord[];
  /** Mark done. Only ever called AFTER a successful fetch-and-advance. */
  markProcessed(eventId: string): boolean;
  /** Retention sweep: drop processed and unprocessable rows older than the cutoff. Returns the
   *  number deleted. */
  deleteOlderThan(cutoffUtc: string): number;
}

export class SqliteDoolaEventRepository implements DoolaEventRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      // INSERT OR IGNORE, not INSERT … ON CONFLICT DO UPDATE: a redelivery must NOT overwrite the
      // first copy we saw. If doola ever redelivered a mutated payload, the row we keep is the
      // one we acted on, which is the only version forensics can use.
      insert: db.prepare(
        `INSERT OR IGNORE INTO doola_webhook_events (event_id, event_name, provider_ref, payload)
         VALUES (?, ?, ?, ?)`,
      ),
      find: db.prepare("SELECT * FROM doola_webhook_events WHERE event_id = ?"),
      listUnprocessed: db.prepare(
        `SELECT * FROM doola_webhook_events
          WHERE processed_at IS NULL
          ORDER BY received_at, event_id
          LIMIT ?`,
      ),
      markProcessed: db.prepare(
        `UPDATE doola_webhook_events SET processed_at = CURRENT_TIMESTAMP
          WHERE event_id = ? AND processed_at IS NULL`,
      ),
      deleteOld: db.prepare("DELETE FROM doola_webhook_events WHERE received_at < ?"),
    };
  }

  record(e: {
    eventId: string;
    eventName: string;
    providerRef: string | null;
    payload: string;
  }): boolean {
    return this.stmts.insert.run(e.eventId, e.eventName, e.providerRef, e.payload).changes === 1;
  }

  find(eventId: string): DoolaWebhookEventRecord | undefined {
    const r = this.stmts.find.get(eventId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  listUnprocessed(limit = 200): DoolaWebhookEventRecord[] {
    return (this.stmts.listUnprocessed.all(limit) as Row[]).map(toRecord);
  }

  markProcessed(eventId: string): boolean {
    // CAS on `processed_at IS NULL`: the webhook's own background task and a sweeper re-drive can
    // both be holding this event, and only one of them should be able to say it finished it.
    return this.stmts.markProcessed.run(eventId).changes === 1;
  }

  deleteOlderThan(cutoffUtc: string): number {
    return this.stmts.deleteOld.run(cutoffUtc).changes;
  }
}
