import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { type Address, type Hex, getAddress, isAddress } from "viem";
import { redactPii } from "../formation/pii";

/**
 * LEGAL BODIES: the legal wrapper ordered for an agent identity its customer already owns, one row
 * per body order, in tables of their own (`LEGAL_BODIES_DDL` in db.ts lists the invariants the
 * database itself enforces, whoever writes).
 *
 * The lifecycle, and the one method that makes each move:
 *
 *   draft ──freezeAgreement──▶ draft (agreement frozen) ──reserve──▶ reserved
 *   reserved ──markDeployed──▶ deployed          reserved ──lapse──▶ lapsed
 *   deployed | broken | superseded ──markLinked──▶ linked
 *   linked ──markBroken──▶ broken                deployed | broken ──supersede──▶ superseded
 *   draft ──abandon──▶ abandoned (closed for good: it never held an agentId or a body address)
 *
 * Every move is ONE compare-and-set UPDATE whose WHERE names the states it may leave, and the
 * caller learns whether IT made the move from whether that UPDATE changed a row, so two callers
 * racing for the same move cannot both win. The move and its event are written in one
 * transaction: the log never records a move that did not happen, or misses one that did.
 */

export type BindingState =
  | "draft"
  | "reserved"
  | "deployed"
  | "linked"
  | "broken"
  | "lapsed"
  | "superseded"
  | "abandoned";

/**
 * The states that hold an agentId: at most one row per (chain, agentId) is in one of them, which
 * the partial unique index `idx_legal_bodies_live_agent` enforces with this same list.
 */
export const LIVE_BINDING_STATES: readonly BindingState[] = ["reserved", "deployed", "linked"];

export type LegalBodyEventKind =
  | "created"
  | "agreement_frozen"
  | "link_accepted"
  | "deploy_submitted"
  | "deployed"
  | "linked"
  | "broken"
  | "lapsed"
  | "superseded"
  | "abandoned"
  | "revoked"
  | "statement_signed"
  | "note";

export type LegalBodyActor = "system" | "tenant" | `operator:${string}`;

export interface LegalBodyRecord {
  legalBodyId: string;
  publicId: string;
  tenantId: Address;
  companyId: string;
  chainId: number;
  factory: Address;
  /** Always the tenant: the human's signed-in wallet guards the body (a CHECK, not a convention). */
  guardian: Address;
  /** Seconds, within the factory's bounds (48 hours .. 30 days). */
  amendmentDelay: number;
  /** Hashes are stored lower-case: this one, the link digest and the deploy hash. */
  oaManifestHash: Hex | null;
  /** 1 or more; set together with the hash. */
  oaManifestVersion: number | null;
  /** The ERC-8004 agentId, a uint256 in canonical decimal. */
  agentId: string | null;
  identityOwner: Address | null;
  linkDigest: Hex | null;
  /** Unix seconds. */
  linkDeadline: number | null;
  linkSignature: Hex | null;
  bodyAddress: Address | null;
  createTxHash: Hex | null;
  /** Unix seconds: the time of the block that created the body. */
  deployedAt: number | null;
  bindingState: BindingState;
  /** Unix seconds: the first sighting of the pointer in the current linked stretch. */
  pointerSeenAt: number | null;
  /** Unix MILLISECONDS, unlike the chain times above: the process clock schedules the checks. */
  nextBindingCheckAt: number | null;
  /** Milliseconds. */
  bindingCheckIntervalMs: number | null;
  /** UTC, `YYYY-MM-DD HH:MM:SS`, like `updatedAt`. */
  createdAt: string;
  updatedAt: string;
}

export interface LegalBodyEvent {
  id: number;
  legalBodyId: string;
  kind: LegalBodyEventKind;
  actor: LegalBodyActor;
  txHash: Hex | null;
  /** The recorded detail. SSN-shaped numbers in its strings were redacted at the write, and
   *  nothing else was (see `recordEvent`). */
  detail: unknown;
  createdAt: string;
}

export type ReserveOutcome = "reserved" | "agent_taken" | "body_taken" | "not_draft" | "not_frozen";

