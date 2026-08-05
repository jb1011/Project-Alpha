import type Database from "better-sqlite3";
import type { Hex } from "../types";

/**
 * Tier-0 circle-bridge saga persistence (spec 2026-08-03, audit item 3).
 *
 * One funding bridge = three ordered legs sharing a `bridgeKey`:
 *   fund_operator  — SCA calls treasury.fundOperator(amount)
 *   approve        — SCA approves GatewayWallet for exactly `amount` (exact-approve policy)
 *   deposit_for    — SCA calls GatewayWallet.depositFor(usdc, pocket, amount)
 *
 * All three rows are created up-front in one transaction, so "is a bridge in flight for this
 * entity?" is a single indexed query (any leg not `confirmed`). `attempt` feeds the deterministic
 * Circle idempotency key (bridgeKey:leg:attempt): a FAILED/DENIED Circle tx burns its key, so a
 * retry MUST bump the attempt — reusing the key would replay the original failed response forever.
 */
export type BridgeLegName = "fund_operator" | "approve" | "deposit_for";
export type BridgeLegState = "pending" | "submitted" | "confirmed" | "failed";

export const BRIDGE_LEG_ORDER: readonly BridgeLegName[] = [
  "fund_operator",
  "approve",
  "deposit_for",
] as const;

export interface BridgeLegRecord {
  bridgeKey: string;
  leg: BridgeLegName;
  entityKey: string;
  amount: bigint;
  attempt: number;
  circleTxId: string | null;
  txHash: Hex | null;
  state: BridgeLegState;
  error: string | null;
}

interface Row {
  bridge_key: string;
  leg: BridgeLegName;
  entity_key: string;
  amount: string;
  attempt: number;
  circle_tx_id: string | null;
  tx_hash: string | null;
  state: BridgeLegState;
  error: string | null;
}

function toRecord(r: Row): BridgeLegRecord {
  return {
    bridgeKey: r.bridge_key,
    leg: r.leg,
    entityKey: r.entity_key,
    amount: BigInt(r.amount),
    attempt: r.attempt,
    circleTxId: r.circle_tx_id,
    txHash: (r.tx_hash as Hex) ?? null,
    state: r.state,
    error: r.error,
  };
}

export class SqliteBridgeLegRepository {
  constructor(private readonly db: Database.Database) {}

  /** Create all three legs of a new bridge atomically (state `pending`). */
  createBridge(bridgeKey: string, entityKey: string, amount: bigint): void {
    const insert = this.db.prepare(
      `INSERT INTO bridge_legs (bridge_key, leg, entity_key, amount, state)
       VALUES (?, ?, ?, ?, 'pending')`,
    );
    this.db.transaction(() => {
      for (const leg of BRIDGE_LEG_ORDER) insert.run(bridgeKey, leg, entityKey, amount.toString());
    })();
  }

  /** All legs of one bridge, in saga order. */
  legsOf(bridgeKey: string): BridgeLegRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM bridge_legs WHERE bridge_key = ?")
      .all(bridgeKey) as Row[];
    const byLeg = new Map(rows.map((r) => [r.leg, toRecord(r)]));
    return BRIDGE_LEG_ORDER.map((leg) => byLeg.get(leg)).filter(
      (r): r is BridgeLegRecord => r !== undefined,
    );
  }

  /** The entity's in-flight bridge (any leg not yet confirmed), if one exists. At most one can be
   *  incomplete because the bridge runner refuses to start a new bridge while one is open. */
  findIncomplete(entityKey: string): BridgeLegRecord[] | undefined {
    const row = this.db
      .prepare(
        `SELECT DISTINCT bridge_key FROM bridge_legs
         WHERE entity_key = ? AND state != 'confirmed' LIMIT 1`,
      )
      .get(entityKey) as { bridge_key: string } | undefined;
    return row ? this.legsOf(row.bridge_key) : undefined;
  }

  markSubmitted(bridgeKey: string, leg: BridgeLegName, circleTxId: string): void {
    this.db
      .prepare(
        `UPDATE bridge_legs SET state = 'submitted', circle_tx_id = ?, error = NULL,
         updated_at = CURRENT_TIMESTAMP WHERE bridge_key = ? AND leg = ?`,
      )
      .run(circleTxId, bridgeKey, leg);
  }

  markConfirmed(bridgeKey: string, leg: BridgeLegName, txHash: Hex): void {
    this.db
      .prepare(
        `UPDATE bridge_legs SET state = 'confirmed', tx_hash = ?, error = NULL,
         updated_at = CURRENT_TIMESTAMP WHERE bridge_key = ? AND leg = ?`,
      )
      .run(txHash, bridgeKey, leg);
  }

  markFailed(bridgeKey: string, leg: BridgeLegName, error: string): void {
    this.db
      .prepare(
        `UPDATE bridge_legs SET state = 'failed', error = ?,
         updated_at = CURRENT_TIMESTAMP WHERE bridge_key = ? AND leg = ?`,
      )
      .run(error, bridgeKey, leg);
  }

  /** A failed Circle tx burned its idempotency key — bump the attempt so the retry derives a fresh
   *  one, and reset the leg to pending. Returns the new attempt number. */
  bumpAttempt(bridgeKey: string, leg: BridgeLegName): number {
    this.db
      .prepare(
        `UPDATE bridge_legs SET attempt = attempt + 1, state = 'pending', circle_tx_id = NULL,
         updated_at = CURRENT_TIMESTAMP WHERE bridge_key = ? AND leg = ?`,
      )
      .run(bridgeKey, leg);
    const row = this.db
      .prepare("SELECT attempt FROM bridge_legs WHERE bridge_key = ? AND leg = ?")
      .get(bridgeKey, leg) as { attempt: number };
    return row.attempt;
  }
}
