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
  findByPublicId(publicId: string): EntityRecord | undefined;
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
  /** Total atomic USDC ever moved platform->treasuries for this tenant (successful funds only). */
  sumFundedByTenant(tenantId: string): bigint;
  /** Entities with an on-chain ERC-8004 identity that finished the on-chain leg of onboarding
   *  (created/bound/funded) — the rows the public transparency surface may enumerate. Selected
   *  directly (not via EntityRecord) because the surface needs created_at, which toRecord does
   *  not map. idempotencyKey/ownerTenantId are for server-side joins only — never serve them. */
  listPublicOnChain(): PublicEntityRow[];
}

export interface PublicEntityRow {
  idempotencyKey: string;
  publicId: string | null;
  name: string;
  status: EntityRecord["status"];
  agentId: string;
  proxy: string | null;
  treasury: string | null;
  walletProvider: EntityRecord["walletProvider"];
  ownerTenantId: string | null;
  createdAt: string | null;
  /** Formation pin (design §8). The PROVIDER and its ENVIRONMENT only — the honesty invariant
   *  reaches the public surface, so a sandbox filing is labeled as one there too. No EIN, no
   *  filing number, and never anything from `formation_parties`. */
  formationProvider: string | null;
  formationEnvironment: EntityRecord["formationEnvironment"];
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
  per_tx_cap: string | null;
  trust_policy: string | null;
  root_passkey_id: string | null;
  wallet_provider: string | null;
  circle_wallet_set_id: string | null;
  circle_operator_wallet_id: string | null;
  circle_pocket_wallet_id: string | null;
  pocket_address: string | null;
  previous_operator: string | null;
  operator_rotated_at: number | null;
  public_id: string | null;
  formation_provider: string | null;
  formation_environment: string | null;
  ein_real: string | null;
  formation_filed_at: number | null;
  formation_filing_number: string | null;
  oa_manifest_version: number | null;
  oa_manifest_anchored_hash: string | null;
  oa_manifest_pending_hash: string | null;
  oa_amendment_executable_at: number | null;
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
    perTxCap: r.per_tx_cap ? BigInt(r.per_tx_cap) : null,
    trustPolicy: (r.trust_policy as EntityRecord["trustPolicy"]) ?? null,
    rootPasskeyId: r.root_passkey_id ?? null,
    walletProvider: (r.wallet_provider as EntityRecord["walletProvider"]) ?? null,
    circleWalletSetId: r.circle_wallet_set_id ?? null,
    circleOperatorWalletId: r.circle_operator_wallet_id ?? null,
    circlePocketWalletId: r.circle_pocket_wallet_id ?? null,
    pocketAddress: r.pocket_address ?? null,
    previousOperator: r.previous_operator ?? null,
    operatorRotatedAt: r.operator_rotated_at ?? null,
    publicId: r.public_id ?? null,
    formationProvider: r.formation_provider ?? null,
    formationEnvironment: (r.formation_environment as EntityRecord["formationEnvironment"]) ?? null,
    einReal: r.ein_real ?? null,
    formationFiledAt: r.formation_filed_at ?? null,
    formationFilingNumber: r.formation_filing_number ?? null,
    oaManifestVersion: r.oa_manifest_version ?? null,
    oaManifestAnchoredHash: (r.oa_manifest_anchored_hash as Hex) ?? null,
    oaManifestPendingHash: (r.oa_manifest_pending_hash as Hex) ?? null,
    oaAmendmentExecutableAt: r.oa_amendment_executable_at ?? null,
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
      per_tx_cap: rec.perTxCap?.toString() ?? null,
      trust_policy: rec.trustPolicy ?? null,
      root_passkey_id: rec.rootPasskeyId ?? null,
      wallet_provider: rec.walletProvider ?? null,
      circle_wallet_set_id: rec.circleWalletSetId ?? null,
      circle_operator_wallet_id: rec.circleOperatorWalletId ?? null,
      circle_pocket_wallet_id: rec.circlePocketWalletId ?? null,
      pocket_address: rec.pocketAddress ?? null,
      previous_operator: rec.previousOperator ?? null,
      operator_rotated_at: rec.operatorRotatedAt ?? null,
      public_id: rec.publicId ?? null,
      formation_provider: rec.formationProvider ?? null,
      formation_environment: rec.formationEnvironment ?? null,
      ein_real: rec.einReal ?? null,
      formation_filed_at: rec.formationFiledAt ?? null,
      formation_filing_number: rec.formationFilingNumber ?? null,
      oa_manifest_version: rec.oaManifestVersion ?? null,
      oa_manifest_anchored_hash: rec.oaManifestAnchoredHash ?? null,
      oa_manifest_pending_hash: rec.oaManifestPendingHash ?? null,
      oa_amendment_executable_at: rec.oaAmendmentExecutableAt ?? null,
    };
  }

  private static readonly INSERT_COLUMNS = `
        idempotency_key, name, status, manager, guardian, operator,
        turnkey_sub_org_id, turnkey_wallet_id,
        owner_tenant_id, error, spec_json,
        amendment_delay,
        ein, formation_date, oa_hash, metadata_uri, doc_path, treasury_config,
        agent_id, proxy, treasury, create_tx_hash, bind_tx_hash, fund_tx_hash, per_tx_cap, trust_policy, root_passkey_id, wallet_provider, circle_wallet_set_id, circle_operator_wallet_id, circle_pocket_wallet_id, pocket_address, previous_operator, operator_rotated_at, public_id,
        formation_provider, formation_environment, ein_real, formation_filed_at, formation_filing_number,
        oa_manifest_version, oa_manifest_anchored_hash, oa_manifest_pending_hash, oa_amendment_executable_at,
        updated_at`;

  private static readonly INSERT_VALUES = `
        @idempotency_key, @name, @status, @manager, @guardian, @operator,
        @turnkey_sub_org_id, @turnkey_wallet_id,
        @owner_tenant_id, @error, @spec_json,
        @amendment_delay,
        @ein, @formation_date, @oa_hash, @metadata_uri, @doc_path, @treasury_config,
        @agent_id, @proxy, @treasury, @create_tx_hash, @bind_tx_hash, @fund_tx_hash, @per_tx_cap, @trust_policy, @root_passkey_id, @wallet_provider, @circle_wallet_set_id, @circle_operator_wallet_id, @circle_pocket_wallet_id, @pocket_address, @previous_operator, @operator_rotated_at, @public_id,
        @formation_provider, @formation_environment, @ein_real, @formation_filed_at, @formation_filing_number,
        @oa_manifest_version, @oa_manifest_anchored_hash, @oa_manifest_pending_hash, @oa_amendment_executable_at,
        CURRENT_TIMESTAMP`;

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
          fund_tx_hash=excluded.fund_tx_hash, public_id=excluded.public_id,
          per_tx_cap=excluded.per_tx_cap, trust_policy=excluded.trust_policy, root_passkey_id=excluded.root_passkey_id, wallet_provider=excluded.wallet_provider, circle_wallet_set_id=excluded.circle_wallet_set_id, circle_operator_wallet_id=excluded.circle_operator_wallet_id, circle_pocket_wallet_id=excluded.circle_pocket_wallet_id, pocket_address=excluded.pocket_address, previous_operator=excluded.previous_operator, operator_rotated_at=excluded.operator_rotated_at,
          formation_provider=excluded.formation_provider, formation_environment=excluded.formation_environment,
          ein_real=excluded.ein_real, formation_filed_at=excluded.formation_filed_at,
          formation_filing_number=excluded.formation_filing_number,
          oa_manifest_version=excluded.oa_manifest_version,
          oa_manifest_anchored_hash=excluded.oa_manifest_anchored_hash,
          oa_manifest_pending_hash=excluded.oa_manifest_pending_hash,
          oa_amendment_executable_at=excluded.oa_amendment_executable_at,
          updated_at=CURRENT_TIMESTAMP
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

  findByPublicId(publicId: string): EntityRecord | undefined {
    const r = this.db.prepare("SELECT * FROM entities WHERE public_id = ?").get(publicId) as
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

  /** Total atomic USDC ever moved platform->treasuries for this tenant (successful funds only). */
  sumFundedByTenant(tenantId: string): bigint {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(CAST(json_extract(e.detail, '$.amount') AS INTEGER)), 0) AS total
        FROM events e JOIN entities t ON t.idempotency_key = e.idempotency_key
        WHERE e.step = 'fundTreasury' AND e.status = 'funded' AND t.owner_tenant_id = ?
      `)
      .get(tenantId) as { total: number | bigint };
    return BigInt(row.total);
  }

  listPublicOnChain(): PublicEntityRow[] {
    // Newest first: the transparency page leads with the latest entities.
    return this.db
      .prepare(`
        SELECT idempotency_key AS idempotencyKey, public_id AS publicId, name, status,
               agent_id AS agentId, proxy, treasury, wallet_provider AS walletProvider,
               owner_tenant_id AS ownerTenantId, created_at AS createdAt,
               formation_provider AS formationProvider,
               formation_environment AS formationEnvironment
        FROM entities
        WHERE agent_id IS NOT NULL AND status IN ('created','bound','funded')
        ORDER BY rowid DESC
      `)
      .all() as PublicEntityRow[];
  }
}
