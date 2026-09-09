import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DESCRIPTION, DEFAULT_INDUSTRY, companyNameOptions } from "../formation/intake";

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
      -- The PII columns are NULLABLE, and that is the point: ERASURE (§3, audit H7) sets every
      -- one of them to NULL and stamps deleted_at, keeping only the handle, the owner and the
      -- dates so the erasure itself stays auditable. A NOT NULL here would force the sweeper to
      -- overwrite personal data with a sentinel string instead of removing it — "erased" has to
      -- mean the column holds nothing, not that it holds something else.
      legal_first_name TEXT, legal_last_name TEXT,
      email TEXT, phone TEXT,
      line1 TEXT, line2 TEXT, city TEXT,
      region TEXT,
      postal_code TEXT, country TEXT,   -- ISO-3
      -- A clearly-labeled sandbox fixture rather than a real natural person (§3, audit H7).
      synthetic INTEGER NOT NULL DEFAULT 0,
      -- The COMPANY this identity was spent on (2026-08-26 §2). A party row is SINGLE-USE: once
      -- bound it is never reusable, and a second company needs a second row with its own intake,
      -- its own SSN capture and its own erasure clocks. UNIQUE lives in an index rather than
      -- inline, because ALTER TABLE ADD COLUMN cannot add a UNIQUE constraint and both the fresh
      -- and the upgraded database must end up with the same keys.
      company_id TEXT,
      -- SSN (2026-08-26 §4): AES-256-GCM ciphertext, its 12-byte IV, and the key id so a
      -- PREVIOUS key is SELECTED rather than trial-decrypted. Written by A2; the columns exist
      -- now so the erasure statement below is complete from the day the first one is written.
      ssn_ciphertext BLOB, ssn_iv BLOB, ssn_key_id TEXT, ssn_deleted_at TEXT,
      -- WHEN the SSN was captured, which is what the 7-day clock actually runs from (§4.6a).
      -- NOT the company's created_at: the §4.7 edit-and-retry captures a NEW number onto a
      -- company that may be days old, and a clock keyed to the company would erase it on the
      -- next sweep — deleting, within minutes, a number a caller had just been asked for.
      ssn_captured_at TEXT,
      -- WHY this row holds no SSN: provider_persisted | terminal | ttl | intake_reopened. It is
      -- written by every erase path, and it is read by code rather than only by an operator: a
      -- filing that finds the SSN gone needs to know what took it.
      ssn_erased_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );
`;

/** Created SEPARATELY, after the rebuild guard below: on a pre-existing database the table still
 *  has PR 1's shape when the CREATE-TABLE block runs, and indexing a `tenant_id` that does not
 *  exist yet fails the whole migration. */
const FORMATION_PARTIES_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_formation_parties_tenant ON formation_parties(tenant_id);
  -- Single-use, enforced by the database. SQLite treats NULLs as distinct in a UNIQUE index, so
  -- every unbound party still coexists happily.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_formation_parties_company
    ON formation_parties(company_id);
  -- The RETENTION SWEEP's index, and PARTIAL on purpose (§4.6a).
  --
  -- listSsnRetention asks "which parties still hold an SSN?", and the answer is a handful at any
  -- moment — exactly the companies between an intake and a provider_ref — inside a table that
  -- grows forever and whose rows keep their PII columns NULL for the rest of their lives. A full
  -- index over company_id would carry every one of those dead rows; the WHERE clause makes the
  -- index hold only the live ones, so the sweep's cost tracks the work outstanding rather than
  -- the history.
  CREATE INDEX IF NOT EXISTS idx_formation_parties_ssn_held
    ON formation_parties(company_id) WHERE ssn_ciphertext IS NOT NULL;
`;

/**
 * The sub-saga rows, extracted as a constant because the 2026-08-26 migration REBUILDS the table
 * (SQLite cannot alter a primary key).
 *
 * `facts_updated_at` is the column the anchor gate reads, and it is separate from `updated_at`
 * for one measured reason: `persistPollBackoff` bumps `updated_at` on EVERY poll, so an
 * `await_ein` row waiting four to six weeks for the IRS made its entity re-read and re-hash its
 * manifest on every single tick of those six weeks. Only a transition that changes state, the
 * provider ref or the fact detail moves this one.
 */
const FORMATION_REQUESTS_DDL = `
    CREATE TABLE IF NOT EXISTS formation_requests (
      company_id   TEXT NOT NULL,
      step         TEXT NOT NULL CHECK (step IN
                   ('create_provider','await_filing','fetch_documents','await_ein')),
      state        TEXT NOT NULL CHECK (state IN
                   ('pending','submitted','confirmed','failed','abandoned')),
      attempt      INTEGER NOT NULL DEFAULT 0,
      provider_ref TEXT,
      detail       TEXT,          -- JSON: filingNumber, ein, doc ids…
      error        TEXT,
      -- Epoch ms the sweeper may next POLL this step. A MIRROR of detail.nextPollAt, and it is a
      -- column for exactly one reason: "which rows are due?" has to be a question the database
      -- answers. Reading every open company's detail blob to find out means the poll cost grows
      -- with the number of formations ever opened rather than with the number actually due.
      next_poll_at INTEGER,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      facts_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, step)
    );
`;

