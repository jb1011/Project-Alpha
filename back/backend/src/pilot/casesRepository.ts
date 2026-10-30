import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NewPilotCase, PilotCaseRecord, PilotMode, PilotStatus } from "./types";

/**
 * PILOT CASES: one row per Kleros pilot case, in `pilot_cases` and never in `jobs` (the boot
 * reconciliation and the escrow refund read `jobs` and would act on a pilot case).
 *
 * The row is the only memory of a case. Its status moves by compare-and-set (`advance`), so two
 * commands racing on one case cannot both file. The Kleros deployment that holds the dispute
 * (`kleros_chain`) is written once, by the `contested` to `filing` advance, and never changed:
 * a dispute id read on another deployment is somebody else's case.
 */
export interface PilotCaseRepository {
  /** Writes the row at status `created` and returns it. */
  insert(c: NewPilotCase): PilotCaseRecord;
  find(caseId: string): PilotCaseRecord | undefined;
  findByJobId(jobId: string): PilotCaseRecord | undefined;
  /** Newest first. */
  list(filter?: { mode?: PilotMode }): PilotCaseRecord[];
  /** Compare-and-set on status. Returns the row, or undefined only for a plain "not at `from`" miss.
   *  THROWS when the patch would change a set Kleros deployment column (kleros_chain,
   *  kleros_court_id, kleros_policy_uri), whether or not the row is at `from`. */
  advance(
    caseId: string,
    from: PilotStatus,
    to: PilotStatus,
    patch?: Partial<PilotCaseRecord>,
  ): PilotCaseRecord | undefined;
  /** A patch that leaves status alone. */
  patch(caseId: string, patch: Partial<PilotCaseRecord>): PilotCaseRecord;
  recordEvent(
    caseId: string,
    step: string,
    status: string,
    ref: string | null,
    detail: string | null,
  ): void;
  events(caseId: string): {
    step: string;
    status: string;
    ref: string | null;
    detail: string | null;
    createdAt: string;
  }[];
  /**
   * Rows of `mode` that count against that mode's cap: status in filing, filed, ruled, settling,
   * settled, filing_unknown, evidence_unknown, and failed rows whose filing started, since their
   * dispute exists or may exist whatever the row says, so failing one frees no slot.
   */
  countFiled(mode: PilotMode): number;
  /** Testnet rows at filed or later that carry a `seen_in_court` event: the gate before a live filing reads it. */
  countSeenInCourt(mode: PilotMode): number;
  transaction<T>(fn: () => T): T;
}

/** Every column but the key, the status and the timestamps, by field. `caseId`, `status`,
 *  `createdAt` and `updatedAt` are absent on purpose: the key never changes, status moves only by
 *  `advance`, and the timestamps are the database's. */
type PatchableField = Exclude<
  keyof PilotCaseRecord,
  "caseId" | "status" | "createdAt" | "updatedAt"
>;
const COLUMN_OF = {
  label: "label",
  mode: "mode",
  chainId: "chain_id",
  jobContract: "job_contract",
  jobId: "job_id",
  buyerAddress: "buyer_address",
  buyerAgentId: "buyer_agent_id",
  sellerAddress: "seller_address",
  sellerAgentId: "seller_agent_id",
  refereeAddress: "referee_address",
  budgetAtomic: "budget_atomic",
  description: "description",
  expiredAt: "expired_at",
  deliverablePath: "deliverable_path",
  deliverableHash: "deliverable_hash",
  deliverableExtension: "deliverable_extension",
  createTxHash: "create_tx_hash",
  fundTxHash: "fund_tx_hash",
  submitTxHash: "submit_tx_hash",
  createdBlockTime: "created_block_time",
  fundedBlockTime: "funded_block_time",
  submittedBlockTime: "submitted_block_time",
  contestReason: "contest_reason",
  contestReply: "contest_reply",
  contestedAt: "contested_at",
  buyerRecordPath: "buyer_record_path",
  sellerRecordPath: "seller_record_path",
  evidencePath: "evidence_path",
  evidenceSha256: "evidence_sha256",
  evidenceName: "evidence_name",
  klerosChain: "kleros_chain",
  klerosCourtId: "kleros_court_id",
  klerosPolicyUri: "kleros_policy_uri",
  attachmentUri: "attachment_uri",
  attachmentCid: "attachment_cid",
  filingStartedAt: "filing_started_at",
  coreDisputeId: "core_dispute_id",
  localDisputeId: "local_dispute_id",
  createDisputeTx: "create_dispute_tx",
  filedAt: "filed_at",
  evidenceTx: "evidence_tx",
  evidenceStatus: "evidence_status",
  rulingStatus: "ruling_status",
  rulingValue: "ruling_value",
  rulingTied: "ruling_tied",
  rulingRoundCount: "ruling_round_count",
  rulingLabel: "ruling_label",
  rulingReadAt: "ruling_read_at",
  rulingDeadline: "ruling_deadline",
  settleAction: "settle_action",
  settleReason: "settle_reason",
  settleTxHash: "settle_tx_hash",
  settledAt: "settled_at",
  escrowOutcome: "escrow_outcome",
  error: "error",
} as const satisfies Record<PatchableField, string>;

