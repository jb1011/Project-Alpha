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

/**
 * The PII table (design §3/§5), extracted as a constant because the migration below REBUILDS it.
 *
 * PR 1 keyed it by `entity_key` — but PII is collected BEFORE an entity exists: the wizard (and
 * an MCP caller) posts a legal identity, gets a `partyId` back, and passes that to onboard, where
 * the party is bound to the entity the claim mints. So the key is the partyId, the entity_key is
 * nullable-and-unique (one party per entity, bound exactly once), and the row carries the tenant
 * that owns it — ownership has to be answerable before there is an entity to answer it from.
 *
 * `region` is nullable because most countries have no state/province (US region = 2-letter
 * state); `deleted_at` is the erasure marker for parties that never reached a filing (H7).
 */
const FORMATION_PARTIES_DDL = `
    CREATE TABLE IF NOT EXISTS formation_parties (
      party_id   TEXT PRIMARY KEY,
      entity_key TEXT UNIQUE,      -- NULL until the party is bound to an entity at onboard
      tenant_id  TEXT NOT NULL,
      legal_first_name TEXT NOT NULL, legal_last_name TEXT NOT NULL,
      email TEXT NOT NULL, phone TEXT,
      line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL,
      region TEXT,
      postal_code TEXT NOT NULL, country TEXT NOT NULL,   -- ISO-3
      -- A clearly-labeled sandbox fixture rather than a real natural person (§3, audit H7).
      synthetic INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );
`;

/** Created SEPARATELY, after the rebuild guard below: on a pre-existing database the table still
 *  has PR 1's shape when the CREATE-TABLE block runs, and indexing a `tenant_id` that does not
 *  exist yet fails the whole migration. */