/**
 * COMPANIES — the home of everything doola-related (design 2026-08-26 §2).
 *
 * Entities attach to a company MANY-TO-ONE, which is why the filing's facts live here and not on
 * `entities`: a company can be filed, and have its documents fetched, before any agent attaches
 * to it, and ten agents can share one filing afterwards.
 *
 * `status` carries ONLY the dimension the company itself owns. "Paying" is derived from
 * `formation_payments` (`hasLivePayment`) and filing progress is derived from
 * `formation_requests` (`deriveFormationStatus`), so a refund, an expired quote or a late filing
 * needs no second write here and nothing can drift.
 */
const COMPANIES_DDL = `
    CREATE TABLE IF NOT EXISTS companies (
      company_id  TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('draft','ready','abandoned')),
      -- The pin, exactly as an entity carried it: a mainnet flip must never route an in-flight
      -- sandbox company at the production host, and an attached entity copies BOTH halves from
      -- this row rather than from config.
      provider    TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
      -- A labeled sandbox fixture rather than a real natural person. Written from the
      -- DEPLOYMENT's own setting, never from caller input.
      synthetic   INTEGER NOT NULL DEFAULT 0,
      -- JSON, ONE canonical shape: [{name, entityTypeEnding, position}] (formation/intake.ts).
      name_options    TEXT NOT NULL,
      business_purpose TEXT NOT NULL,
      -- The doola INDUSTRY LABEL. There is no code column because doola deprecated naicsCode and
      -- nothing would ever write or read one.
      industry_label  TEXT NOT NULL,
      -- Row-level marker for intake that was DERIVED (the migration, the A1 shim) rather than
      -- typed by a human. Deliberately not a key inside name_options, which keeps ONE shape.
      intake_synthesized INTEGER NOT NULL DEFAULT 0,
      -- The name the STATE accepted, and only ever OUR candidate string that doola's reported
      -- name matched (§5) — never doola free text, which the manifest would then hash on-chain.
      legal_name_filed TEXT,
      -- The legal facts, moved here from the entity: unix SECONDS, the state's filing number,
      -- and the real EIN once the IRS issues one.
      filed_at       INTEGER,
      filing_number  TEXT,
      ein            TEXT,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- (tenant_id, created_at DESC) because listByTenant -- the reuse picker's ordering contract,
    -- shared by GET /companies and MCP list_companies -- reads exactly that, and the old
    -- (tenant_id, status) left it sorting every page in memory. countChargeableByTenant still
    -- narrows on the leading column. RENAMED rather than redefined, because
    -- CREATE INDEX IF NOT EXISTS will not redefine an index that already exists under the same
    -- name; the old name is dropped by dropRetiredIndexes below.
    CREATE INDEX IF NOT EXISTS idx_companies_tenant_created
      ON companies(tenant_id, created_at DESC);
`;

/**
 * FORMATION PAYMENTS (design 2026-08-26 §2/§6) — shipped in A1, WRITTEN by B1.
 *
 * The table lands with the schema rather than with the feature so the derived-paying predicate
 * (`hasLivePayment`) has something to read from day one and answers `false` honestly, and so the
 * one index that carries a real invariant — at most one LIVE quote per (company, product) — is
 * in place before anything can violate it.
 */
