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

  /** Record a freshly-authorized payment, scoped to the owning entity. Returns the ledger row id. */
  recordAuthorized(entityKey: string, payee: Address, amount: bigint): number {
    const info = this.db
      .prepare(
        "INSERT INTO payments_ledger (entity_key, payee, amount, status, created_at) VALUES (?, ?, ?, 'authorized', ?)",
      )
      .run(entityKey, payee, amount.toString(), nowSeconds());
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

  /**
   * A Hedera payment reported by the agent and CONFIRMED on the mirror node (design D13).
   *
   * `payee` is a `string` and not an `Address` on both of the `*OnNetwork` writers because an
   * off-Arc rail names its payee in its own alphabet: Hedera's is a `0.0.x` account id, which is
   * not an EVM address and never will be. The Arc writers above keep `Address`, so nothing on
   * that path loosens.
   *
   * Both writers can THROW on the partial unique index `(network, batch_ref)`; that throw is the
   * idempotency, and the caller catches it rather than checking first (check-then-insert has a
   * race, the index does not).
   */
  recordSettledOnNetwork(
    entityKey: string,
    payee: string,
    amount: bigint,
    network: string,
    ref: string,
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO payments_ledger (entity_key, payee, amount, status, batch_ref, network, created_at, settled_at) VALUES (?, ?, ?, 'settled', ?, ?, ?, ?)",
      )
      .run(entityKey, payee, amount.toString(), ref, network, nowSeconds(), nowSeconds());
    return Number(info.lastInsertRowid);
  }

  /**
   * A Hedera payment reported by the agent and found FAILED on the mirror node.
   *
   * Written directly as `failed` rather than as `recordAuthorized` + `markFailed`, because
   * nothing ever authorized it: the server did not sign this payment and did not know about it
   * until the agent reported the transaction id. There is no pending row to close, and inventing
   * one would put a Hedera amount into `runningPending` — an Arc-only number (D8) — for as long
   * as the two writes were apart.
   *
   * It carries the same `batch_ref` as a settled row would, so the partial unique index counts a
   * failed transaction id exactly once too: reporting the same failure twice is not two failures.
   */
  recordFailedOnNetwork(
    entityKey: string,
    payee: string,
    amount: bigint,
    network: string,
    ref: string,
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO payments_ledger (entity_key, payee, amount, status, batch_ref, network, created_at) VALUES (?, ?, ?, 'failed', ?, ?, ?)",
      )
      .run(entityKey, payee, amount.toString(), ref, network, nowSeconds());
    return Number(info.lastInsertRowid);
  }

  /** Sum of THIS ENTITY'S authorized-but-not-yet-settled amounts (the off-chain spend not yet
   *  reflected on-chain). Scoped per entity so one tenant's pending spend never counts against
   *  another's cap. */
  runningPending(entityKey: string): bigint {
    const rows = this.db
      .prepare("SELECT amount FROM payments_ledger WHERE entity_key = ? AND status = 'authorized'")
      .all(entityKey) as { amount: string }[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
  }
}
