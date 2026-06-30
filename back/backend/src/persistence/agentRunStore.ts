import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface RunPaymentInput {
  direction: "buy" | "sell";
  counterparty: string;
  amount: string;
  transferId: string | null;
  status: "settled" | "failed" | "pending";
}
export interface RunInput {
  entityKey: string;
  query: string;
  cost: string;
  revenue: string;
  pnl: string;
  status: "completed" | "failed";
}
export interface RunView extends RunInput {
  id: string;
  createdAt: number;
  payments: RunPaymentInput[];
}
export interface AgentRunStore {
  record(run: RunInput, payments: RunPaymentInput[]): string;
  listByEntity(entityKey: string): RunView[];
}

/** Per-run "job receipts" (cost/revenue/P&L) + their individual x402 payments. */
export class SqliteAgentRunStore implements AgentRunStore {
  constructor(private readonly db: Database.Database) {}

  record(run: RunInput, payments: RunPaymentInput[]): string {
    const id = randomUUID();
    const insertRun = this.db.prepare(
      "INSERT INTO agent_runs (id, entity_key, query, cost, revenue, pnl, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    const insertPay = this.db.prepare(
      "INSERT INTO run_payments (run_id, direction, counterparty, amount, transfer_id, status) VALUES (?,?,?,?,?,?)",
    );
    this.db.transaction(() => {
      insertRun.run(
        id,
        run.entityKey,
        run.query,
        run.cost,
        run.revenue,
        run.pnl,
        run.status,
        Math.floor(Date.now() / 1000),
      );
      for (const p of payments)
        insertPay.run(id, p.direction, p.counterparty, p.amount, p.transferId, p.status);
    })();
    return id;
  }

  listByEntity(entityKey: string): RunView[] {
    const runs = this.db
      .prepare(
        "SELECT id, entity_key AS entityKey, query, cost, revenue, pnl, status, created_at AS createdAt FROM agent_runs WHERE entity_key = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(entityKey) as Omit<RunView, "payments">[];
    const payStmt = this.db.prepare(
      "SELECT direction, counterparty, amount, transfer_id AS transferId, status FROM run_payments WHERE run_id = ? ORDER BY id",
    );
    return runs.map((r) => ({ ...r, payments: payStmt.all(r.id) as RunPaymentInput[] }));
  }
}