export interface LegalBodyRepository {
  /**
   * A new `draft`, guarded by its tenant, with its `created` event, in one write. Throws a
   * `LegalBodyInputError`, before writing, for an amendment delay that is not a whole number of
   * seconds, a chain id that is not a positive whole number, or a tenant or factory that is not
   * an address. Throws the database's own refusal for a delay outside the contract's bounds and
   * for a company that is missing or belongs to another tenant.
   */
  create(p: {
    tenantId: Address;
    companyId: string;
    chainId: number;
    factory: Address;
    amendmentDelay: number;
  }): LegalBodyRecord;
  findById(legalBodyId: string): LegalBodyRecord | undefined;
  /** A body the tenant owns. Undefined for unknown AND for not-yours, deliberately: telling them
   *  apart would make a route an existence oracle over other tenants' ids. */
  findOwned(tenantId: string, legalBodyId: string): LegalBodyRecord | undefined;
  findByPublicId(publicId: string): LegalBodyRecord | undefined;
  /** The body holding `agentId` on `chainId` right now, if any (see LIVE_BINDING_STATES). Leading
   *  zeros are normalized away; a value that is not a uint256 in decimal holds nothing. */
  findLiveByAgentId(chainId: number, agentId: string): LegalBodyRecord | undefined;
  /** Any casing of the address matches; a value that is not an address matches nothing. */
  findByBodyAddress(chainId: number, body: Address): LegalBodyRecord | undefined;
  /** Newest first. */
  listByTenant(tenantId: string): LegalBodyRecord[];
  /** Newest first. */
  listByCompany(companyId: string): LegalBodyRecord[];
  /**
   * Freeze the operating agreement: once, and only while `draft`. The hash is a 32-byte hash,
   * stored lower-case; the version a whole number, 1 or more. False, with nothing written and
   * nothing logged, when the body is not an unfrozen draft AND when the hash or the version is
   * missing or malformed: no agreement, no freeze.
   */
  freezeAgreement(legalBodyId: string, a: { hash: Hex; version: number }): boolean;
  /**
   * Accept the identity owner's signed link: `draft` (agreement frozen) → `reserved`.
   *
   * Losing a race is an answer, never an exception: `agent_taken` when another body holds the
   * agentId live on this chain (it takes precedence when the body address collides too),
   * `body_taken` when another row already recorded the body address, in any casing.
   *
   * Throws a `LegalBodyInputError`, before anything is written and whatever the body's state, for
   * input no row may hold: an agentId that is not a uint256 in decimal, an owner or a body that
   * is not an address, a digest that is not a 32-byte hash, a signature that is not one or more
   * whole bytes of hex, or a deadline that is not a whole number of unix SECONDS. The digest and
   * the signature are stored lower-case. A body address the table refuses (the zero address, the
   * factory itself) surfaces as the table's own CHECK failure.
   */
  reserve(
    legalBodyId: string,
    l: {
      agentId: string;
      identityOwner: Address;
      linkDigest: Hex;
      linkDeadline: number;
      linkSignature: Hex;
      bodyAddress: Address;
    },
  ): ReserveOutcome;
  /**
   * Record a deploy transaction as sent (while `reserved` only), raw bytes in the event log.
   * Throws a `LegalBodyInputError`, before writing, for a hash that is not a 32-byte hash, raw
   * bytes that are not whole bytes of hex, or a nonce that is not a whole number, zero or more.
   */
  recordDeploySubmission(
    legalBodyId: string,
    s: { txHash: Hex; rawTx: Hex; nonce: number },
  ): boolean;
  /**
   * `reserved` → `deployed`, with the hash of the transaction that created the body (stored
   * lower-case) and the time of its block in unix SECONDS. Throws a `LegalBodyInputError`, before
   * writing, for a malformed hash or a time that is not in seconds.
   */
  markDeployed(legalBodyId: string, d: { txHash: Hex; deployedAt: number }): boolean;
  lapse(legalBodyId: string, reason: string): boolean;
  /**
   * Close a `draft` for good: `draft` → `abandoned`, frozen agreement or not. A draft's company,
   * delay and agreement are write-once and rows are never deleted, so an order opened by mistake,
   * or never signed, is closed rather than corrected. Nothing leaves `abandoned`.
   */
  abandon(legalBodyId: string, reason: string): boolean;
  /**
   * `deployed` | `broken` | `superseded` → `linked`. False when the body is in none of these
   * states, AND when another body holds the same agentId live: `broken` and `superseded` are not
   * live states, so a new reservation can take the agentId in the meantime, and linking this body
   * again would make two live bodies for one identity. The caller must resolve that collision;
   * which body keeps the agentId is the binding sweeper's policy, not this repository's. Nothing
   * is recorded either way.
   */
  markLinked(legalBodyId: string, seenAt: number): boolean;
  markBroken(legalBodyId: string, detail: Record<string, unknown>): boolean;
  /**
   * `deployed` | `broken` → `superseded`: the body gives its agentId up, which frees it for a new
   * link. Not final. Which body an identity's owner names is decided on chain, where a body that
   * was set aside can be named again, so `markLinked` takes a superseded body back to `linked`
   * once the agentId is free.
   */
  supersede(legalBodyId: string, bySupersedingId: string): boolean;
  /**
   * Set the next binding check: `nextAt` in unix MILLISECONDS (zero or more) with `intervalMs`
   * (one or more), or null with null to take the row off the schedule. Anything else, a NaN out
   * of a caller's arithmetic included, throws a `LegalBodyInputError`.
   *
   * Answers whether a row was updated. A `draft`, an `abandoned` and a `lapsed` row are never
   * updated, and nor is an unknown id: there is nothing on chain to check for them. So a row is
   * taken off the schedule BEFORE it lapses; once it has lapsed, its schedule no longer changes.
   * Not a state change, so no event.
   */
  scheduleBindingCheck(
    legalBodyId: string,
    nextAt: number | null,
    intervalMs: number | null,
  ): boolean;
  /**
   * Rows whose next binding check is due at `now` (unix MILLISECONDS, zero or more), soonest
   * first, at most `limit` (one or more) of them. Throws a `LegalBodyInputError` for anything
   * else: to SQLite a negative limit means no limit at all.
   */
  listBindingDue(now: number, limit: number): LegalBodyRecord[];
  /**
   * Append one event.
   *
   * EVENT DETAIL MUST NOT CARRY PERSONAL DATA. The log is append-only and has no erasure path: a
   * name, an email address, a date of birth or a provider's error text that quotes one would stay
   * for good. The only safety net is narrow: SSN-shaped numbers are redacted from every string in
   * `detail` (values and keys, at any depth) before it is written. Nothing else is recognised or
   * removed, so keep detail to ids, hashes, addresses, numbers and wording of our own.
   *
   * Numbers, booleans and null are stored exactly, so numeric facts (nonces, block numbers,
   * amounts, timestamps) must be written as numbers: a nine-digit value written as a STRING is
   * SSN-shaped to the redactor, and is redacted. So is the string `0x` followed by exactly nine
   * decimal digits; hashes, addresses and raw transactions are left alone. A `bigint` is stored as
   * a number when it is within the safe integer range, and throws a `LegalBodyInputError` when it
   * is not (nothing is written, and a move that was being recorded is rolled back with it).
   */
  recordEvent(
    legalBodyId: string,
    kind: LegalBodyEventKind,
    actor: LegalBodyActor,
    txHash: Hex | null,
    detail: Record<string, unknown> | null,
  ): void;
  /** Oldest first. */
  listEvents(legalBodyId: string): LegalBodyEvent[];
  /** Run fn inside a single SQLite transaction (atomic; rolls back if fn throws). */
  transaction<T>(fn: () => T): T;
}