const FORMATION_PAYMENTS_DDL = `
    CREATE TABLE IF NOT EXISTS formation_payments (
      payment_id  TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL,
      -- Additive by construction: a yearly maintenance quote is a second product, not a second
      -- table, and the live-rows index below is per product so both can be live at once.
      product     TEXT NOT NULL DEFAULT 'formation'
                  CHECK (product IN ('formation','maintenance_year')),
      status      TEXT NOT NULL CHECK (status IN
                  ('quoted','settling','settled','expired','failed','refunded')),
      -- The STORED quote. Verification compares the signature against THIS, never live config:
      -- a fee change between quote and settle must not re-price a signature already given.
      amount_usdc TEXT NOT NULL,
      -- 32 random bytes, hex. Uniqueness comes from the ROW, never derived from the company id —
      -- a derived nonce is one-shot and would brick the company after any failed attempt.
      nonce       TEXT NOT NULL,
      -- ⚠ TWO DEADLINES (B1 gate A4), and they are not the same promise.
      --
      -- valid_before is what the guardian SIGNED and what the token enforces. ttl_at is when the
      -- QUOTE stops being offered — earlier by FORMATION_SETTLE_GRACE_MS, so that a signature
      -- given at the last second of the quote still has time to be composed, broadcast, mined and
      -- (after a crash) re-composed. One deadline for both meant an authorization expiring while
      -- its own transfer sat in the mempool.
      valid_before INTEGER NOT NULL,
      ttl_at      INTEGER,
      -- The chain head when this quote was issued (B1 gate A3). It is the LOWER BOUND of the log
      -- window that later resolves the payment from the token's own AuthorizationUsed /
      -- AuthorizationCanceled events. NULL is survivable (the reader falls back to a capped
      -- lookback), it is just a wider scan.
      quoted_block INTEGER,
      -- Where the money goes, STORED AT QUOTE TIME (§6.1, B1 gate A1). Never re-read from live
      -- config on verify, settle or cancel: a revenue-address change between quote and settle
      -- would otherwise silently re-target a signature the guardian has already given, and the
      -- token would reject it (or, worse, we would verify against the new address and broadcast
      -- an authorization naming the old one).
      pay_to      TEXT,
      payer_address TEXT,
      -- ⚠ THE DURABLE ARTIFACT (B1 gate A1). The guardian's EIP-3009 SIGNATURE, persisted BEFORE
      -- any broadcast. It is what makes a crash mid-settle recoverable, and it is nonce-free:
      -- the executor transaction is COMPOSED FRESH at every broadcast (current pending nonce,
      -- current fees), because a signed raw transaction commits to an executor nonce that
      -- another transaction can consume while we are down — after which the persisted bytes are
      -- permanently unsendable. The authorization has no such problem; the token's own
      -- authorizationState and its AuthorizationUsed log are the exactly-once.
      signature   TEXT,
      -- DEPRECATED (B1 gate A1). Was the persisted raw transaction back when re-broadcasting the
      -- same bytes was the recovery story. Nothing reads or writes it; the column stays because
      -- dropping one buys nothing and an old SQLite cannot.
      raw_tx      BLOB,
      -- The LAST hash we broadcast, and how many times we have broadcast at all. Neither is an
      -- outcome: the outcome comes from the token's logs (resolveAuthorizationOutcome), which
      -- is what lets a THIRD PARTY's settlement of the same public authorization resolve
      -- as settled rather than as failed.
      tx_hash     TEXT,
      broadcast_count INTEGER NOT NULL DEFAULT 0,
      attempt     INTEGER NOT NULL DEFAULT 0,
      refund_tx_hash TEXT,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- LIVE rows only. A terminal row (settled/expired/failed/refunded) must not forbid the
    -- re-quote that follows it, and a maintenance_year quote must not forbid the formation one.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_formation_payments_one_live
      ON formation_payments(company_id, product) WHERE status IN ('quoted','settling');
    CREATE INDEX IF NOT EXISTS idx_formation_payments_company
      ON formation_payments(company_id, status);
`;

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

    -- AgentBook registrations (design 2026-08-25 v3 §4.4). A 'pending' row IS the session; the
    -- partial unique index on 'submitted' is the atomic in-flight claim; raw_tx is persisted
    -- BEFORE broadcast (the bridge-legs rule) so a crash re-broadcasts the same transaction.
    CREATE TABLE IF NOT EXISTS agentbook_registrations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL UNIQUE,
      entity_key      TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      address         TEXT NOT NULL,
      nonce           TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN
                        ('pending','submitted','confirmed','disputed','failed','expired')),
      nullifier       TEXT,
      raw_tx          TEXT,
      submitter_nonce INTEGER,
      tx_hash         TEXT,
      attempt         INTEGER NOT NULL DEFAULT 0,
      error_code      TEXT,
      expires_at      INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agentbook_inflight
      ON agentbook_registrations(entity_key) WHERE status = 'submitted';
    CREATE INDEX IF NOT EXISTS idx_agentbook_entity
      ON agentbook_registrations(entity_key, id);
    CREATE INDEX IF NOT EXISTS idx_agentbook_tenant_created
      ON agentbook_registrations(tenant_id, created_at);

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
    -- Keyed by COMPANY since 2026-08-26: the sub-saga runs once per company, not once per agent,
    -- and ten agents sharing a filing must not mean ten filings.
    ${FORMATION_REQUESTS_DDL}
    CREATE INDEX IF NOT EXISTS idx_formation_state ON formation_requests(state, step);
    CREATE INDEX IF NOT EXISTS idx_formation_provider ON formation_requests(provider_ref);
    -- createRequestsSince -- the platform DAILY CEILING, asked on every company creation, i.e. on
    -- the money path. Without it the count is a full scan of every formation ever opened.
    CREATE INDEX IF NOT EXISTS idx_formation_created ON formation_requests(step, created_at);

    ${COMPANIES_DDL}
    ${FORMATION_PAYMENTS_DDL}

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
      -- Backoff for a cycle parked WITHOUT burning an attempt (PR 3, the parkFormationStep rule).
      -- A transport failure on a broadcast or a receipt read tells us nothing about whether the
      -- amendment is going through, so it must never count toward abandonment; the interval
      -- itself is then the row's only memory of how many times this has happened. Two scalars
      -- rather than formation_requests' detail blob: there are exactly two numbers, and a JSON
      -- parse per row per tick buys nothing.
      retry_interval_ms INTEGER,
      next_retry_at     INTEGER,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_key, version)
    );
    CREATE INDEX IF NOT EXISTS idx_oa_anchors_state ON oa_anchors(state, entity_key, version);

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
  // ── The FLEET's operator addresses, indexed (2026-08-26 §6.6) ────────────────────────────
  //
  // Read by exactly one thing: the boot invariant that refuses to let
  // `FORMATION_REVENUE_ADDRESS` be an address this platform signs with
  // (`assertRevenueAddressSeparation`). It is a point lookup on three columns, and the design
  // asks for an indexed EXISTS rather than a fleet scan — a deployment with a thousand agents
  // must not read a thousand rows to answer a yes/no question at every boot.
  //
  // PARTIAL on NOT NULL: every legacy row has NULLs here, and indexing them buys nothing.
  //
  // COLLATE NOCASE, and that is the whole trick. Addresses are stored in whatever casing wrote
  // them — viem checksums, older paths and hand-written rows do not — so the comparison has to be
  // case-insensitive, and the obvious spelling (`LOWER(operator) = ?`) puts a function on the
  // indexed side and silently turns the lookup back into a table scan. A NOCASE index is used by
  // a NOCASE comparison, so the check is both correct and indexed.
  //
  // Guarded per column and read FRESH, because a genuinely old database can be missing any of
  // them: `pocket_address` and `previous_operator` are ALTERed in above, but `operator` predates
  // that machinery and a pre-formation fixture has neither the column nor a path that adds one.
  // Indexing a column that is not there throws and takes the whole migration with it.
  const addressCols = (db.prepare("PRAGMA table_info(entities)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addressIndexes: Array<[column: string, index: string]> = [
    ["operator", "idx_entities_operator_addr"],
    ["previous_operator", "idx_entities_previous_operator_addr"],
    ["pocket_address", "idx_entities_pocket_addr"],
  ];
  for (const [column, index] of addressIndexes) {
    if (!addressCols.includes(column)) continue;
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${index} ON entities(${column} COLLATE NOCASE) WHERE ${column} IS NOT NULL`,
    );
  }

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
  // PR 3: the pending VERSION beside the pending hash. The design listed only the hash, and the
  // hash is what DECIDES every rule — the monitor compares hashes, and its regression case is a
  // hash comparison too. The version is the fixed PROJECTION the monitor's alerts and the tenant's
  // guardian card render (audit H3): "amendment v3 is pending" is the sentence an operator can
  // act on, where a bare keccak is not. Same projection, one more column.
  if (!cols.includes("oa_manifest_pending_version"))
    db.exec("ALTER TABLE entities ADD COLUMN oa_manifest_pending_version INTEGER");

  // oa_anchors gained its two backoff columns in PR 3 (see the DDL above); a database created by
  // PR 1 has the table without them.
  const anchorCols = (db.prepare("PRAGMA table_info(oa_anchors)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!anchorCols.includes("retry_interval_ms"))
    db.exec("ALTER TABLE oa_anchors ADD COLUMN retry_interval_ms INTEGER");
  if (!anchorCols.includes("next_retry_at"))
    db.exec("ALTER TABLE oa_anchors ADD COLUMN next_retry_at INTEGER");

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
  // arrives in PR 2 — so on every database that has ever existed there is provably nothing to
  // preserve, and a drop+create leaves the documented key structure (PRIMARY KEY, UNIQUE) that a
  // 12-step ALTER dance cannot add anyway.
  //
  // "Provably nothing to preserve" is an argument about the code that shipped, and the code that
  // shipped is not the only thing that can put rows in a table. So the drop ASKS: a legacy-shaped
  // table with any rows in it refuses the boot, by name, rather than silently destroying personal
  // data nobody can get back. There is no automatic migration path for those rows — the columns
  // the new shape needs (`party_id`, `tenant_id`) do not exist to derive them from — so the
  // honest answer is an operator decision, not a guess.
  const partyCols = (
    db.prepare("PRAGMA table_info(formation_parties)").all() as { name: string }[]
  ).map((c) => c.name);
  if (partyCols.length > 0 && !partyCols.includes("party_id")) {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM formation_parties").get() as { n: number };
    if (n > 0)
      throw new Error(
        `refusing to migrate: formation_parties still has PR 1's shape (no party_id column) and holds ${n} row(s). That table is the only one in the system carrying personal data, the rebuild this migration performs is a DROP, and the new shape's keys (party_id, tenant_id) cannot be derived from the old one. Back the rows up and remove them, or rename the table aside, then restart.`,
      );
    db.exec(`DROP TABLE formation_parties;${FORMATION_PARTIES_DDL}`);
  }
  // The 2026-08-26 columns, ALTER-if-missing (the house idiom) and BEFORE the index block below,
  // which now indexes `company_id`: indexing a column that does not exist yet fails the boot.
  const partyColsNow = (
    db.prepare("PRAGMA table_info(formation_parties)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!partyColsNow.includes("company_id"))
    db.exec("ALTER TABLE formation_parties ADD COLUMN company_id TEXT");
  for (const [col, type] of [
    ["ssn_ciphertext", "BLOB"],
    ["ssn_iv", "BLOB"],
    ["ssn_key_id", "TEXT"],
    ["ssn_deleted_at", "TEXT"],
    // A2: the capture clock and the erasure reason. NULL on every existing row, which both
    // readers handle — the retention query falls back to the company's `created_at` (the clock
    // A2 shipped with), and a NULL reason means "nothing was ever erased here".
    ["ssn_captured_at", "TEXT"],
    ["ssn_erased_reason", "TEXT"],
  ] as const)
    if (!partyColsNow.includes(col))
      db.exec(`ALTER TABLE formation_parties ADD COLUMN ${col} ${type}`);
  db.exec(FORMATION_PARTIES_INDEX_DDL);

  // formation_payments: the B1-gate columns, ALTER-if-missing (the house idiom). The table
  // itself is A1's; these four are what turn the AUTHORIZATION into the durable artifact —
  // `pay_to` pins the payee at quote time, `signature` is the thing a resume re-submits, and
  // `broadcast_count` says how many times we have composed a transaction for it (which is also
  // the fee-bump ladder). A database created before this build has the table without them.
  const payCols = (
    db.prepare("PRAGMA table_info(formation_payments)").all() as { name: string }[]
  ).map((c) => c.name);
  for (const [col, type] of [
    ["pay_to", "TEXT"],
    ["signature", "TEXT"],
    ["broadcast_count", "INTEGER NOT NULL DEFAULT 0"],
    ["quoted_block", "INTEGER"],
    ["ttl_at", "INTEGER"],
  ] as const)
    if (!payCols.includes(col)) db.exec(`ALTER TABLE formation_payments ADD COLUMN ${col} ${type}`);

  // formation_requests.next_poll_at: ALTER-if-missing, the house idiom. A database created by
  // PR 2's first migration has the column; one created by an earlier build of PR 2 does not, and
  // a NULL there reads as "never polled", which is exactly right for every existing row.
  const reqCols = (
    db.prepare("PRAGMA table_info(formation_requests)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!reqCols.includes("next_poll_at"))
    db.exec("ALTER TABLE formation_requests ADD COLUMN next_poll_at INTEGER");

  // ── The 2026-08-26 re-key: companies become the home of a filing (design §2). Everything it
  //    touches — the new columns, the synthesis, the table rebuild and the assertion — is in one
  //    place because the ORDER is the whole safety argument. It is a no-op on a database that has
  //    already been through it, and on a brand-new one.
  migrateFormationToCompanies(db);

  // The documents index is keyed by OUR derived id (documentIndexRepository.documentIndexId), but
  // the fact that makes a re-fetch idempotent is (company, doola document id) — so that pair is
  // the constraint, and a second insert for a document we already stored is a no-op rather than a
  // duplicate row pointing at a second copy of the same bytes. The entity-keyed pair it replaces
  // is dropped: a document can be fetched before any agent attaches, so the entity key is not a
  // key at all any more. `idx_documents_entity` stays for the legacy rows, which keep their
  // entity-derived index id and file path as opaque locators.
  db.exec("DROP INDEX IF EXISTS idx_documents_entity_provider");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_company_provider ON documents(company_id, provider_doc_id)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_company ON documents(company_id)");

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

/** Marker for the one-shot 2026-08-26 re-key (design §2 steps 1-5). */
const COMPANY_REKEY_MARKER = "formation_company_rekey_2026_08_26";

/** The message the refusal predicate throws. Exported so the test asserts the sentence an
 *  operator actually reads, and so the CLI escape hatch is named in exactly one place. */
export function companyRekeyRefusalMessage(entityKeys: string[]): string {
  return `refusing to migrate: the formation sub-saga is being re-keyed from entities to COMPANIES, and ${entityKeys.length} create_provider row(s) are still in flight (${entityKeys.slice(0, 5).join(", ")}${entityKeys.length > 5 ? ", …" : ""}). Re-keying a live create rotates its idempotency key, and doola would file a SECOND real Wyoming LLC under a second real fee. Wait for each one to reach a terminal state, or — for a row parked forever on a human decision — abandon it deliberately with: npm run cli -- formation:abandon <entityKey>`;
}

/**
 * The SECOND step-1 refusal: an entity holding formation state with NO pin of its own.
 *
 * `companies.environment` is NOT NULL and it decides where a filing is ROUTED — the create step
 * compares it against the deployment's own environment and refuses on a mismatch. There is no
 * honest value to synthesize for an entity that never carried one, and the migration used to
 * write `'sandbox'` on the grounds that it would make the check refuse. That is a guess dressed
 * as a safety property: on a sandbox box it refuses nothing, and it silently decides for a real
 * responsible party's filing which host their identity is sent to.
 *
 * The cohort is impossible under the rules on `main` — the pin, the company and the party bind
 * are written in ONE claim transaction — so a row in it means hand-edited data or a shape that
 * predates that rule, and either way a human has to say what the pin is. Named, loudly, rather
 * than defaulted.
 */
export function companyRekeyUnpinnedRefusalMessage(entityKeys: string[]): string {
  const one = entityKeys.length === 1;
  return `refusing to migrate: ${entityKeys.length} entit${one ? "y holds" : "ies hold"} formation state (a formation provider, a bound responsible party, a sub-saga row or a document) but ${one ? "carries" : "carry"} an INCOMPLETE formation pin — provider or environment is NULL (${entityKeys.slice(0, 5).join(", ")}${entityKeys.length > 5 ? ", …" : ""}). companies.provider and companies.environment are both NOT NULL, and the environment is what routes a filing at sandbox or at production; this migration will not invent either. Pinning such a row to "sandbox" would silently decide, on a sandbox box, that a real person's identity is filed there. Under the current claim rules the pin, the company and the party bind are written in one transaction, so this shape cannot be produced any more — set formation_provider AND formation_environment on each entity above deliberately, or erase the party bound to it, and re-run.`;
}

/**
 * THE MIGRATION (design 2026-08-26 §2, steps 1-5).
 *
 * It is written out step by step, and specified to the query, because two adversarial passes
 * showed that the naive version files duplicate LLCs, erases live PII and re-anchors the fleet.
 * Every step below exists because of one of those.
 *
 * ONE transaction, a `meta` marker, and a REFUSAL rather than a guess. Additive column work is
 * outside the transaction (it is idempotent by construction and safe to repeat); the data move is
 * inside it, and its final act is an assertion that rolls the whole thing back if a single
 * responsible party would have been left unattached.
 */
function migrateFormationToCompanies(db: Database.Database): void {
  // ── Additive columns first. They are needed whether or not the data move runs (a fresh
  //    database gets `companies` from the DDL block but still needs `entities.company_id`).
  const entityCols = (db.prepare("PRAGMA table_info(entities)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  // WRITE-ONCE. An anchored manifest carries `legal.providerCompanyId`, so re-attaching an entity
  // to a different company would make a permanent on-chain claim false. `upsert` deliberately
  // omits this column from its DO UPDATE list; the only writer is the attach CAS.
  if (!entityCols.includes("company_id"))
    db.exec("ALTER TABLE entities ADD COLUMN company_id TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_entities_company ON entities(company_id) WHERE company_id IS NOT NULL",
  );
  // WRITE-ONCE, made STRUCTURAL. The rule was three comments and one careful CAS in
  // `attachCompany`; a trigger is the only version of it that a future `upsert`, a migration or
  // an operator at a sqlite3 prompt cannot get wrong. An anchored manifest publishes
  // `legal.providerCompanyId` on a public chain, so moving an entity to a different company
  // makes a permanent on-chain claim false — there is no repair for that, only prevention.
  // `IS NOT` is SQLite's null-safe inequality, so clearing the column is refused too.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_entities_company_write_once
    BEFORE UPDATE OF company_id ON entities
    FOR EACH ROW WHEN OLD.company_id IS NOT NULL AND NEW.company_id IS NOT OLD.company_id
    BEGIN
      SELECT RAISE(ABORT, 'entities.company_id is WRITE-ONCE: this entity is already attached to a company, and its anchored manifest publishes that company id on chain');
    END;
  `);

  const documentCols = (db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!documentCols.includes("company_id"))
    db.exec("ALTER TABLE documents ADD COLUMN company_id TEXT");

  // The anchor scheduler's UNION arm reduces `MAX(updated_at)` per entity on every tick.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_oa_anchors_entity_updated ON oa_anchors(entity_key, updated_at)",
  );

  const shapeCols = (
    db.prepare("PRAGMA table_info(formation_requests)").all() as { name: string }[]
  ).map((c) => c.name);
  const legacyShape = shapeCols.includes("entity_key");
  const alreadyDone = db.prepare("SELECT value FROM meta WHERE key = ?").get(COMPANY_REKEY_MARKER);

  if (!legacyShape) {
    // Either a fresh database or one that has been through this already. Only the indexes that
    // name the new columns still need asserting.
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_formation_poll_due ON formation_requests(next_poll_at, company_id)",
    );
    dropRetiredIndexes(db);
    if (!alreadyDone)
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '1')").run(
        COMPANY_REKEY_MARKER,
      );
    return;
  }

  // ── Step 1: THE REFUSAL PREDICATE. A `create_provider` row that is not terminal may be holding
  //    a committed company at doola under a key we are about to change. `failed` WITH a
  //    provider_ref is terminal enough (the adopt path owns it); `failed` WITHOUT one is not —
  //    that is exactly the shape of a lost answer, which re-sends the SAME key on its next pass.
  const inFlight = (
    db
      .prepare(
        `SELECT entity_key AS k FROM formation_requests
          WHERE step = 'create_provider'
            AND (state IN ('pending','submitted')
                 OR (state = 'failed' AND provider_ref IS NULL))
          ORDER BY entity_key`,
      )
      .all() as { k: string }[]
  ).map((r) => r.k);
  if (inFlight.length > 0) throw new Error(companyRekeyRefusalMessage(inFlight));

  // ── Step 1b: THE UNPINNED-BUT-STATEFUL REFUSAL. Every entity the synthesis rule below will
  //    mint a company for has to supply that company's `provider` and `environment`, both NOT
  //    NULL, and `environment` is what decides whether the filing is routed at sandbox or at
  //    production. An entity with either half missing has no such value, and there is no safe
  //    default — see the message.
  //
  //    ⚠ The arms below MIRROR the synthesis predicate in step 2 EXACTLY, `formation_provider IS
  //    NOT NULL` included. That arm selects candidates all by itself, so an entity with a
  //    provider and a NULL environment — no party, no step, no document — is a candidate that
  //    matched none of the other three: it sailed past this refusal and died inside the
  //    transaction on the NOT NULL constraint. A rollback, so nothing was corrupted, but a
  //    cryptic one that names no entity and tells the operator nothing they can act on. Any
  //    future widening of the synthesis rule has to be made here too.
  const unpinned = (
    db
      .prepare(
        `SELECT e.idempotency_key AS k
           FROM entities e
           LEFT JOIN formation_parties p
             ON p.entity_key = e.idempotency_key AND p.deleted_at IS NULL
          WHERE e.company_id IS NULL
            AND (e.formation_provider IS NULL OR e.formation_environment IS NULL)
            AND (e.formation_provider IS NOT NULL
                 OR p.party_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM formation_requests f
                             WHERE f.entity_key = e.idempotency_key)
                 OR EXISTS (SELECT 1 FROM documents d WHERE d.entity_key = e.idempotency_key))
          GROUP BY e.idempotency_key
          ORDER BY e.idempotency_key`,
      )
      .all() as { k: string }[]
  ).map((r) => r.k);
  if (unpinned.length > 0) throw new Error(companyRekeyUnpinnedRefusalMessage(unpinned));

  db.transaction(() => {
    // ── Step 2: THE SYNTHESIS RULE. A company for EVERY entity that holds formation state of any
    //    kind — not only the formed ones. Unopened entities, live filings past `create_provider`
    //    and abandoned-with-a-provider_ref rows all exist, and all of them hold personal data
    //    that must stay ATTACHED: the erasure queries are re-keyed to the company, and a party
    //    left with no company reads as "never used" and is erased on day 7.
    //
    //    The two arms the design names are `formation_provider IS NOT NULL` and "a bound party".
    //    Two more are added here — a formation row, or a document — because both are provably
    //    formation state, and the widened predicate can only ever synthesize MORE rows. A missed
    //    entity would drop its sub-saga rows in step 3.
    const candidates = db
      .prepare(
        `SELECT e.idempotency_key AS key, e.name AS name, e.spec_json AS spec_json,
                e.owner_tenant_id AS owner_tenant_id, e.guardian AS guardian,
                e.formation_provider AS provider, e.formation_environment AS environment,
                e.ein_real AS ein, e.formation_filed_at AS filed_at,
                e.formation_filing_number AS filing_number,
                e.created_at AS created_at, e.updated_at AS updated_at,
                p.tenant_id AS party_tenant, p.synthetic AS party_synthetic,
                (SELECT f.state FROM formation_requests f
                  WHERE f.entity_key = e.idempotency_key
                    AND f.step = 'create_provider') AS create_state
           FROM entities e
           LEFT JOIN formation_parties p
             ON p.entity_key = e.idempotency_key AND p.deleted_at IS NULL
          WHERE e.company_id IS NULL
            AND (e.formation_provider IS NOT NULL
                 OR p.party_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM formation_requests f
                             WHERE f.entity_key = e.idempotency_key)
                 OR EXISTS (SELECT 1 FROM documents d WHERE d.entity_key = e.idempotency_key))
          ORDER BY e.idempotency_key`,
      )
      .all() as SynthesisCandidate[];

    const insertCompany = db.prepare(
      `INSERT INTO companies
         (company_id, tenant_id, status, provider, environment, synthetic,
          name_options, business_purpose, industry_label, intake_synthesized,
          legal_name_filed, filed_at, filing_number, ein, created_at, updated_at)
       VALUES (@company_id, @tenant_id, @status, @provider, @environment, @synthetic,
               @name_options, @business_purpose, @industry_label, 1,
               NULL, @filed_at, @filing_number, @ein, @created_at, @updated_at)`,
    );
    const attachEntity = db.prepare(
      "UPDATE entities SET company_id = ? WHERE idempotency_key = ? AND company_id IS NULL",
    );
    // Every party of this entity, ERASED ONES INCLUDED: the link is what keeps the audit trail
    // readable, and an erased row has nothing left to protect.
    const attachParty = db.prepare(
      "UPDATE formation_parties SET company_id = ? WHERE entity_key = ? AND company_id IS NULL",
    );
    // Index ids and file paths are NOT re-derived: manifests commit to {type, sha256, name}, so
    // the bytes and their hashes must not move. The column is the lookup key from here on.
    const attachDocs = db.prepare(
      "UPDATE documents SET company_id = ? WHERE entity_key = ? AND company_id IS NULL",
    );

    for (const c of candidates) {
      const companyId = randomUUID();
      insertCompany.run({
        company_id: companyId,
        // Every company has an owner. A legacy row with no tenant falls back to its party's
        // tenant and then to the guardian address, which is the tenant id by construction.
        tenant_id: c.owner_tenant_id ?? c.party_tenant ?? c.guardian,
        // The COMPANY-level twin of the legacy step's verdict (§4.6: `abandoned` has three
        // writers and all three move the step and the company together). A synthesized `ready`
        // over an abandoned create said the filing was still open, which put the company back in
        // `listUnopened`'s reach — an abandoned formation re-opened by the first sweep after the
        // upgrade — and made it attachable and quota-chargeable again.
        status: c.create_state === "abandoned" ? "abandoned" : "ready",
        provider: c.provider ?? "doola",
        // Straight from the entity's own pin. Step 1b has already refused every row that has
        // none, because there is no honest value to invent for a column that routes a filing.
        environment: c.environment,
        synthetic: c.party_synthetic ?? 0,
        name_options: JSON.stringify(companyNameOptions(c.name)),
        business_purpose: purposeOf(c.spec_json),
        industry_label: DEFAULT_INDUSTRY,
        // The legal facts move to the company row. The entity columns stay populated (nothing
        // reads them after this migration) so the move is reversible by inspection.
        filed_at: c.filed_at,
        filing_number: c.filing_number,
        ein: c.ein,
        created_at: c.created_at,
        updated_at: c.updated_at,
      });
      attachEntity.run(companyId, c.key);
      attachParty.run(companyId, c.key);
      attachDocs.run(companyId, c.key);
    }

    // ── Step 3: REBUILD `formation_requests` on the new key. SQLite cannot alter a primary key,
    //    and the house precedent for a populated-table rebuild is refuse-unless-clean — which
    //    step 1 has just guaranteed for the only rows that could be harmed.
    //
    //    The INSERT enumerates columns and copies the timestamps VERBATIM. `updated_at` is what
    //    `factsMovedSince`, the anchor scheduler's UNION arm, the retry clock, the stall detector
    //    and `listPollDue` all read: re-stamping it would make every formed entity due forever
    //    and starve the 50-row anchor batch on the first tick after the upgrade.
    const legacyCount = (
      db.prepare("SELECT COUNT(*) AS n FROM formation_requests").get() as { n: number }
    ).n;
    db.exec("ALTER TABLE formation_requests RENAME TO formation_requests_legacy");
    db.exec(FORMATION_REQUESTS_DDL);
    db.exec(
      `INSERT INTO formation_requests
         (company_id, step, state, attempt, provider_ref, detail, error, next_poll_at,
          created_at, updated_at, facts_updated_at)
       SELECT e.company_id, l.step, l.state, l.attempt, l.provider_ref, l.detail, l.error,
              l.next_poll_at, l.created_at, l.updated_at, l.updated_at
         FROM formation_requests_legacy l
         JOIN entities e ON e.idempotency_key = l.entity_key
        WHERE e.company_id IS NOT NULL`,
    );
    const movedCount = (
      db.prepare("SELECT COUNT(*) AS n FROM formation_requests").get() as { n: number }
    ).n;
    if (movedCount !== legacyCount)
      throw new Error(
        `refusing to migrate: ${legacyCount} formation_requests row(s) went in and ${movedCount} came out — some belong to an entity the company synthesis did not cover, and dropping a sub-saga row would strand a real filing. Nothing has been changed.`,
      );
    db.exec("DROP TABLE formation_requests_legacy");
    db.exec("CREATE INDEX IF NOT EXISTS idx_formation_state ON formation_requests(state, step)");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_formation_provider ON formation_requests(provider_ref)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_formation_poll_due ON formation_requests(next_poll_at, company_id)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_formation_created ON formation_requests(step, created_at)",
    );

    // ── Step 4: THE POST-MIGRATION ASSERTION, inside the transaction. A live party bound to an
    //    entity and attached to no company is the exact shape `listStaleUnbound` would erase, and
    //    what it would erase is the responsible party of a real Wyoming filing.
    const orphans = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM formation_parties
            WHERE deleted_at IS NULL AND entity_key IS NOT NULL AND company_id IS NULL`,
        )
        .get() as { n: number }
    ).n;
    if (orphans > 0)
      throw new Error(
        `refusing to migrate: ${orphans} bound formation part${orphans === 1 ? "y" : "ies"} would be left with no company, and the erasure sweep reads an unattached party as "never used". Nothing has been changed.`,
      );

    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '1')").run(COMPANY_REKEY_MARKER);
  })();

  dropRetiredIndexes(db);
}

/**
 * Indexes this schema used to carry and no longer earns.
 *
 * `idx_formation_facts` was built for the anchor scheduler's UNION arm, which compared
 * `facts_updated_at` per row. Since the arm became a per-COMPANY aggregate (2026-08-26 §3) NO
 * query has a predicate or an ordering on that column alone — it is only ever read as `MAX(...)`
 * inside a group — so the index is pure write amplification on the hottest write path in the
 * formation loop.
 *
 * `idx_companies_tenant` was `(tenant_id, status)`; `listByTenant` orders by
 * `created_at DESC`, and `idx_companies_tenant_created` is what actually serves it.
 *
 * Idempotent, and run on every boot: `CREATE INDEX IF NOT EXISTS` will not redefine an index that
 * already exists under the same name, so dropping by name is the only way an upgraded box gets
 * the new shape.
 */
function dropRetiredIndexes(db: Database.Database): void {
  db.exec("DROP INDEX IF EXISTS idx_formation_facts");
  db.exec("DROP INDEX IF EXISTS idx_companies_tenant");
}

interface SynthesisCandidate {
  key: string;
  name: string;
  spec_json: string | null;
  owner_tenant_id: string | null;
  guardian: string;
  provider: string | null;
  environment: string | null;
  ein: string | null;
  filed_at: number | null;
  filing_number: string | null;
  created_at: string;
  updated_at: string;
  party_tenant: string | null;
  party_synthetic: number | null;
  /** The legacy `create_provider` state, which the synthesized company's status mirrors. */
  create_state: string | null;
}

/** The business purpose a migrated company inherits: the description the entity was forwarding to
 *  doola, or the default. A corrupt spec blob yields the default rather than throwing — this is a
 *  migration, and an unreadable blob must never be the reason a box cannot boot. */
function purposeOf(specJson: string | null): string {
  if (!specJson) return DEFAULT_DESCRIPTION;
  try {
    const spec = JSON.parse(specJson) as { metadata?: { description?: unknown } };
    const d = spec.metadata?.description;
    return typeof d === "string" && d.trim() ? d.trim() : DEFAULT_DESCRIPTION;
  } catch {
    return DEFAULT_DESCRIPTION;
  }
}
