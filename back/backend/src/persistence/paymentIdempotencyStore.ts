import type Database from "better-sqlite3";

export interface PaymentReceipt {
  ok: boolean;
  txOrTransferId: string | null;
  reason?: string;
}

/** Persists idempotency claims for `pay`, keyed by (idempotencyKey, tenantId, entityKey), so a
 *  repeated call with the same key returns the original receipt instead of settling twice. */
export class SqlitePaymentIdempotencyStore {
  constructor(private readonly db: Database.Database) {}

  /** Atomically claim (key,tenant,entity). "new" = caller must proceed then call complete();
   *  "replayed" = a completed receipt already exists (return it, do NOT settle again). A
   *  claimed-but-not-completed row (receipt_json null) also replays as a benign in-flight
   *  duplicate with a null-txOrTransferId receipt. */
  begin(
    key: string,
    tenantId: string,
    entityKey: string,
  ): { status: "new" } | { status: "replayed"; receipt: PaymentReceipt } {
    // Atomic claim: a single INSERT ... ON CONFLICT DO NOTHING is the cross-process mutex
    // primitive (same pattern as entityRepository.claimKey) — a plain SELECT-then-INSERT would
    // race across concurrent processes sharing the same SQLite file and let two callers both
    // observe "no row yet" and both proceed to settle.
    const info = this.db
      .prepare(
        "INSERT INTO payment_idempotency (idem_key, tenant_id, entity_key, receipt_json) VALUES (?,?,?,NULL) ON CONFLICT (idem_key, tenant_id, entity_key) DO NOTHING",
      )
      .run(key, tenantId, entityKey);
    if (info.changes === 1) return { status: "new" };

    const existing = this.db
      .prepare(
        "SELECT receipt_json FROM payment_idempotency WHERE idem_key=? AND tenant_id=? AND entity_key=?",
      )
      .get(key, tenantId, entityKey) as { receipt_json: string | null };
    const receipt: PaymentReceipt = existing.receipt_json
      ? (JSON.parse(existing.receipt_json) as PaymentReceipt)
      : { ok: false, txOrTransferId: null, reason: "in-flight-duplicate" };
    return { status: "replayed", receipt };
  }

  /** Records the outcome for a claimed (key,tenant,entity), so subsequent `begin` calls replay it. */
  complete(key: string, tenantId: string, entityKey: string, receipt: PaymentReceipt): void {
    this.db
      .prepare(
        "UPDATE payment_idempotency SET receipt_json=? WHERE idem_key=? AND tenant_id=? AND entity_key=?",
      )
      .run(JSON.stringify(receipt), key, tenantId, entityKey);
  }
}
