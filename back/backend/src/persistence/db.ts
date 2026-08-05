import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/** Open (and create dirs for) a SQLite db. Use ":memory:" in tests. */
export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // WAL + NORMAL is the documented safe pairing: fsync happens on WAL checkpoints instead of
  // EVERY commit (the untuned default is FULL — ~2.5 ms of blocked event loop per write on the
  // prod box). Power loss can roll back the last commit but can NOT corrupt the DB; every row we
  // write is re-derivable or retryable (sagas resume, idempotency claims release, caches rebuild),
  // so a lost final commit is acceptable. Do not raise to FULL without re-measuring the pay path.
  db.pragma("synchronous = NORMAL");
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
    -- countEntitiesForNullifier + listEntities both filter on the owning tenant; without this
    -- they scan the whole table, and /world-id/me runs on every authenticated page view.
    CREATE INDEX IF NOT EXISTS idx_entities_owner_tenant ON entities(owner_tenant_id);

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
      entity_key TEXT,                         -- owning entity's idempotencyKey; scopes runningPending
      payee      TEXT NOT NULL,
      amount     TEXT NOT NULL,                -- bigint as decimal string
      status     TEXT NOT NULL CHECK (status IN ('authorized','settled','failed')),
      batch_ref  TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_payments_ledger_status ON payments_ledger(status);
    CREATE INDEX IF NOT EXISTS idx_payments_ledger_entity ON payments_ledger(entity_key, status);

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

    CREATE TABLE IF NOT EXISTS link_codes (
      code TEXT PRIMARY KEY,
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
      created_at   INTEGER NOT NULL,
      revoked_at   INTEGER
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

    -- ── World ID (proof-of-personhood for the legally-required human guardian) ──────────
    -- One row per (unique human, action). The nullifier is the ONLY identity datum World
    -- returns: stable per (human, rp, action), different across apps — so it proves
    -- uniqueness without identifying anyone. UNIQUE(nullifier, action) is the sybil gate:
    -- a second tenant cannot claim a human who already verified.
    CREATE TABLE IF NOT EXISTS guardian_verifications (
      nullifier        TEXT NOT NULL,
      action           TEXT NOT NULL,
      tenant_id        TEXT NOT NULL,
      issuer_schema_id INTEGER,
      credential       TEXT,
      environment      TEXT,
      verified_at      INTEGER NOT NULL,
      expires_at_min   INTEGER,
      PRIMARY KEY (nullifier, action)
    );
    CREATE INDEX IF NOT EXISTS idx_guardian_verifications_tenant
      ON guardian_verifications(tenant_id);

    -- Identity Check step-up (optional). Separate action => separate nullifier from the guardian
    -- verification above, by design. No issuing_country column: World's attributes are assertions,
    -- not disclosures, so a country can be CHECKED but never LEARNED.
    CREATE TABLE IF NOT EXISTS guardian_attestations (
      nullifier        TEXT NOT NULL,
      action           TEXT NOT NULL,
      tenant_id        TEXT NOT NULL,
      min_age          INTEGER NOT NULL,   -- threshold proven, never a birthdate
      credential       TEXT,
      issuer_schema_id INTEGER,
      verified_at      INTEGER NOT NULL,
      expires_at_min   INTEGER,
      PRIMARY KEY (nullifier, action)
    );
    CREATE INDEX IF NOT EXISTS idx_guardian_attestations_tenant
      ON guardian_attestations(tenant_id, action);

    -- In-flight World ID proof requests (server-driven idkit-core flow): created by
    -- POST /world-id/request, consumed by GET /world-id/status/:requestId.
    CREATE TABLE IF NOT EXISTS world_requests (
      request_id  TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      action      TEXT NOT NULL,
      nonce       TEXT,
      status      TEXT NOT NULL,          -- pending | verified | failed
      detail      TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    -- AgentKit seller-side: single-use nonces from the 402 agentkit extension (replay guard).
    CREATE TABLE IF NOT EXISTS world_nonces (
      nonce      TEXT PRIMARY KEY,
      used_at    INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Per-human AUTHORIZATION allowance per resource (NOT a discount/perk — an execution
    -- limit inside the legal-body governance flow).
    CREATE TABLE IF NOT EXISTS world_usage (
      human_id   TEXT NOT NULL,
      resource   TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (human_id, resource)
    );

    -- Cache of AgentBook lookupHuman(address) reads (World Chain RPC) so demo-time RPC
    -- flakiness cannot stall the paywall. Only POSITIVE results are cached (fail-closed).
    CREATE TABLE IF NOT EXISTS world_human_cache (
      agent_address TEXT PRIMARY KEY,
      human_id      TEXT NOT NULL,
      cached_at     INTEGER NOT NULL
    );

    -- S5: every platform-wallet outflow, all paths, ONE table — the rolling-window SUM behind
    -- the aggregate ceiling. Amounts are 6-dec atomic USDC (callers normalize; gas seeds /1e12).
    CREATE TABLE IF NOT EXISTS platform_outflows (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     INTEGER NOT NULL,
      path   TEXT    NOT NULL,
      amount INTEGER NOT NULL,
      ref    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_platform_outflows_at ON platform_outflows(at);

    -- S5: one row per billable Turnkey enclave signature (metered plan: 25/month, then per-sig).
    CREATE TABLE IF NOT EXISTS turnkey_sigs (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      at   INTEGER NOT NULL,
      kind TEXT    NOT NULL
    );

    -- Tier-0 (audit item 3): persisted saga rows for the circle-path funding bridge. Circle's API
    -- is async (tx-id first, hash after confirmation) and its idempotency keys are per-request —
    -- so resume MUST come from these rows + a Circle getTransaction query, never from balance
    -- inference (the turnkey path's shouldSkipFundOperator heuristic does not transfer). One
    -- bridge = three legs sharing a bridge_key; legs are created up-front in one transaction so
    -- "incomplete bridge" is simply "any leg not yet confirmed". amount is atomic USDC (6 dec).
    CREATE TABLE IF NOT EXISTS bridge_legs (
      bridge_key   TEXT NOT NULL,
      leg          TEXT NOT NULL CHECK (leg IN ('fund_operator','approve','deposit_for')),
      entity_key   TEXT NOT NULL,
      amount       TEXT NOT NULL,
      attempt      INTEGER NOT NULL DEFAULT 0,
      circle_tx_id TEXT,
      tx_hash      TEXT,
      state        TEXT NOT NULL CHECK (state IN ('pending','submitted','confirmed','failed')),
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (bridge_key, leg)
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_legs_entity ON bridge_legs(entity_key, state);

    -- Small key/value marker table for one-shot data migrations (guards below), distinct from the
    -- additive schema (table/column) migrations, which are idempotent by construction.
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
  if (!cols.includes("trust_policy")) db.exec("ALTER TABLE entities ADD COLUMN trust_policy TEXT");
  if (!cols.includes("root_passkey_id"))
    db.exec("ALTER TABLE entities ADD COLUMN root_passkey_id TEXT");
  // Tier-0 (audit item 7): custody provider + Circle wallet ids + stored pocket address (so read
  // paths can stop deriving from the master seed) + rotation forensics.
  if (!cols.includes("wallet_provider"))
    db.exec("ALTER TABLE entities ADD COLUMN wallet_provider TEXT");
  if (!cols.includes("circle_wallet_set_id"))
    db.exec("ALTER TABLE entities ADD COLUMN circle_wallet_set_id TEXT");
  if (!cols.includes("circle_operator_wallet_id"))
    db.exec("ALTER TABLE entities ADD COLUMN circle_operator_wallet_id TEXT");
  if (!cols.includes("circle_pocket_wallet_id"))
    db.exec("ALTER TABLE entities ADD COLUMN circle_pocket_wallet_id TEXT");
  if (!cols.includes("pocket_address"))
    db.exec("ALTER TABLE entities ADD COLUMN pocket_address TEXT");
  if (!cols.includes("previous_operator"))
    db.exec("ALTER TABLE entities ADD COLUMN previous_operator TEXT");
  if (!cols.includes("operator_rotated_at"))
    db.exec("ALTER TABLE entities ADD COLUMN operator_rotated_at INTEGER");
  if (!cols.includes("public_id")) db.exec("ALTER TABLE entities ADD COLUMN public_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_public_id ON entities(public_id)");

  const akCols = (db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!akCols.includes("entity_id")) db.exec("ALTER TABLE api_keys ADD COLUMN entity_id TEXT");
  if (!akCols.includes("capability")) db.exec("ALTER TABLE api_keys ADD COLUMN capability TEXT");
  if (!akCols.includes("expires_at")) db.exec("ALTER TABLE api_keys ADD COLUMN expires_at INTEGER");

  // One-shot data migration (S1): promote every existing key whose effective capability is 'spend'
  // (stored 'spend' or legacy NULL) to the new top rung 'provision'. Strictly behavior-preserving —
  // these keys could already call fund_treasury/onboard_agent under the old single-rung "spend"
  // gate, so after promotion they still can and nothing new is granted. Guarded by a `meta` marker
  // so a re-run never re-promotes a key deliberately minted as 'spend' after this migration ran.
  // See back/docs/design/2026-07-20-s1-fund-treasury-authorization.md.
  const CAPABILITY_BACKFILL_KEY = "apikey_capability_provision_backfill";
  const backfillDone = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(CAPABILITY_BACKFILL_KEY);
  if (!backfillDone) {
    db.transaction(() => {
      db.exec(
        "UPDATE api_keys SET capability = 'provision' WHERE capability IS NULL OR capability = 'spend'",
      );
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '1')").run(
        CAPABILITY_BACKFILL_KEY,
      );
    })();
  }

  const pkCols = (db.prepare("PRAGMA table_info(passkeys)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!pkCols.includes("revoked_at")) db.exec("ALTER TABLE passkeys ADD COLUMN revoked_at INTEGER");

  const plCols = (db.prepare("PRAGMA table_info(payments_ledger)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!plCols.includes("entity_key"))
    db.exec("ALTER TABLE payments_ledger ADD COLUMN entity_key TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_payments_ledger_entity ON payments_ledger(entity_key, status)",
  );
}