interface Row {
  legal_body_id: string;
  public_id: string;
  tenant_id: string;
  company_id: string;
  chain_id: number;
  factory: string;
  guardian: string;
  amendment_delay: number;
  oa_manifest_hash: string | null;
  oa_manifest_version: number | null;
  agent_id: string | null;
  identity_owner: string | null;
  link_digest: string | null;
  link_deadline: number | null;
  link_signature: string | null;
  body_address: string | null;
  create_tx_hash: string | null;
  deployed_at: number | null;
  binding_state: BindingState;
  pointer_seen_at: number | null;
  next_binding_check_at: number | null;
  binding_check_interval_ms: number | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  legal_body_id: string;
  kind: string;
  actor: string;
  tx_hash: string | null;
  detail: string | null;
  created_at: string;
}

function toRecord(r: Row): LegalBodyRecord {
  return {
    legalBodyId: r.legal_body_id,
    publicId: r.public_id,
    tenantId: r.tenant_id as Address,
    companyId: r.company_id,
    chainId: r.chain_id,
    factory: r.factory as Address,
    guardian: r.guardian as Address,
    amendmentDelay: r.amendment_delay,
    oaManifestHash: r.oa_manifest_hash as Hex | null,
    oaManifestVersion: r.oa_manifest_version,
    agentId: r.agent_id,
    identityOwner: r.identity_owner as Address | null,
    linkDigest: r.link_digest as Hex | null,
    linkDeadline: r.link_deadline,
    linkSignature: r.link_signature as Hex | null,
    bodyAddress: r.body_address as Address | null,
    createTxHash: r.create_tx_hash as Hex | null,
    deployedAt: r.deployed_at,
    bindingState: r.binding_state,
    pointerSeenAt: r.pointer_seen_at,
    nextBindingCheckAt: r.next_binding_check_at,
    bindingCheckIntervalMs: r.binding_check_interval_ms,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Every string in a JSON tree, values and keys alike, through the redactor of SSN-shaped numbers;
 * numbers, booleans and null untouched.
 *
 * Redacting the serialized blob instead would treat a nine-digit NUMBER as an SSN, since the
 * redactor sees digits, not types. It would turn `{"nonce":123456789}` into `{"nonce":[redacted]}`,
 * destroying a block number or a nonce and leaving text that is no longer JSON. Keys are redacted
 * too because they are text like any other: the blob redaction this replaces covered them.
 */
function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return redactPii(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [redactPii(key), redactStrings(inner)]),
    );
  return value;
}

