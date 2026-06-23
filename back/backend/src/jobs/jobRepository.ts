import type Database from "better-sqlite3";
import type { JobRecord, JobStatus } from "./types";

export interface JobRepository {
  upsert(r: JobRecord): void;
  findByKey(k: string): JobRecord | undefined;
  list(): JobRecord[];
  listByEntity(entityKey: string): JobRecord[];
  listByTenant(tenantId: string): JobRecord[];
  listInFlight(): JobRecord[];
  recordEvent(
    jobKey: string,
    step: string,
    status: string,
    txHash: string | null,
    detail: string | null,
  ): void;
  transaction<T>(fn: () => T): T;
}

interface Row {
  job_key: string;
  job_id: string | null;
  entity_key: string;
  owner_tenant_id: string | null;
  status: JobStatus;
  client_address: string;
  evaluator_address: string;
  provider_address: string;
  budget_amount: string;
  description: string;
  deliverable_hash: string | null;
  deliverable_path: string | null;
  create_tx_hash: string | null;
  fund_tx_hash: string | null;
  submit_tx_hash: string | null;
  complete_tx_hash: string | null;
  sweep_tx_hash: string | null;
  reputation_tx_hash: string | null;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function toRecord(r: Row): JobRecord {
  return {
    jobKey: r.job_key,
    jobId: r.job_id,
    entityKey: r.entity_key,
    ownerTenantId: r.owner_tenant_id ?? undefined,
    status: r.status,
    clientAddress: r.client_address as JobRecord["clientAddress"],
    evaluatorAddress: r.evaluator_address as JobRecord["evaluatorAddress"],
    providerAddress: r.provider_address as JobRecord["providerAddress"],
    budgetAmount: r.budget_amount,
    description: r.description,
    deliverableHash: r.deliverable_hash,
    deliverablePath: r.deliverable_path,
    createTxHash: r.create_tx_hash as JobRecord["createTxHash"],
    fundTxHash: r.fund_tx_hash as JobRecord["fundTxHash"],
    submitTxHash: r.submit_tx_hash as JobRecord["submitTxHash"],
    completeTxHash: r.complete_tx_hash as JobRecord["completeTxHash"],
    sweepTxHash: r.sweep_tx_hash as JobRecord["sweepTxHash"],
    reputationTxHash: r.reputation_tx_hash as JobRecord["reputationTxHash"],
    error: r.error ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(rec: JobRecord): void {
    this.db
      .prepare(`
        INSERT INTO jobs (
          job_key, job_id, entity_key, owner_tenant_id, status,
          client_address, evaluator_address, provider_address,
          budget_amount, description,
          deliverable_hash, deliverable_path,
          create_tx_hash, fund_tx_hash, submit_tx_hash, complete_tx_hash, sweep_tx_hash, reputation_tx_hash,
          error, updated_at
        ) VALUES (
          @job_key, @job_id, @entity_key, @owner_tenant_id, @status,
          @client_address, @evaluator_address, @provider_address,
          @budget_amount, @description,
          @deliverable_hash, @deliverable_path,
          @create_tx_hash, @fund_tx_hash, @submit_tx_hash, @complete_tx_hash, @sweep_tx_hash, @reputation_tx_hash,
          @error, CURRENT_TIMESTAMP
        )
        ON CONFLICT(job_key) DO UPDATE SET
          job_id=excluded.job_id,
          entity_key=excluded.entity_key,
          owner_tenant_id=excluded.owner_tenant_id,
          status=excluded.status,
          client_address=excluded.client_address,
          evaluator_address=excluded.evaluator_address,
          provider_address=excluded.provider_address,
          budget_amount=excluded.budget_amount,
          description=excluded.description,
          deliverable_hash=excluded.deliverable_hash,
          deliverable_path=excluded.deliverable_path,
          create_tx_hash=excluded.create_tx_hash,
          fund_tx_hash=excluded.fund_tx_hash,
          submit_tx_hash=excluded.submit_tx_hash,
          complete_tx_hash=excluded.complete_tx_hash,
          sweep_tx_hash=excluded.sweep_tx_hash,
          reputation_tx_hash=excluded.reputation_tx_hash,
          error=excluded.error,
          updated_at=CURRENT_TIMESTAMP
      `)
      .run({
        job_key: rec.jobKey,
        job_id: rec.jobId ?? null,
        entity_key: rec.entityKey,
        owner_tenant_id: rec.ownerTenantId ?? null,
        status: rec.status,
        client_address: rec.clientAddress,
        evaluator_address: rec.evaluatorAddress,
        provider_address: rec.providerAddress,
        budget_amount: rec.budgetAmount,
        description: rec.description,
        deliverable_hash: rec.deliverableHash,
        deliverable_path: rec.deliverablePath,
        create_tx_hash: rec.createTxHash,
        fund_tx_hash: rec.fundTxHash,
        submit_tx_hash: rec.submitTxHash,
        complete_tx_hash: rec.completeTxHash,
        sweep_tx_hash: rec.sweepTxHash,
        reputation_tx_hash: rec.reputationTxHash,
        error: rec.error ?? null,
      });
  }

  findByKey(k: string): JobRecord | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE job_key = ?").get(k) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  list(): JobRecord[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY rowid").all() as Row[]).map(toRecord);
  }

  listByEntity(entityKey: string): JobRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE entity_key = ? ORDER BY rowid")
        .all(entityKey) as Row[]
    ).map(toRecord);
  }

  listByTenant(tenantId: string): JobRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE owner_tenant_id = ? ORDER BY rowid")
        .all(tenantId) as Row[]
    ).map(toRecord);
  }

  listInFlight(): JobRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE status NOT IN ('reputed','failed') ORDER BY rowid")
        .all() as Row[]
    ).map(toRecord);
  }

  recordEvent(
    jobKey: string,
    step: string,
    status: string,
    txHash: string | null,
    detail: string | null,
  ): void {
    this.db
      .prepare("INSERT INTO job_events (job_key, step, status, tx_hash, detail) VALUES (?,?,?,?,?)")
      .run(jobKey, step, status, txHash, detail);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
