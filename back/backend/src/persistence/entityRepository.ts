import type Database from "better-sqlite3";
import type { Address, EntityRecord, Hex, TreasuryConfig } from "../types";

export interface EventRow {
  step: string;
  status: string;
  txHash: string | null;
  detail: string | null;
  createdAt: string;
}

export interface EntityRepository {
  upsert(record: EntityRecord): void;
  /**
   * Atomically claim an idempotency key by inserting the row only if absent (`ON CONFLICT DO NOTHING`).
   * Returns true if this caller won the claim, false if the key was already owned by another runner.
   * Unlike `upsert` (which resolves a conflict via DO UPDATE), this rejects a conflict — the primitive
   * that makes the key a cross-process mutex before any on-chain side effect.
   */
  claimKey(record: EntityRecord): boolean;
  findByIdempotencyKey(key: string): EntityRecord | undefined;
  findByAgentId(agentId: string): EntityRecord | undefined;
  findByTreasury(treasury: string): EntityRecord | undefined;
  list(): EntityRecord[];
  recordEvent(
    key: string,
    step: string,
    status: string,
    txHash: string | null,
    detail: string | null,
  ): void;
  listEvents(key: string): EventRow[];
  listByTenant(tenantId: string): EntityRecord[];
  listInFlight(): EntityRecord[];
  /** Run fn inside a single SQLite transaction (atomic; rolls back if fn throws). */
  transaction<T>(fn: () => T): T;
}

interface Row {
  idempotency_key: string;
  name: string;
  status: EntityRecord["status"];
  manager: string;
  guardian: string;
  operator: string | null;
  turnkey_sub_org_id: string | null;
  turnkey_wallet_id: string | null;
  owner_tenant_id: string | null;
  error: string | null;
  spec_json: string | null;
  amendment_delay: string;
  ein: string;
  formation_date: number;
  oa_hash: string | null;
  metadata_uri: string | null;
  doc_path: string | null;
  treasury_config: string | null;
  agent_id: string | null;
  proxy: string | null;
  treasury: string | null;
  create_tx_hash: string | null;
  bind_tx_hash: string | null;
  fund_tx_hash: string | null;
}

function serializeTreasury(tc: TreasuryConfig | null): string | null {
  if (!tc) return null;
  return JSON.stringify({ ...tc, cap: tc.cap.toString(), period: tc.period.toString() });
}
function deserializeTreasury(s: string | null): TreasuryConfig | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return {
      usdc: o.usdc,
      payoutAddress: o.payoutAddress,
      cap: BigInt(o.cap),
      period: BigInt(o.period),
      allowlistEnabled: o.allowlistEnabled,
    };
  } catch (e) {
    // Surface which column is corrupt instead of a bare SyntaxError/TypeError deep in a stack.
    throw new Error(`Failed to deserialize treasury_config: ${(e as Error).message}`, { cause: e });
  }
}
function toRecord(r: Row): EntityRecord {
  return {
    idempotencyKey: r.idempotency_key,
    name: r.name,
    status: r.status,
    manager: r.manager as Address,
    guardian: r.guardian as Address,
    operator: (r.operator as Address) ?? null,
    amendmentDelay: r.amendment_delay,
    ein: r.ein,
    formationDate: r.formation_date,
    oaHash: (r.oa_hash as Hex) ?? null,
    metadataURI: r.metadata_uri,
    docPath: r.doc_path,
    treasuryConfig: deserializeTreasury(r.treasury_config),
    agentId: r.agent_id,
    proxy: (r.proxy as Address) ?? null,
    treasury: (r.treasury as Address) ?? null,
    createTxHash: (r.create_tx_hash as Hex) ?? null,
    bindTxHash: (r.bind_tx_hash as Hex) ?? null,
    fundTxHash: (r.fund_tx_hash as Hex) ?? null,
    turnkeySubOrgId: r.turnkey_sub_org_id ?? undefined,
    turnkeyWalletId: r.turnkey_wallet_id ?? undefined,
    ownerTenantId: r.owner_tenant_id ?? undefined,
    error: r.error ?? null,
    specJson: r.spec_json ?? null,
  };
}

export class SqliteEntityRepository implements EntityRepository {
  constructor(private readonly db: Database.Database) {}

  /** Map an EntityRecord to the named bind params shared by the INSERT in upsert/claimKey. */
  private static bindings(rec: EntityRecord) {
    return {
      idempotency_key: rec.idempotencyKey,
      name: rec.name,
      status: rec.status,
      manager: rec.manager,
      guardian: rec.guardian,
      operator: rec.operator,
      turnkey_sub_org_id: rec.turnkeySubOrgId ?? null,
      turnkey_wallet_id: rec.turnkeyWalletId ?? null,
      owner_tenant_id: rec.ownerTenantId ?? null,
      error: rec.error ?? null,
      spec_json: rec.specJson ?? null,
      amendment_delay: rec.amendmentDelay,
      ein: rec.ein,
      formation_date: rec.formationDate,
      oa_hash: rec.oaHash,
      metadata_uri: rec.metadataURI,
      doc_path: rec.docPath,
      treasury_config: serializeTreasury(rec.treasuryConfig),
      agent_id: rec.agentId,
      proxy: rec.proxy,
      treasury: rec.treasury,
      create_tx_hash: rec.createTxHash,
      bind_tx_hash: rec.bindTxHash,
      fund_tx_hash: rec.fundTxHash,
    };
  }

