import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Address, Hex } from "../types";

/**
 * FORMATION PAYMENTS (design 2026-08-26 §2/§6) — the rows A1 created the table for.
 *
 * Its own repository rather than more methods on `CompanyRepository`, for the reason the two
 * tables are separate at all: "paying" is DERIVED from these rows and never stored on the
 * company, so the company store deliberately knows nothing about payments except how to COUNT
 * live ones (`livePaymentCount`, which backs `hasLivePayment`). A quote, a settlement and a
 * refund are this file's business.
 *
 * ── THE TRANSITIONS, and why every one of them is a CAS ───────────────────────────────────────
 *
 *   quoted   → settling | expired
 *   settling → settled  | expired | failed
 *   settled  → refunded            (the CLI, recording a Ledger transfer — it moves nothing)
 *
 * Three actors can reach the same row: the settle route, the sweeper's resume leg, and (for the
 * last arrow) an operator at a CLI. A blind `UPDATE … SET status = 'expired'` from the sweeper
 * could therefore land on a row the settle route moved to `settling` a millisecond earlier, and
 * the guardian's signature would be broadcast against a payment we had just written off. So every
 * writer names the state it believes it is leaving, and learns from the row count whether it was
 * right. A caller that loses a CAS has not failed — it has been overtaken, and must do nothing.
 *
 * ⚠ `markSettling` persists the SIGNED RAW TRANSACTION and its hash BEFORE the broadcast (§6.4,
 * the `bridgeLegRepository` rule). That is what makes a crash mid-settle recoverable without
 * re-quoting: the resume leg re-broadcasts THE SAME bytes, which is idempotent on-chain, where
 * re-quoting would ask the guardian to sign a second authorization while the first is still live
 * and self-authorizing — i.e. a double charge.
 */

export type FormationPaymentProduct = "formation" | "maintenance_year";

/**
 * The status union, enumerated ONCE (§2 — the audit finding that `released` was referred to and
 * never defined). The CHECK constraint in `db.ts` is the same list; this type is what the code
 * reads it through.
 */
export type FormationPaymentStatus =
  | "quoted"
  | "settling"
  | "settled"
  | "expired"
  | "failed"
  | "refunded";

/** The statuses the unique partial index treats as LIVE — at most one per (company, product). */
export const LIVE_PAYMENT_STATUSES: readonly FormationPaymentStatus[] = ["quoted", "settling"];

export interface FormationPaymentRecord {
  paymentId: string;
  companyId: string;
  product: FormationPaymentProduct;
  status: FormationPaymentStatus;
  /** The STORED quote, atomic USDC (6 decimals). Verification compares against THIS, never live
   *  config: a fee change between quote and settle must not re-price a signature already given. */
  amountUsdc: bigint;
  /** 32 random bytes, hex — from the ROW, never derived from the company id (a derived nonce is
   *  one-shot and would brick the company after any failed attempt). */
  nonce: Hex;
  /** Unix SECONDS. What the guardian signed as `validBefore`. */
  validBefore: number;
  payerAddress: Address | null;
  /** The signed transaction, persisted BEFORE broadcast. */
  rawTx: Hex | null;
  txHash: Hex | null;
  attempt: number;
  refundTxHash: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  payment_id: string;
  company_id: string;
  product: FormationPaymentProduct;
  status: FormationPaymentStatus;
  amount_usdc: string;
  nonce: string;
  valid_before: number;
  payer_address: string | null;
  raw_tx: Buffer | Uint8Array | string | null;
  tx_hash: string | null;
  attempt: number;
  refund_tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `raw_tx` is a BLOB column and a signed transaction is hex. Stored as the hex STRING rather than
 * as decoded bytes: it is what `sendRawTransaction` takes, so round-tripping it through a Buffer
 * would buy nothing but a conversion that could be got wrong in one direction only. better-sqlite3
 * hands a BLOB back as a Buffer regardless of what went in, so the read normalises both shapes.
 */
function toHex(raw: Row["raw_tx"]): Hex | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw as Hex;
  return Buffer.from(raw).toString("utf8") as Hex;
}

