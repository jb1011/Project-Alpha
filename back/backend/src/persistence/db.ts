import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/** Open (and create dirs for) a SQLite db. Use ":memory:" in tests. */
export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Create tables if absent. Idempotent. */
export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
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
      treasury_config TEXT,             -- JSON (bigints as decimal strings)
      agent_id        TEXT,             -- uint256 as decimal string
      proxy           TEXT,
      treasury        TEXT,
      create_tx_hash  TEXT,
      bind_tx_hash    TEXT,
      fund_tx_hash    TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_entities_agent_id ON entities(agent_id);

    -- Reserved for an optional DB-backed document index; v1 uses FileDocumentStore (filesystem).
    CREATE TABLE IF NOT EXISTS documents (
      id         TEXT PRIMARY KEY,
      oa_hash    TEXT,
      path       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      step            TEXT NOT NULL,
      status          TEXT NOT NULL,
      tx_hash         TEXT,
      detail          TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (idempotency_key) REFERENCES entities(idempotency_key)
    );

    -- Off-chain nanopayment spend-ledger: every payment the Payment Authority authorizes is recorded
    -- here so authorized-but-not-yet-settled amounts (runningPending) count against the treasury cap
    -- before the on-chain balance reflects them. amount is a bigint stored as a decimal string.
    CREATE TABLE IF NOT EXISTS payments_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      payee      TEXT NOT NULL,
      amount     TEXT NOT NULL,                -- bigint as decimal string
      status     TEXT NOT NULL CHECK (status IN ('authorized','settled','failed')),
      batch_ref  TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_payments_ledger_status ON payments_ledger(status);

    CREATE TABLE IF NOT EXISTS auth_nonces (
      nonce      TEXT PRIMARY KEY,
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      challenge TEXT PRIMARY KEY,
      owner_tenant TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      owner_tenant TEXT NOT NULL,
      hash         TEXT NOT NULL,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);

    CREATE TABLE IF NOT EXISTS passkeys (
      id           TEXT PRIMARY KEY,
      owner_tenant TEXT NOT NULL,
      name         TEXT,
      challenge    TEXT NOT NULL,
      attestation  TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_tenant ON passkeys(owner_tenant);

    CREATE TABLE IF NOT EXISTS jobs (
      job_key TEXT PRIMARY KEY,
      job_id TEXT,
      entity_key TEXT NOT NULL,
      owner_tenant_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','created','funded','submitted','completed','reputed','failed')),
      client_address TEXT NOT NULL,
      evaluator_address TEXT NOT NULL,
      provider_address TEXT NOT NULL,
      budget_amount TEXT NOT NULL,
      description TEXT NOT NULL,
      deliverable_hash TEXT, deliverable_path TEXT,
      create_tx_hash TEXT, fund_tx_hash TEXT, submit_tx_hash TEXT, complete_tx_hash TEXT, sweep_tx_hash TEXT, reputation_tx_hash TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (entity_key) REFERENCES entities(idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_key TEXT NOT NULL,
      step TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_key) REFERENCES jobs(job_key)
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id          TEXT PRIMARY KEY,
      entity_key  TEXT NOT NULL,
      query       TEXT NOT NULL,
      cost        TEXT NOT NULL,
      revenue     TEXT NOT NULL,
      pnl         TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('completed','failed')),
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_entity ON agent_runs(entity_key, created_at);

    CREATE TABLE IF NOT EXISTS run_payments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      direction    TEXT NOT NULL CHECK (direction IN ('buy','sell')),
      counterparty TEXT NOT NULL,
      amount       TEXT NOT NULL,
      transfer_id  TEXT,
      status       TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_payments_run ON run_payments(run_id);

    -- Payment idempotency: claims (key,tenant,entity) so a repeated pay call with the same
    -- idempotencyKey returns the original receipt instead of settling twice. receipt_json is
    -- NULL while the payment is in flight (claimed but not yet completed).
    CREATE TABLE IF NOT EXISTS payment_idempotency (
      idem_key     TEXT NOT NULL,
      tenant_id    TEXT NOT NULL,
      entity_key   TEXT NOT NULL,
      receipt_json TEXT,
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (idem_key, tenant_id, entity_key)
    );
  `);

  // Additive migration for pre-existing dev DBs (new tables/columns only).
  const cols = (db.prepare("PRAGMA table_info(entities)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("owner_tenant_id"))
    db.exec("ALTER TABLE entities ADD COLUMN owner_tenant_id TEXT");
  if (!cols.includes("error")) db.exec("ALTER TABLE entities ADD COLUMN error TEXT");
  if (!cols.includes("spec_json")) db.exec("ALTER TABLE entities ADD COLUMN spec_json TEXT");
  if (!cols.includes("per_tx_cap")) db.exec("ALTER TABLE entities ADD COLUMN per_tx_cap TEXT");

  const akCols = (db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!akCols.includes("entity_id")) db.exec("ALTER TABLE api_keys ADD COLUMN entity_id TEXT");
  if (!akCols.includes("capability")) db.exec("ALTER TABLE api_keys ADD COLUMN capability TEXT");
  if (!akCols.includes("expires_at")) db.exec("ALTER TABLE api_keys ADD COLUMN expires_at INTEGER");
}