  private static readonly INSERT_COLUMNS = `
        idempotency_key, name, status, manager, guardian, operator,
        turnkey_sub_org_id, turnkey_wallet_id,
        owner_tenant_id, error, spec_json,
        amendment_delay,
        ein, formation_date, oa_hash, metadata_uri, doc_path, treasury_config,
        agent_id, proxy, treasury, create_tx_hash, bind_tx_hash, fund_tx_hash, updated_at`;

  private static readonly INSERT_VALUES = `
        @idempotency_key, @name, @status, @manager, @guardian, @operator,
        @turnkey_sub_org_id, @turnkey_wallet_id,
        @owner_tenant_id, @error, @spec_json,
        @amendment_delay,
        @ein, @formation_date, @oa_hash, @metadata_uri, @doc_path, @treasury_config,
        @agent_id, @proxy, @treasury, @create_tx_hash, @bind_tx_hash, @fund_tx_hash, CURRENT_TIMESTAMP`;

  upsert(rec: EntityRecord): void {
    this.db
      .prepare(`
        INSERT INTO entities (${SqliteEntityRepository.INSERT_COLUMNS})
        VALUES (${SqliteEntityRepository.INSERT_VALUES})
        ON CONFLICT(idempotency_key) DO UPDATE SET
          name=excluded.name, status=excluded.status, manager=excluded.manager,
          guardian=excluded.guardian, operator=excluded.operator,
          turnkey_sub_org_id=excluded.turnkey_sub_org_id,
          turnkey_wallet_id=excluded.turnkey_wallet_id,
          owner_tenant_id=excluded.owner_tenant_id, error=excluded.error, spec_json=excluded.spec_json,
          amendment_delay=excluded.amendment_delay, ein=excluded.ein,
          formation_date=excluded.formation_date, oa_hash=excluded.oa_hash,
          metadata_uri=excluded.metadata_uri, doc_path=excluded.doc_path,
          treasury_config=excluded.treasury_config, agent_id=excluded.agent_id,
          proxy=excluded.proxy, treasury=excluded.treasury,
          create_tx_hash=excluded.create_tx_hash, bind_tx_hash=excluded.bind_tx_hash,
          fund_tx_hash=excluded.fund_tx_hash, updated_at=CURRENT_TIMESTAMP
      `)
      .run(SqliteEntityRepository.bindings(rec));
  }

  claimKey(rec: EntityRecord): boolean {
    const info = this.db
      .prepare(`
        INSERT INTO entities (${SqliteEntityRepository.INSERT_COLUMNS})
        VALUES (${SqliteEntityRepository.INSERT_VALUES})
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .run(SqliteEntityRepository.bindings(rec));
    // changes === 1 -> we inserted (won the claim); 0 -> the key already existed (another owner).
    return info.changes === 1;
  }

  findByIdempotencyKey(key: string): EntityRecord | undefined {
    const r = this.db.prepare("SELECT * FROM entities WHERE idempotency_key = ?").get(key) as
      | Row
      | undefined;
    return r ? toRecord(r) : undefined;
  }

  findByAgentId(agentId: string): EntityRecord | undefined {
    const r = this.db.prepare("SELECT * FROM entities WHERE agent_id = ?").get(agentId) as
      | Row
      | undefined;
    return r ? toRecord(r) : undefined;
  }

  findByTreasury(treasury: string): EntityRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM entities WHERE treasury = ? COLLATE NOCASE")
      .get(treasury) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  list(): EntityRecord[] {
    // Order by rowid (insertion order): deterministic and immune to same-second created_at ties.
    return (this.db.prepare("SELECT * FROM entities ORDER BY rowid").all() as Row[]).map(toRecord);
  }

  recordEvent(
    key: string,
    step: string,
    status: string,
    txHash: string | null,
    detail: string | null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (idempotency_key, step, status, tx_hash, detail) VALUES (?,?,?,?,?)",
      )
      .run(key, step, status, txHash, detail);
  }

  listEvents(key: string): EventRow[] {
    return this.db
      .prepare(
        "SELECT step, status, tx_hash as txHash, detail, created_at as createdAt FROM events WHERE idempotency_key = ? ORDER BY id",
      )
      .all(key) as EventRow[];
  }

  listByTenant(tenantId: string): EntityRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM entities WHERE owner_tenant_id = ? ORDER BY rowid")
        .all(tenantId) as Row[]
    ).map(toRecord);
  }

  listInFlight(): EntityRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM entities WHERE status IN ('pending','provisioned','translating','created') ORDER BY rowid",
        )
        .all() as Row[]
    ).map(toRecord);
  }

  /** Run fn inside a single SQLite transaction (atomic; rolls back if fn throws). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