/**
 * A bigint as the JSON number it stands for. Chain libraries return block numbers, nonces and
 * timestamps as bigint, and `JSON.stringify` refuses the type outright. Outside the safe integer
 * range a number would be silently rounded, so that is refused instead.
 */
function exactNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
    throw new LegalBodyInputError(
      "event detail holds a bigint outside the safe integer range, which a JSON number cannot hold exactly",
    );
  return Number(value);
}

/**
 * The detail as it is stored. First it becomes plain JSON data, what `JSON.stringify` makes of
 * it: a Date becomes its ISO string, an undefined field is dropped, and a bigint becomes a number
 * (see `exactNumber`). Then its strings are redacted. The result is always valid JSON.
 */
function serializeDetail(detail: Record<string, unknown>): string {
  const plain: unknown = JSON.parse(
    JSON.stringify(detail, (_key, value: unknown) =>
      typeof value === "bigint" ? exactNumber(value) : value,
    ),
  );
  return JSON.stringify(redactStrings(plain));
}

/**
 * The stored detail, parsed back; null stays null.
 *
 * Everything `recordEvent` writes is valid JSON. A row written around it, by raw SQL, might not
 * be, and that detail comes back as the stored text rather than throwing: one unreadable event
 * must never make a legal body's whole history unreadable.
 */
function parseDetail(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * An address in the one form rows store it: checksummed, so a lookup matches whatever casing the
 * caller holds. Null when the value is not an address at all, which no row can hold.
 */
function checksummed(value: string): Address | null {
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

/**
 * A value handed to the repository that no row may hold: a hash that is not one, a time in the
 * wrong unit, a chain id of zero. It is a bug in the caller, never the outcome of a race, so it is
 * thrown, before anything is written, rather than answered.
 */
export class LegalBodyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalBodyInputError";
  }
}

/** The address in the form rows store it, or a `LegalBodyInputError` naming the field. */
function requireAddress(field: string, value: unknown): Address {
  const address = typeof value === "string" ? checksummed(value) : null;
  if (address === null) throw new LegalBodyInputError(`${field} must be a 0x address`);
  return address;
}

const HASH_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;

/**
 * A 32-byte hash in the one spelling rows store it: lower-case, so a stored hash compares as text
 * with the same hash read from anywhere else. Null when the value is not a 32-byte hash at all.
 */
function lowerHash(value: unknown): Hex | null {
  return typeof value === "string" && HASH_32.test(value) ? (value.toLowerCase() as Hex) : null;
}

function requireHash(field: string, value: unknown): Hex {
  const hash = lowerHash(value);
  if (hash === null)
    throw new LegalBodyInputError(`${field} must be 0x and 64 hex digits (a 32-byte hash)`);
  return hash;
}

/** One or more whole bytes of hex, lower-cased. */
function requireBytes(field: string, value: unknown): Hex {
  if (typeof value !== "string" || !HEX_BYTES.test(value))
    throw new LegalBodyInputError(`${field} must be 0x and one or more whole bytes of hex`);
  return value.toLowerCase() as Hex;
}

/** The largest time the seconds columns hold. A time in milliseconds is past it for centuries. */
const MAX_UNIX_SECONDS = 99_999_999_999;