function toRecord(r: Row): FormationPaymentRecord {
  return {
    paymentId: r.payment_id,
    companyId: r.company_id,
    product: r.product,
    status: r.status,
    amountUsdc: BigInt(r.amount_usdc),
    nonce: r.nonce as Hex,
    validBefore: r.valid_before,
    payerAddress: (r.payer_address as Address) ?? null,
    rawTx: toHex(r.raw_tx),
    txHash: (r.tx_hash as Hex) ?? null,
    attempt: r.attempt,
    refundTxHash: r.refund_tx_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewFormationPayment {
  companyId: string;
  product: FormationPaymentProduct;
  amountUsdc: bigint;
  nonce: Hex;
  /** Unix SECONDS. */
  validBefore: number;
  paymentId?: string;
}

export interface FormationPaymentRepository {
  /**
   * Insert a `quoted` row. Called INSIDE the caller's transaction, beside the company INSERT
   * (§6.1), so a company can never exist in `draft` with no quote to leave it by.
   *
   * The unique partial index does the rest: a second live quote for the same (company, product)
   * is a constraint violation rather than a race the caller has to think about.
   */
  create(input: NewFormationPayment): string;
  find(paymentId: string): FormationPaymentRecord | undefined;
  /** The LIVE row for a (company, product), if there is one. At most one can exist. */
  findLive(companyId: string, product: FormationPaymentProduct): FormationPaymentRecord | undefined;
  /**
   * What `GET /companies/:id/payment` answers with: the live row if there is one, otherwise the
   * most recent terminal one.
   *
   * Both, because the two questions a caller has are "what do I owe?" and "what happened?", and a
   * route that answered only the first would tell a guardian whose payment just settled that they
   * have no payment at all.
   */
  findCurrent(
    companyId: string,
    product: FormationPaymentProduct,
  ): FormationPaymentRecord | undefined;
  listByCompany(companyId: string): FormationPaymentRecord[];
  /** Every row in one status, oldest first — the sweeper's reader. */
  listByStatus(status: FormationPaymentStatus, limit?: number): FormationPaymentRecord[];
  /** `quoted` rows whose `valid_before` has passed (unix seconds), oldest first. */
  listExpiredQuotes(nowSec: number, limit?: number): FormationPaymentRecord[];

  /**
   * `quoted → settling`, carrying the payer and the signed transaction we are ABOUT to broadcast.
   *
   * The CAS is on `quoted` specifically: a row already `settling` belongs to a broadcast that is
   * in flight or crashed, and the resume leg owns it. Two settle requests for one quote therefore
   * produce one broadcast and one refusal, not two transfers.
   */
  markSettling(
    paymentId: string,
    submission: { payerAddress: Address; rawTx: Hex; txHash: Hex },
  ): boolean;
  /** `settling → settled`, pinning the hash the receipt came from. */
  markSettled(paymentId: string, txHash: Hex): boolean;
  /** `quoted|settling → expired`. The caller has PROVEN the authorization can no longer be used
   *  (§6.4 rule 2: past `validBefore` AND `authorizationState === false`). */
  markExpired(paymentId: string, from: FormationPaymentStatus): boolean;
  /** `settling → failed` — a broadcast that reverted, i.e. an outcome we KNOW. */
  markFailed(paymentId: string): boolean;
  /**
   * `settled → refunded`, recording a transfer signed MANUALLY from the Ledger (§6.6).
   *
   * It moves nothing and never touches `platform_outflows`: a 399 USDC row in the S5 meter would
   * exceed the 200 USDC ceiling and block every agent's treasury funding, gas seeds and job
   * funding for 24 hours.
   */
  markRefunded(paymentId: string, ledgerTxHash: string): boolean;
  /** Burn an attempt on a stalled settle and return the new count (the bridge-legs primitive).
   *  The STATUS is untouched: the row stays `settling`, because the broadcast still is. */
  bumpAttempt(paymentId: string): number;
}

export class SqliteFormationPaymentRepository implements FormationPaymentRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO formation_payments
           (payment_id, company_id, product, status, amount_usdc, nonce, valid_before)
         VALUES (@payment_id, @company_id, @product, 'quoted', @amount_usdc, @nonce, @valid_before)`,
      ),
      find: db.prepare("SELECT * FROM formation_payments WHERE payment_id = ?"),
      findLive: db.prepare(
        `SELECT * FROM formation_payments
          WHERE company_id = ? AND product = ? AND status IN ('quoted','settling')`,
      ),
      // Newest first, tie-broken by the id so a re-quote inside the same second is deterministic.
      findLatest: db.prepare(
        `SELECT * FROM formation_payments
          WHERE company_id = ? AND product = ?
          ORDER BY created_at DESC, payment_id DESC LIMIT 1`,
      ),
      listByCompany: db.prepare(
        `SELECT * FROM formation_payments WHERE company_id = ?
          ORDER BY created_at DESC, payment_id DESC`,
      ),
      listByStatus: db.prepare(
        `SELECT * FROM formation_payments WHERE status = ?
          ORDER BY created_at, payment_id LIMIT ?`,
      ),
      listExpiredQuotes: db.prepare(
        `SELECT * FROM formation_payments
          WHERE status = 'quoted' AND valid_before <= ?
          ORDER BY created_at, payment_id LIMIT ?`,
      ),
      markSettling: db.prepare(
        `UPDATE formation_payments
            SET status = 'settling', payer_address = @payer_address, raw_tx = @raw_tx,
                tx_hash = @tx_hash, updated_at = CURRENT_TIMESTAMP
          WHERE payment_id = @payment_id AND status = 'quoted'`,
      ),
      markSettled: db.prepare(
        `UPDATE formation_payments
            SET status = 'settled', tx_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE payment_id = ? AND status = 'settling'`,
      ),
      markExpired: db.prepare(
        `UPDATE formation_payments SET status = 'expired', updated_at = CURRENT_TIMESTAMP
          WHERE payment_id = ? AND status = ?`,
      ),
      markFailed: db.prepare(
        `UPDATE formation_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE payment_id = ? AND status = 'settling'`,
      ),
      // `refund_tx_hash IS NULL` as well as the status: recording a second refund over the first
      // would silently overwrite the only pointer we hold to the money that actually moved.
      markRefunded: db.prepare(
        `UPDATE formation_payments
            SET status = 'refunded', refund_tx_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE payment_id = ? AND status = 'settled' AND refund_tx_hash IS NULL`,
      ),
      bump: db.prepare(
        `UPDATE formation_payments SET attempt = attempt + 1, updated_at = CURRENT_TIMESTAMP
          WHERE payment_id = ?`,
      ),
      attemptOf: db.prepare("SELECT attempt FROM formation_payments WHERE payment_id = ?"),
    };
  }

  create(input: NewFormationPayment): string {
    const paymentId = input.paymentId ?? randomUUID();
    this.stmts.insert.run({
      payment_id: paymentId,
      company_id: input.companyId,
      product: input.product,
      amount_usdc: input.amountUsdc.toString(),
      nonce: input.nonce,
      valid_before: input.validBefore,
    });
    return paymentId;
  }

  find(paymentId: string): FormationPaymentRecord | undefined {
    const r = this.stmts.find.get(paymentId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findLive(
    companyId: string,
    product: FormationPaymentProduct,
  ): FormationPaymentRecord | undefined {
    const r = this.stmts.findLive.get(companyId, product) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findCurrent(
    companyId: string,
    product: FormationPaymentProduct,
  ): FormationPaymentRecord | undefined {
    const live = this.findLive(companyId, product);
    if (live) return live;
    const r = this.stmts.findLatest.get(companyId, product) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  listByCompany(companyId: string): FormationPaymentRecord[] {
    return (this.stmts.listByCompany.all(companyId) as Row[]).map(toRecord);
  }

  listByStatus(status: FormationPaymentStatus, limit = 200): FormationPaymentRecord[] {
    return (this.stmts.listByStatus.all(status, limit) as Row[]).map(toRecord);
  }

  listExpiredQuotes(nowSec: number, limit = 200): FormationPaymentRecord[] {
    return (this.stmts.listExpiredQuotes.all(nowSec, limit) as Row[]).map(toRecord);
  }

  markSettling(
    paymentId: string,
    submission: { payerAddress: Address; rawTx: Hex; txHash: Hex },
  ): boolean {
    return (
      this.stmts.markSettling.run({
        payment_id: paymentId,
        payer_address: submission.payerAddress,
        raw_tx: submission.rawTx,
        tx_hash: submission.txHash,
      }).changes === 1
    );
  }

  markSettled(paymentId: string, txHash: Hex): boolean {
    return this.stmts.markSettled.run(txHash, paymentId).changes === 1;
  }

  markExpired(paymentId: string, from: FormationPaymentStatus): boolean {
    return this.stmts.markExpired.run(paymentId, from).changes === 1;
  }

  markFailed(paymentId: string): boolean {
    return this.stmts.markFailed.run(paymentId).changes === 1;
  }

  markRefunded(paymentId: string, ledgerTxHash: string): boolean {
    return this.stmts.markRefunded.run(ledgerTxHash, paymentId).changes === 1;
  }

  bumpAttempt(paymentId: string): number {
    this.stmts.bump.run(paymentId);
    return (this.stmts.attemptOf.get(paymentId) as { attempt: number } | undefined)?.attempt ?? 0;
  }
}
