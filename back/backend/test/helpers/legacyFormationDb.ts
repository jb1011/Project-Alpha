import Database from "better-sqlite3";

/**
 * A GENUINE pre-migration database — the PR-4-era schema, frozen.
 *
 * The 2026-08-26 re-key is the one migration in this codebase that can destroy something
 * irreplaceable (the responsible party of a real Wyoming filing) or duplicate something expensive
 * (a second real LLC), so its tests must run against the shape that actually exists on the box,
 * not against a shape reconstructed by the code under test. This file is therefore a VERBATIM
 * copy of the relevant DDL as it stood before the migration — entity-keyed `formation_requests`,
 * `formation_parties` with no `company_id`, `documents` with its ALTER-added columns inline — and
 * it must never be "kept in sync" with `db.ts`. If it drifts, the fixtures stop proving anything.
 */
const LEGACY_SCHEMA = `
  CREATE TABLE entities (
    idempotency_key TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending','provisioned','translating','created','bound','funded','failed')),
    manager         TEXT NOT NULL,
    guardian        TEXT NOT NULL,
    operator        TEXT,
    turnkey_sub_org_id TEXT,
    turnkey_wallet_id  TEXT,
    owner_tenant_id    TEXT,
    error              TEXT,
    spec_json          TEXT,
    amendment_delay TEXT NOT NULL,
    ein             TEXT NOT NULL,
    formation_date  INTEGER NOT NULL,
    oa_hash         TEXT,
    metadata_uri    TEXT,
    doc_path        TEXT,
    treasury_config TEXT,
    agent_id        TEXT,
    proxy           TEXT,
    treasury        TEXT,
    create_tx_hash  TEXT,
    bind_tx_hash    TEXT,
    fund_tx_hash    TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    per_tx_cap TEXT, trust_policy TEXT, root_passkey_id TEXT,
    wallet_provider TEXT, circle_wallet_set_id TEXT, circle_operator_wallet_id TEXT,
    circle_pocket_wallet_id TEXT, pocket_address TEXT,
    previous_operator TEXT, operator_rotated_at INTEGER, public_id TEXT,
    formation_provider TEXT, formation_environment TEXT, ein_real TEXT,
    formation_filed_at INTEGER, formation_filing_number TEXT,
    oa_manifest_version INTEGER, oa_manifest_anchored_hash TEXT,
    oa_manifest_pending_hash TEXT, oa_amendment_executable_at INTEGER,
    oa_manifest_pending_version INTEGER
  );

  CREATE TABLE documents (
    id         TEXT PRIMARY KEY,
    oa_hash    TEXT,
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    entity_key TEXT, doc_type TEXT, sha256 TEXT, content_type TEXT, size INTEGER,
    provider_doc_id TEXT
  );
  CREATE UNIQUE INDEX idx_documents_entity_provider ON documents(entity_key, provider_doc_id);
  CREATE INDEX idx_documents_entity ON documents(entity_key);

  CREATE TABLE formation_requests (
    entity_key   TEXT NOT NULL,
    step         TEXT NOT NULL CHECK (step IN
                 ('create_provider','await_filing','fetch_documents','await_ein')),
    state        TEXT NOT NULL CHECK (state IN
                 ('pending','submitted','confirmed','failed','abandoned')),
    attempt      INTEGER NOT NULL DEFAULT 0,
    provider_ref TEXT,
    detail       TEXT,
    error        TEXT,
    next_poll_at INTEGER,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_key, step)
  );
  CREATE INDEX idx_formation_state ON formation_requests(state, step);
  CREATE INDEX idx_formation_provider ON formation_requests(provider_ref);
  CREATE INDEX idx_formation_poll_due ON formation_requests(next_poll_at, entity_key);

  CREATE TABLE formation_parties (
    party_id   TEXT PRIMARY KEY,
    entity_key TEXT UNIQUE,
    tenant_id  TEXT NOT NULL,
    legal_first_name TEXT, legal_last_name TEXT,
    email TEXT, phone TEXT,
    line1 TEXT, line2 TEXT, city TEXT,
    region TEXT,
    postal_code TEXT, country TEXT,
    synthetic INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  );
  CREATE INDEX idx_formation_parties_tenant ON formation_parties(tenant_id);

  CREATE TABLE oa_anchors (
    entity_key    TEXT NOT NULL,
    version       INTEGER NOT NULL,
    manifest_hash TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN
                  ('pending','scheduled','executed','vetoed','superseded','failed')),
    schedule_tx   TEXT, execute_tx TEXT,
    executable_at INTEGER,
    attempt       INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    retry_interval_ms INTEGER,
    next_retry_at     INTEGER,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_key, version)
  );
  CREATE INDEX idx_oa_anchors_state ON oa_anchors(state, entity_key, version);

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openLegacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(LEGACY_SCHEMA);
  return db;
}

/** Insert a pinned, formed-looking entity exactly as the pre-migration repository wrote one. */
export function legacyEntity(
  db: Database.Database,
  over: Partial<{
    key: string;
    name: string;
    tenant: string;
    provider: string | null;
    environment: string | null;
    filedAt: number | null;
    filingNumber: string | null;
    einReal: string | null;
    specJson: string | null;
    createdAt: string;
  }> = {},
): string {
  const key = over.key ?? "tenant-a:agent-1";
  db.prepare(
    `INSERT INTO entities (idempotency_key, name, status, manager, guardian, amendment_delay,
                           ein, formation_date, owner_tenant_id, spec_json,
                           formation_provider, formation_environment, ein_real,
                           formation_filed_at, formation_filing_number, created_at, updated_at)
     VALUES (@key, @name, 'funded', '0x01', '0x02', '86400', 'STUB', 0, @tenant, @spec,
             @provider, @environment, @ein, @filed_at, @filing_number, @created_at, @created_at)`,
  ).run({
    key,
    name: over.name ?? "Formation Agent",
    tenant: over.tenant ?? "tenant-a",
    spec: over.specJson ?? null,
    provider: over.provider === undefined ? "doola" : over.provider,
    environment: over.environment === undefined ? "sandbox" : over.environment,
    ein: over.einReal ?? null,
    filed_at: over.filedAt ?? null,
    filing_number: over.filingNumber ?? null,
    created_at: over.createdAt ?? "2026-08-01 10:00:00",
  });
  return key;
}

export function legacyParty(
  db: Database.Database,
  p: { partyId: string; entityKey: string | null; tenant?: string; createdAt?: string },
): void {
  db.prepare(
    `INSERT INTO formation_parties (party_id, entity_key, tenant_id, legal_first_name,
                                    legal_last_name, email, phone, line1, city, region,
                                    postal_code, country, created_at)
     VALUES (@party_id, @entity_key, @tenant, 'Ada', 'Lovelace', 'ada@example.com', '+13075550142',
             '30 N Gould St', 'Sheridan', 'WY', '82801', 'USA', @created_at)`,
  ).run({
    party_id: p.partyId,
    entity_key: p.entityKey,
    tenant: p.tenant ?? "tenant-a",
    created_at: p.createdAt ?? "2026-08-01 10:00:00",
  });
}

export function legacyStep(
  db: Database.Database,
  s: {
    entityKey: string;
    step: string;
    state: string;
    providerRef?: string | null;
    attempt?: number;
    detail?: string | null;
    updatedAt?: string;
    createdAt?: string;
    nextPollAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO formation_requests (entity_key, step, state, attempt, provider_ref, detail,
                                     next_poll_at, created_at, updated_at)
     VALUES (@entity_key, @step, @state, @attempt, @provider_ref, @detail, @next_poll_at,
             @created_at, @updated_at)`,
  ).run({
    entity_key: s.entityKey,
    step: s.step,
    state: s.state,
    attempt: s.attempt ?? 0,
    provider_ref: s.providerRef ?? null,
    detail: s.detail ?? null,
    next_poll_at: s.nextPollAt ?? null,
    created_at: s.createdAt ?? "2026-08-01 10:00:00",
    updated_at: s.updatedAt ?? "2026-08-02 11:22:33",
  });
}

export function legacyDocument(
  db: Database.Database,
  d: { id: string; entityKey: string; docType: string; providerDocId: string; sha256?: string },
): void {
  db.prepare(
    `INSERT INTO documents (id, path, entity_key, doc_type, sha256, content_type, size,
                            provider_doc_id)
     VALUES (@id, @path, @entity_key, @doc_type, @sha256, 'application/pdf', 1234, @provider)`,
  ).run({
    id: d.id,
    path: `doc-${d.id}.pdf`,
    entity_key: d.entityKey,
    doc_type: d.docType,
    sha256: d.sha256 ?? `sha-${d.providerDocId}`,
    provider: d.providerDocId,
  });
}