/** A time in unix SECONDS, the unit of a block timestamp. */
function requireSeconds(field: string, value: unknown): number {
  if (!isIntegerWithin(value, 1, MAX_UNIX_SECONDS))
    throw new LegalBodyInputError(
      `${field} must be a whole number of unix seconds (1 to ${MAX_UNIX_SECONDS}), got ${String(value)}`,
    );
  return value;
}

/** A JS number that is an exact integer in [min, max]: not a string, a bigint, NaN or a fraction. */
function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

const UINT256_MAX = 2n ** 256n - 1n;

/**
 * An agentId in the one spelling rows store it: a uint256 in decimal without leading zeros.
 *
 * The one-live-body-per-agent index compares `agent_id` as TEXT, so "042" and "42" would be two
 * agents to it, and the same identity could hold two live bodies. Null when the value is not a
 * uint256 in decimal at all.
 */
function canonicalAgentId(value: string): string | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const n = BigInt(value);
  return n <= UINT256_MAX ? n.toString() : null;
}

/** The live-state predicate, spelled exactly as the partial index's WHERE so SQLite can use it. */
const LIVE_STATES_SQL = `binding_state IN (${LIVE_BINDING_STATES.map((s) => `'${s}'`).join(",")})`;

/**
 * How SQLite names each unique index in its violation message, which is how a lost race is told
 * apart. A column index is named by its columns; an EXPRESSION index, like the body-address one
 * on `lower(body_address)`, is named only by its index name. The schema tests pin both messages.
 */
const LIVE_AGENT_CONFLICT = "legal_bodies.chain_id, legal_bodies.agent_id";
const BODY_ADDRESS_CONFLICT = "index 'idx_legal_bodies_body'";

