import type Database from "better-sqlite3";
import type { Address } from "../types";

/** Epoch seconds. A repository may read the clock (unlike resumable workflow code). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Off-chain spend-ledger for the Payment Authority. Records every authorized nanopayment so that
 * authorized-but-not-yet-settled amounts (`runningPending`) count against the treasury cap before the
 * on-chain balance reflects them — closing the window where a burst of off-chain payments could
 * otherwise exceed `available()`.
 */
export class PaymentLedger {
  constructor(private readonly db: Database.Database) {}

  /** Record a freshly-authorized payment. Returns the ledger row id. */
  recordAuthorized(payee: Address, amount: bigint): number {
    const info = this.db
      .prepare(
        "INSERT INTO payments_ledger (payee, amount, status, created_at) VALUES (?, ?, 'authorized', ?)",
      )
      .run(payee, amount.toString(), nowSeconds());
    return Number(info.lastInsertRowid);
  }

  /** Mark an authorized payment as settled on-chain (by its batch reference). */
  markSettled(id: number, batchRef: string): void {
    this.db
      .prepare("UPDATE payments_ledger SET status='settled', batch_ref=?, settled_at=? WHERE id=?")
      .run(batchRef, nowSeconds(), id);
  }

  /** Mark an authorized payment as failed (settlement never landed); it stops counting as pending. */
  markFailed(id: number): void {
    this.db.prepare("UPDATE payments_ledger SET status='failed' WHERE id=?").run(id);
  }

  /** Sum of authorized-but-not-yet-settled amounts (the off-chain spend not yet reflected on-chain). */
  runningPending(): bigint {
    const rows = this.db
      .prepare("SELECT amount FROM payments_ledger WHERE status='authorized'")
      .all() as { amount: string }[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
  }
}