/** The case's identity, fixed at insert: a patch never writes these. A `mode` patch would move a
 *  row from one mode's cap to the other's, and the chain and contract name the job itself. */
const IDENTITY_FIELDS: ReadonlySet<string> = new Set(["mode", "chainId", "jobContract"]);

/** The Kleros deployment of the case, written together by the `contested` to `filing` advance.
 *  Once `kleros_chain` is set, none of the three changes: the deployment a case was filed on is part of its identity. */
const KLEROS_DEPLOYMENT_FIELDS = ["klerosChain", "klerosCourtId", "klerosPolicyUri"] as const;

/** The row as SQLite returns it: one property per column, snake_case. */
type Row = Record<string, unknown>;

function toRecord(r: Row): PilotCaseRecord {
  const rec: Record<string, unknown> = {
    caseId: r.case_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  for (const [field, column] of Object.entries(COLUMN_OF)) rec[field] = r[column];
  return rec as unknown as PilotCaseRecord;
}

/** The statuses that count against a mode's cap: every status from `filing` on, and the two
 *  in-doubt exits. `failed` is not among them: it is an error before any money moved. */
export const PILOT_FILED_STATUSES: readonly PilotStatus[] = Object.freeze([
  "filing",
  "filed",
  "ruled",
  "settling",
  "settled",
  "filing_unknown",
  "evidence_unknown",
]);
/** Filed or later: the dispute exists. `filing` and `filing_unknown` are before it is known to. */
export const PILOT_FILED_OR_LATER_STATUSES: readonly PilotStatus[] = Object.freeze([
  "filed",
  "ruled",
  "settling",
  "settled",
  "evidence_unknown",
]);
/** A status list as an SQL `IN` list. The statuses are the fixed words above, never input. */
const sqlList = (statuses: readonly PilotStatus[]) =>
  `(${statuses.map((s) => `'${s}'`).join(",")})`;
const FILED_STATUSES_SQL = sqlList(PILOT_FILED_STATUSES);
const FILED_OR_LATER_SQL = sqlList(PILOT_FILED_OR_LATER_STATUSES);

export class SqlitePilotCaseRepository implements PilotCaseRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO pilot_cases
           (case_id, label, mode, status, chain_id, job_contract, buyer_address, buyer_agent_id,
            seller_address, seller_agent_id, referee_address, budget_atomic, description,
            expired_at, deliverable_path, deliverable_hash, deliverable_extension)
         VALUES (@case_id, @label, @mode, 'created', @chain_id, @job_contract, @buyer_address,
                 @buyer_agent_id, @seller_address, @seller_agent_id, @referee_address,
                 @budget_atomic, @description, @expired_at, @deliverable_path, @deliverable_hash,
                 @deliverable_extension)`,
      ),
      find: db.prepare("SELECT * FROM pilot_cases WHERE case_id = ?"),
      findByJobId: db.prepare("SELECT * FROM pilot_cases WHERE job_id = ?"),
      // created_at has one-second resolution; rowid breaks the tie in insertion order.
      listAll: db.prepare("SELECT * FROM pilot_cases ORDER BY created_at DESC, rowid DESC"),
      listByMode: db.prepare(
        "SELECT * FROM pilot_cases WHERE mode = ? ORDER BY created_at DESC, rowid DESC",
      ),
      insertEvent: db.prepare(
        "INSERT INTO pilot_case_events (case_id, step, status, ref, detail) VALUES (?, ?, ?, ?, ?)",
      ),
      events: db.prepare(
        "SELECT step, status, ref, detail, created_at FROM pilot_case_events WHERE case_id = ? ORDER BY id",
      ),
      countFiled: db
        .prepare(
          `SELECT COUNT(*) FROM pilot_cases WHERE mode = ? AND (status IN ${FILED_STATUSES_SQL} OR (status = 'failed' AND filing_started_at IS NOT NULL))`,
        )
        .pluck(),
      countSeenInCourt: db
        .prepare(
          `SELECT COUNT(*) FROM pilot_cases c
            WHERE c.mode = ? AND c.status IN ${FILED_OR_LATER_SQL}
              AND EXISTS (SELECT 1 FROM pilot_case_events e
                           WHERE e.case_id = c.case_id AND e.step = 'seen_in_court')`,
        )
        .pluck(),
    };
  }

  insert(c: NewPilotCase): PilotCaseRecord {
    this.stmts.insert.run({
      case_id: c.caseId,
      label: c.label,
      mode: c.mode,
      chain_id: c.chainId,
      job_contract: c.jobContract,
      buyer_address: c.buyerAddress,
      buyer_agent_id: c.buyerAgentId,
      seller_address: c.sellerAddress,
      seller_agent_id: c.sellerAgentId,
      referee_address: c.refereeAddress,
      budget_atomic: c.budgetAtomic,
      description: c.description,
      expired_at: c.expiredAt,
      deliverable_path: c.deliverablePath,
      deliverable_hash: c.deliverableHash,
      deliverable_extension: c.deliverableExtension,
    });
    return this.require(c.caseId);
  }

  find(caseId: string): PilotCaseRecord | undefined {
    const r = this.stmts.find.get(caseId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findByJobId(jobId: string): PilotCaseRecord | undefined {
    const r = this.stmts.findByJobId.get(jobId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  list(filter?: { mode?: PilotMode }): PilotCaseRecord[] {
    const rows =
      filter?.mode === undefined
        ? this.stmts.listAll.all()
        : this.stmts.listByMode.all(filter.mode);
    return (rows as Row[]).map(toRecord);
  }

  advance(
    caseId: string,
    from: PilotStatus,
    to: PilotStatus,
    patch: Partial<PilotCaseRecord> = {},
  ): PilotCaseRecord | undefined {
    return this.transaction(() => {
      const set = this.setClause(caseId, patch);
      const info = this.db
        .prepare(
          `UPDATE pilot_cases SET status = @to, ${set.sql}updated_at = CURRENT_TIMESTAMP
            WHERE case_id = @case_id AND status = @from`,
        )
        .run({ ...set.params, case_id: caseId, from, to });
      return info.changes === 1 ? this.require(caseId) : undefined;
    });
  }

  patch(caseId: string, patch: Partial<PilotCaseRecord>): PilotCaseRecord {
    return this.transaction(() => {
      this.require(caseId);
      const set = this.setClause(caseId, patch);
      this.db
        .prepare(
          `UPDATE pilot_cases SET ${set.sql}updated_at = CURRENT_TIMESTAMP WHERE case_id = @case_id`,
        )
        .run({ ...set.params, case_id: caseId });
      return this.require(caseId);
    });
  }

  recordEvent(
    caseId: string,
    step: string,
    status: string,
    ref: string | null,
    detail: string | null,
  ): void {
    // Stored as given. When `detail` comes from an exception, the caller passes it through
    // `publicErrorMessage` first: the case view serves this trail, and raw exception text can
    // carry a URL with a key in it.
    this.stmts.insertEvent.run(caseId, step, status, ref, detail);
  }

  events(caseId: string): {
    step: string;
    status: string;
    ref: string | null;
    detail: string | null;
    createdAt: string;
  }[] {
    return (
      this.stmts.events.all(caseId) as {
        step: string;
        status: string;
        ref: string | null;
        detail: string | null;
        created_at: string;
      }[]
    ).map((e) => ({
      step: e.step,
      status: e.status,
      ref: e.ref,
      detail: e.detail,
      createdAt: e.created_at,
    }));
  }

  countFiled(mode: PilotMode): number {
    return this.stmts.countFiled.get(mode) as number;
  }

  countSeenInCourt(mode: PilotMode): number {
    return this.stmts.countSeenInCourt.get(mode) as number;
  }

  transaction<T>(fn: () => T): T {
    // IMMEDIATE, as the legal-body repository does: the write lock is taken at the start, so a
    // read inside fn cannot go stale before its write. Nested, it is a savepoint of the outer one.
    // An outer transaction must be opened through repo.transaction to be IMMEDIATE: a caller's own
    // DEFERRED transaction does not take the lock.
    return this.db.transaction(fn).immediate();
  }

  private require(caseId: string): PilotCaseRecord {
    const rec = this.find(caseId);
    if (!rec) throw new Error(`pilot case ${caseId} not found`);
    return rec;
  }

  /**
   * The SET terms for a patch, each followed by a comma, with their named parameters. Refuses a
   * field outside `COLUMN_OF`, an identity field, and, once the row's `kleros_chain` is set, any
   * change to `kleros_chain`, `kleros_court_id` or `kleros_policy_uri`.
   * Must run inside `transaction`, so the row it compares against is the row the UPDATE writes.
   */
  private setClause(
    caseId: string,
    patch: Partial<PilotCaseRecord>,
  ): { sql: string; params: Record<string, unknown> } {
    let sql = "";
    const params: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!Object.hasOwn(COLUMN_OF, field) || IDENTITY_FIELDS.has(field))
        throw new Error(`a pilot case patch cannot set ${field}`);
      const column = COLUMN_OF[field as PatchableField];
      sql += `${column} = @${column}, `;
      params[column] = value;
    }
    if (KLEROS_DEPLOYMENT_FIELDS.some((f) => patch[f] !== undefined)) {
      const current = this.find(caseId);
      if (current !== undefined && current.klerosChain !== null)
        for (const f of KLEROS_DEPLOYMENT_FIELDS)
          if (patch[f] !== undefined && patch[f] !== current[f])
            throw new Error(
              `pilot case ${caseId}: ${COLUMN_OF[f]} is ${current[f]} and is never changed once kleros_chain is set (asked: ${patch[f]})`,
            );
    }
    return { sql, params };
  }
}

/** A new case id: "pc_" and 12 lower-case hex digits from a random UUID. */
export function newCaseId(): string {
  return `pc_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