const FORMATION_PARTIES_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_formation_parties_tenant ON formation_parties(tenant_id);";

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

    -- Admin-issued guardian waivers: the escape hatch for humans with NO World ID path (no Orb
    -- in their country, passport not in World's credential list). Single-use, revocable by
    -- deletion. Only the sha256 of the code is stored — the plaintext exists once, at issuance.
    CREATE TABLE IF NOT EXISTS guardian_waivers (
      code_hash   TEXT PRIMARY KEY,
      note        TEXT NOT NULL,          -- who/why, for the audit trail
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER,                -- NULL = no expiry
      redeemed_by TEXT,                   -- tenant that used it (NULL = still open)
      redeemed_at INTEGER
    );

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
      state        TEXT NOT NULL CHECK (state IN ('pending','submitted','confirmed','failed','abandoned')),
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (bridge_key, leg)
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_legs_entity ON bridge_legs(entity_key, state);

    -- Tier-0: per-(jobKey, step) attempt counters for circle-path job ops. A FAILED Circle tx
    -- burns its deterministic idempotency key (Circle replays the original failed response for a
    -- reused key), so retries MUST derive a fresh key — same invariant the funding bridge keeps
    -- in bridge_legs.attempt (review finding H1).
    CREATE TABLE IF NOT EXISTS job_op_attempts (
      job_key TEXT NOT NULL,
      step    TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_key, step)
    );

    -- ── doola formation (design 2026-08-19 §3) ────────────────────────────────────────────
    -- NO new EntityStatus values: formation state layers BESIDE the status machine (ENS +
    -- guardian precedents), so the CHECK on entities.status above stays untouched.

    -- Provider-side formation milestones only; on-chain anchor cycles live in oa_anchors.
    CREATE TABLE IF NOT EXISTS formation_requests (
      entity_key   TEXT NOT NULL,
      step         TEXT NOT NULL CHECK (step IN
                   ('create_provider','await_filing','fetch_documents','await_ein')),
      state        TEXT NOT NULL CHECK (state IN
                   ('pending','submitted','confirmed','failed','abandoned')),
      attempt      INTEGER NOT NULL DEFAULT 0,
      provider_ref TEXT,
      detail       TEXT,          -- JSON: filingNumber, ein, doc ids…
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_key, step)
    );
    CREATE INDEX IF NOT EXISTS idx_formation_state ON formation_requests(state, step);
    CREATE INDEX IF NOT EXISTS idx_formation_provider ON formation_requests(provider_ref);

    -- Anchor cycles: one row PER MANIFEST VERSION. Deliberately NOT keyed like bridge_legs
    -- (entity, step) — a bridge has exactly one of each leg, whereas an entity accumulates
    -- v1, v2, v3… and two cycles must be able to coexist (audit H1).
    CREATE TABLE IF NOT EXISTS oa_anchors (
      entity_key    TEXT NOT NULL,
      version       INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      state         TEXT NOT NULL CHECK (state IN
                    ('pending','scheduled','executed','vetoed','superseded','failed')),
      schedule_tx   TEXT, execute_tx TEXT,
      executable_at INTEGER,
      attempt       INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_key, version)
    );

    -- Webhook dedupe + audit. A webhook is a WAKE-UP SIGNAL, never a source of facts: the
    -- payload is persisted for forensics, and processors always re-fetch authoritative state
    -- from doola over TLS. processed_at NULL = still owed to the sweeper.
    CREATE TABLE IF NOT EXISTS doola_webhook_events (
      event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL,
      provider_ref TEXT, payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TEXT
    );
    -- PARTIAL index: the sweeper's only query is "what is unprocessed?", and the table is
    -- swept after 30d, so indexing the processed majority would be pure write cost.
    CREATE INDEX IF NOT EXISTS idx_doola_events_pending ON doola_webhook_events(processed_at)
      WHERE processed_at IS NULL;

    -- Controller PII — its OWN table, never spec_json / views / transparency / metadata / logs.
    ${FORMATION_PARTIES_DDL}

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

  // doola formation (design §3). Purely additive: NULL formation_provider = legacy/stub forever
  // (the 13 testnet + existing prod agents are never backfilled). The three hash/version columns
  // exist because the monitor and the guardian veto UI read `entities` through a fixed projection
  // — version NUMBERS alone cannot feed the compromise rule or the veto card (audit H3/14).
  if (!cols.includes("formation_provider"))
    db.exec("ALTER TABLE entities ADD COLUMN formation_provider TEXT");
  if (!cols.includes("formation_environment"))
    db.exec("ALTER TABLE entities ADD COLUMN formation_environment TEXT");
  // The REAL EIN, once the IRS issues one. `ein` above stays the on-chain-frozen value.
  if (!cols.includes("ein_real")) db.exec("ALTER TABLE entities ADD COLUMN ein_real TEXT");
  if (!cols.includes("formation_filed_at"))
    db.exec("ALTER TABLE entities ADD COLUMN formation_filed_at INTEGER");
  if (!cols.includes("formation_filing_number"))
    db.exec("ALTER TABLE entities ADD COLUMN formation_filing_number TEXT");
  if (!cols.includes("oa_manifest_version"))
    db.exec("ALTER TABLE entities ADD COLUMN oa_manifest_version INTEGER");
  if (!cols.includes("oa_manifest_anchored_hash"))
    db.exec("ALTER TABLE entities ADD COLUMN oa_manifest_anchored_hash TEXT");
  if (!cols.includes("oa_manifest_pending_hash"))
    db.exec("ALTER TABLE entities ADD COLUMN oa_manifest_pending_hash TEXT");
  if (!cols.includes("oa_amendment_executable_at"))
    db.exec("ALTER TABLE entities ADD COLUMN oa_amendment_executable_at INTEGER");

  // The `documents` table (declared-unused since v1) becomes the index for real legal PDFs.
  // The existing `path NOT NULL` is satisfied by DocumentStore.putBytes. System of record for
  // the BYTES is doola (re-fetchable via provider_doc_id); this is our hash-pinned index.
  const docCols = (db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!docCols.includes("entity_key")) db.exec("ALTER TABLE documents ADD COLUMN entity_key TEXT");
  if (!docCols.includes("doc_type")) db.exec("ALTER TABLE documents ADD COLUMN doc_type TEXT");
  if (!docCols.includes("sha256")) db.exec("ALTER TABLE documents ADD COLUMN sha256 TEXT");
  if (!docCols.includes("content_type"))
    db.exec("ALTER TABLE documents ADD COLUMN content_type TEXT");
  if (!docCols.includes("size")) db.exec("ALTER TABLE documents ADD COLUMN size INTEGER");
  if (!docCols.includes("provider_doc_id"))
    db.exec("ALTER TABLE documents ADD COLUMN provider_doc_id TEXT");

  // formation_parties: PR 1's shape was keyed by entity_key with no tenant column, which cannot
  // express a party that exists BEFORE its entity does (the intake handle, design §5). Rebuild
  // rather than ALTER: PR 1 shipped no writer for this table — the endpoint that produces rows
  // arrives in this PR — so there is provably nothing to preserve, and a drop+create leaves the
  // documented key structure (PRIMARY KEY, UNIQUE) that a 12-step ALTER dance cannot add anyway.
  // Guarded on the column so it runs exactly once and never on a table that already has it.
  const partyCols = (
    db.prepare("PRAGMA table_info(formation_parties)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!partyCols.includes("party_id")) {
    db.exec(`DROP TABLE formation_parties;${FORMATION_PARTIES_DDL}`);
  }
  db.exec(FORMATION_PARTIES_INDEX_DDL);

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