export class SqliteLegalBodyRepository implements LegalBodyRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO legal_bodies
           (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian,
            amendment_delay)
         VALUES (@legal_body_id, @public_id, @tenant_id, @company_id, @chain_id, @factory,
                 @guardian, @amendment_delay)`,
      ),
      findById: db.prepare("SELECT * FROM legal_bodies WHERE legal_body_id = ?"),
      findOwned: db.prepare("SELECT * FROM legal_bodies WHERE legal_body_id = ? AND tenant_id = ?"),
      findByPublicId: db.prepare("SELECT * FROM legal_bodies WHERE public_id = ?"),
      findLiveByAgentId: db.prepare(
        `SELECT * FROM legal_bodies WHERE chain_id = ? AND agent_id = ? AND ${LIVE_STATES_SQL}`,
      ),
      // Compares the lower-case form, exactly as the unique index on (chain_id,
      // lower(body_address)) does: the lookup and the index then agree on every row, whatever
      // casing it was stored in, and SQLite answers the lookup through that index.
      findByBodyAddress: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE chain_id = @chain_id AND lower(body_address) = lower(@address)`,
      ),
      listByTenant: db.prepare(
        "SELECT * FROM legal_bodies WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC",
      ),
      listByCompany: db.prepare(
        "SELECT * FROM legal_bodies WHERE company_id = ? ORDER BY created_at DESC, rowid DESC",
      ),
      // Each move below sets EVERY column its target state requires in the same statement: the
      // table's CHECKs are evaluated on the row an UPDATE produces, so a move split across two
      // statements would be refused halfway.
      freeze: db.prepare(
        `UPDATE legal_bodies
            SET oa_manifest_hash = ?, oa_manifest_version = ?, updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state = 'draft' AND oa_manifest_hash IS NULL`,
      ),
      reserve: db.prepare(
        `UPDATE legal_bodies
            SET agent_id = @agent_id, identity_owner = @identity_owner,
                link_digest = @link_digest, link_deadline = @link_deadline,
                link_signature = @link_signature, body_address = @body_address,
                binding_state = 'reserved', updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = @legal_body_id AND binding_state = 'draft'
            AND oa_manifest_hash IS NOT NULL`,
      ),
      // Not write-once, on purpose: a deploy that never lands is re-sent with a new nonce while
      // the row is still `reserved`, and every submission is kept in the event log.
      recordDeploySubmission: db.prepare(
        `UPDATE legal_bodies SET create_tx_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state = 'reserved'`,
      ),
      markDeployed: db.prepare(
        `UPDATE legal_bodies
            SET create_tx_hash = ?, deployed_at = ?, binding_state = 'deployed',
                updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state = 'reserved'`,
      ),
      lapse: db.prepare(
        `UPDATE legal_bodies SET binding_state = 'lapsed', updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state = 'reserved'`,
      ),
      abandon: db.prepare(
        `UPDATE legal_bodies SET binding_state = 'abandoned', updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state = 'draft'`,
      ),
      markLinked: db.prepare(
        `UPDATE legal_bodies
            SET binding_state = 'linked', pointer_seen_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state IN ('deployed','broken','superseded')`,
      ),
      markBroken: db.prepare(
        `UPDATE legal_bodies SET binding_state = 'broken', updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state = 'linked'`,
      ),
      supersede: db.prepare(
        `UPDATE legal_bodies SET binding_state = 'superseded', updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state IN ('deployed','broken')`,
      ),
      scheduleBindingCheck: db.prepare(
        `UPDATE legal_bodies SET next_binding_check_at = ?, binding_check_interval_ms = ?
          WHERE legal_body_id = ? AND binding_state NOT IN ('draft','abandoned','lapsed')`,
      ),
      listBindingDue: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE next_binding_check_at IS NOT NULL AND next_binding_check_at <= ?
          ORDER BY next_binding_check_at, legal_body_id LIMIT ?`,
      ),
      insertEvent: db.prepare(
        `INSERT INTO legal_body_events (legal_body_id, kind, actor, tx_hash, detail)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      listEvents: db.prepare("SELECT * FROM legal_body_events WHERE legal_body_id = ? ORDER BY id"),
    };
  }

  create(p: {
    tenantId: Address;
    companyId: string;
    chainId: number;
    factory: Address;
    amendmentDelay: number;
  }): LegalBodyRecord {
    // Refused here, before anything is written, with a message that names the field: the table
    // refuses each of these too, but as a bare CHECK failure.
    if (typeof p.amendmentDelay !== "number" || !Number.isInteger(p.amendmentDelay))
      throw new LegalBodyInputError(
        `amendmentDelay must be a whole number of seconds, got ${String(p.amendmentDelay)}`,
      );
    if (!isIntegerWithin(p.chainId, 1, Number.MAX_SAFE_INTEGER))
      throw new LegalBodyInputError(
        `chainId must be a positive whole number, got ${String(p.chainId)}`,
      );
    const tenantId = requireAddress("tenantId", p.tenantId);
    const factory = requireAddress("factory", p.factory);
    const legalBodyId = `lb_${randomUUID()}`;
    return this.db.transaction(() => {
      this.stmts.insert.run({
        legal_body_id: legalBodyId,
        public_id: randomUUID(),
        tenant_id: tenantId,
        company_id: p.companyId,
        chain_id: p.chainId,
        factory,
        guardian: tenantId,
        amendment_delay: p.amendmentDelay,
      });
      this.recordEvent(legalBodyId, "created", "system", null, null);
      const created = this.findById(legalBodyId);
      if (!created) throw new Error(`legal body ${legalBodyId} vanished inside its own insert`);
      return created;
    })();
  }

  findById(legalBodyId: string): LegalBodyRecord | undefined {
    const r = this.stmts.findById.get(legalBodyId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findOwned(tenantId: string, legalBodyId: string): LegalBodyRecord | undefined {
    const tenant = checksummed(tenantId);
    if (tenant === null) return undefined;
    const r = this.stmts.findOwned.get(legalBodyId, tenant) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findByPublicId(publicId: string): LegalBodyRecord | undefined {
    const r = this.stmts.findByPublicId.get(publicId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findLiveByAgentId(chainId: number, agentId: string): LegalBodyRecord | undefined {
    const agent = canonicalAgentId(agentId);
    if (agent === null) return undefined;
    const r = this.stmts.findLiveByAgentId.get(chainId, agent) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findByBodyAddress(chainId: number, body: Address): LegalBodyRecord | undefined {
    const address = checksummed(body);
    if (address === null) return undefined;
    const r = this.stmts.findByBodyAddress.get({ chain_id: chainId, address }) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  listByTenant(tenantId: string): LegalBodyRecord[] {
    const tenant = checksummed(tenantId);
    if (tenant === null) return [];
    return (this.stmts.listByTenant.all(tenant) as Row[]).map(toRecord);
  }

  listByCompany(companyId: string): LegalBodyRecord[] {
    return (this.stmts.listByCompany.all(companyId) as Row[]).map(toRecord);
  }

  freezeAgreement(legalBodyId: string, a: { hash: Hex; version: number }): boolean {
    // No agreement, no freeze: a missing or malformed hash or version is answered like any other
    // freeze that did not happen, before the UPDATE runs. A NULL hash would otherwise match the
    // draft, change the row without freezing anything, and leave a false event in the log.
    const hash = lowerHash(a.hash);
    if (hash === null || !isIntegerWithin(a.version, 1, Number.MAX_SAFE_INTEGER)) return false;
    return this.move(
      legalBodyId,
      () => this.stmts.freeze.run(hash, a.version, legalBodyId),
      "agreement_frozen",
      null,
      { version: a.version },
    );
  }

  reserve(
    legalBodyId: string,
    l: {
      agentId: string;
      identityOwner: Address;
      linkDigest: Hex;
      linkDeadline: number;
      linkSignature: Hex;
      bodyAddress: Address;
    },
  ): ReserveOutcome {
    const agentId = canonicalAgentId(l.agentId);
    if (agentId === null)
      throw new LegalBodyInputError(
        `agentId must be a uint256 in decimal, got ${JSON.stringify(l.agentId)}`,
      );
    const identityOwner = requireAddress("identityOwner", l.identityOwner);
    const bodyAddress = requireAddress("bodyAddress", l.bodyAddress);
    const linkDigest = requireHash("linkDigest", l.linkDigest);
    const linkSignature = requireBytes("linkSignature", l.linkSignature);
    const linkDeadline = requireSeconds("linkDeadline", l.linkDeadline);

    const row = this.stmts.findById.get(legalBodyId) as Row | undefined;
    if (!row || row.binding_state !== "draft") return "not_draft";
    if (row.oa_manifest_hash === null) return "not_frozen";

    try {
      return this.db.transaction((): ReserveOutcome => {
        const { changes } = this.stmts.reserve.run({
          legal_body_id: legalBodyId,
          agent_id: agentId,
          identity_owner: identityOwner,
          link_digest: linkDigest,
          link_deadline: linkDeadline,
          link_signature: linkSignature,
          body_address: bodyAddress,
        });
        // Zero rows: another caller moved this body out of draft between the read and the write.
        if (changes !== 1) return "not_draft";
        this.recordEvent(legalBodyId, "link_accepted", "system", null, null);
        return "reserved";
      })();
    } catch (e) {
      // The two unique indexes ARE the race guard: whoever loses a race for an agentId or a body
      // address lands here, and gets an answer rather than an exception.
      if ((e as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") throw e;
      const message = e instanceof Error ? e.message : String(e);
      // A live holder of the agentId wins the precedence, whichever index SQLite names. The body
      // address is derived from the signed link digest, so one tenant ordering twice for one
      // agent with the same agreement and deadline collides on BOTH indexes, and SQLite reports
      // only one of them (in practice the body index).
      if (
        message.includes(LIVE_AGENT_CONFLICT) ||
        this.stmts.findLiveByAgentId.get(row.chain_id, agentId)
      )
        return "agent_taken";
      if (message.includes(BODY_ADDRESS_CONFLICT)) return "body_taken";
      throw e;
    }
  }

  recordDeploySubmission(
    legalBodyId: string,
    s: { txHash: Hex; rawTx: Hex; nonce: number },
  ): boolean {
    const txHash = requireHash("txHash", s.txHash);
    const rawTx = requireBytes("rawTx", s.rawTx);
    if (!isIntegerWithin(s.nonce, 0, Number.MAX_SAFE_INTEGER))
      throw new LegalBodyInputError(
        `nonce must be a whole number, zero or more, got ${String(s.nonce)}`,
      );
    return this.move(
      legalBodyId,
      () => this.stmts.recordDeploySubmission.run(txHash, legalBodyId),
      "deploy_submitted",
      txHash,
      { rawTx, nonce: s.nonce },
    );
  }

  markDeployed(legalBodyId: string, d: { txHash: Hex; deployedAt: number }): boolean {
    const txHash = requireHash("txHash", d.txHash);
    const deployedAt = requireSeconds("deployedAt", d.deployedAt);
    return this.move(
      legalBodyId,
      () => this.stmts.markDeployed.run(txHash, deployedAt, legalBodyId),
      "deployed",
      txHash,
      null,
    );
  }

  lapse(legalBodyId: string, reason: string): boolean {
    return this.move(legalBodyId, () => this.stmts.lapse.run(legalBodyId), "lapsed", null, {
      reason,
    });
  }

  abandon(legalBodyId: string, reason: string): boolean {
    return this.move(legalBodyId, () => this.stmts.abandon.run(legalBodyId), "abandoned", null, {
      reason,
    });
  }

  markLinked(legalBodyId: string, seenAt: number): boolean {
    try {
      // `seenAt` goes into the event too: the column is overwritten by every re-link, the log
      // keeps each sighting.
      return this.move(
        legalBodyId,
        () => this.stmts.markLinked.run(seenAt, legalBodyId),
        "linked",
        null,
        { seenAt },
      );
    } catch (e) {
      // The one refusal that is an answer: another body holds this agentId live (the partial
      // unique index on live agentIds). The move and its event were rolled back together, so
      // nothing is recorded. Anything else is a real failure, and it propagates.
      if (
        (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
        e instanceof Error &&
        e.message.includes(LIVE_AGENT_CONFLICT)
      )
        return false;
      throw e;
    }
  }

  markBroken(legalBodyId: string, detail: Record<string, unknown>): boolean {
    return this.move(
      legalBodyId,
      () => this.stmts.markBroken.run(legalBodyId),
      "broken",
      null,
      detail,
    );
  }

  supersede(legalBodyId: string, bySupersedingId: string): boolean {
    return this.move(legalBodyId, () => this.stmts.supersede.run(legalBodyId), "superseded", null, {
      by: bySupersedingId,
    });
  }

  scheduleBindingCheck(
    legalBodyId: string,
    nextAt: number | null,
    intervalMs: number | null,
  ): boolean {
    const cleared = nextAt === null && intervalMs === null;
    if (
      !cleared &&
      !(
        isIntegerWithin(nextAt, 0, Number.MAX_SAFE_INTEGER) &&
        isIntegerWithin(intervalMs, 1, Number.MAX_SAFE_INTEGER)
      )
    )
      throw new LegalBodyInputError(
        `a binding check is a time in unix milliseconds (zero or more) with an interval in milliseconds (one or more), or null with null; got ${String(nextAt)}, ${String(intervalMs)}`,
      );
    return this.stmts.scheduleBindingCheck.run(nextAt, intervalMs, legalBodyId).changes === 1;
  }

  listBindingDue(now: number, limit: number): LegalBodyRecord[] {
    if (!isIntegerWithin(now, 0, Number.MAX_SAFE_INTEGER))
      throw new LegalBodyInputError(
        `now must be a time in unix milliseconds, zero or more, got ${String(now)}`,
      );
    if (!isIntegerWithin(limit, 1, Number.MAX_SAFE_INTEGER))
      throw new LegalBodyInputError(
        `limit must be a whole number, one or more, got ${String(limit)}`,
      );
    return (this.stmts.listBindingDue.all(now, limit) as Row[]).map(toRecord);
  }

  recordEvent(
    legalBodyId: string,
    kind: LegalBodyEventKind,
    actor: LegalBodyActor,
    txHash: Hex | null,
    detail: Record<string, unknown> | null,
  ): void {
    // SSN-shaped numbers are redacted at the write, the rule the entity event log follows, so no
    // producer has to remember: an SSN that reached this append-only table could never be taken
    // out again. That is all the redactor removes. The rule that keeps every other kind of
    // personal data out is the one on the interface: detail must not carry any. The redactor
    // leaves hashes and addresses alone, and only strings are given to it (see redactStrings).
    this.stmts.insertEvent.run(
      legalBodyId,
      kind,
      actor,
      txHash,
      detail === null ? null : serializeDetail(detail),
    );
  }

  listEvents(legalBodyId: string): LegalBodyEvent[] {
    return (this.stmts.listEvents.all(legalBodyId) as EventRow[]).map((e) => ({
      id: e.id,
      legalBodyId: e.legal_body_id,
      kind: e.kind as LegalBodyEventKind,
      actor: e.actor as LegalBodyActor,
      txHash: e.tx_hash as Hex | null,
      detail: parseDetail(e.detail),
      createdAt: e.created_at,
    }));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * One compare-and-set move and, only if THIS call made it, its event, in one transaction.
   * The transition methods take no actor: what they record is the system observing or making
   * the move. Operator and tenant actions are written with `recordEvent`.
   */
  private move(
    legalBodyId: string,
    update: () => Database.RunResult,
    kind: LegalBodyEventKind,
    txHash: Hex | null,
    detail: Record<string, unknown> | null,
  ): boolean {
    return this.db.transaction(() => {
      if (update().changes !== 1) return false;
      this.recordEvent(legalBodyId, kind, "system", txHash, detail);
      return true;
    })();
  }
}
