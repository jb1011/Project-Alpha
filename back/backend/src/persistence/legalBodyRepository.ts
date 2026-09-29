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
 *   deployed | broken ──markLinked──▶ linked     linked ──markBroken──▶ broken
 *   deployed | broken ──supersede──▶ superseded
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
  | "superseded";

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
  oaManifestHash: Hex | null;
  oaManifestVersion: number | null;
  /** The ERC-8004 agentId, a uint256 in canonical decimal. */
  agentId: string | null;
  identityOwner: Address | null;
  linkDigest: Hex | null;
  linkDeadline: number | null;
  linkSignature: Hex | null;
  bodyAddress: Address | null;
  createTxHash: Hex | null;
  deployedAt: number | null;
  bindingState: BindingState;
  pointerSeenAt: number | null;
  nextBindingCheckAt: number | null;
  bindingCheckIntervalMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface LegalBodyEvent {
  id: number;
  legalBodyId: string;
  kind: LegalBodyEventKind;
  actor: LegalBodyActor;
  txHash: Hex | null;
  /** The recorded detail, its strings PII-redacted at the write (see `recordEvent`). */
  detail: unknown;
  createdAt: string;
}

export type ReserveOutcome = "reserved" | "agent_taken" | "body_taken" | "not_draft" | "not_frozen";

export interface LegalBodyRepository {
  /**
   * A new `draft`, guarded by its tenant, with its `created` event, in one write. Throws for an
   * amendment delay that is not a whole number of seconds, and (the database's own refusal) for
   * a company that belongs to another tenant.
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
  /** Freeze the operating agreement: once, and only while `draft`. Throws for a version that is
   *  not a whole number. */
  freezeAgreement(legalBodyId: string, a: { hash: Hex; version: number }): boolean;
  /**
   * Accept the identity owner's signed link: `draft` (agreement frozen) → `reserved`.
   *
   * Losing a race is an answer, never an exception: `agent_taken` when another body holds the
   * agentId live on this chain (it takes precedence when the body address collides too),
   * `body_taken` when another row already recorded the body address. Throws only for input no
   * row may hold: an agentId that is not a uint256 in decimal, or an address that is not one.
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
  /** Record a deploy transaction as sent (while `reserved` only), raw bytes in the event log. */
  recordDeploySubmission(
    legalBodyId: string,
    s: { txHash: Hex; rawTx: Hex; nonce: number },
  ): boolean;
  markDeployed(legalBodyId: string, d: { txHash: Hex; deployedAt: number }): boolean;
  lapse(legalBodyId: string, reason: string): boolean;
  /**
   * `deployed` | `broken` → `linked`. False when the body is in neither state, AND when another
   * body holds the same agentId live: `broken` is not a live state, so a new reservation can take
   * the agentId while this body is broken, and linking this one again would make two live bodies
   * for one identity. The caller must resolve that collision; which body keeps the agentId is the
   * binding sweeper's policy, not this repository's. Nothing is recorded either way.
   */
  markLinked(legalBodyId: string, seenAt: number): boolean;
  markBroken(legalBodyId: string, detail: Record<string, unknown>): boolean;
  supersede(legalBodyId: string, bySupersedingId: string): boolean;
  /** Not a state change, so no event. Null, null takes the row off the schedule. */
  scheduleBindingCheck(legalBodyId: string, nextAt: number | null, intervalMs: number | null): void;
  /** Rows whose next binding check is due at `now`, soonest first. */
  listBindingDue(now: number, limit: number): LegalBodyRecord[];
  /**
   * Append one event. Every string in `detail` (values and keys, at any depth) is PII-redacted
   * before it is written; numbers, booleans and null are stored exactly. So numeric facts
   * (nonces, block numbers, amounts, timestamps) must be written as JSON numbers: a nine-digit
   * value written as a STRING is SSN-shaped to the redactor, and is redacted.
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
 * Every string in a JSON tree, values and keys alike, through the PII redactor; numbers,
 * booleans and null untouched.
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
 * The detail as it is stored. First it becomes plain JSON data, exactly what `JSON.stringify`
 * makes of it: a Date becomes its ISO string and an undefined field is dropped. Then its strings
 * are redacted. The result is always valid JSON.
 */
function serializeDetail(detail: Record<string, unknown>): string {
  return JSON.stringify(redactStrings(JSON.parse(JSON.stringify(detail))));
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
      // Compares the checksummed form the repository writes. The lower() term changes no answer
      // (it is implied by the exact one); it is there so SQLite can look the address up through
      // the unique index, which is built on lower(body_address).
      findByBodyAddress: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE chain_id = @chain_id AND lower(body_address) = lower(@address)
            AND body_address = @address`,
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
      markLinked: db.prepare(
        `UPDATE legal_bodies
            SET binding_state = 'linked', pointer_seen_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE legal_body_id = ? AND binding_state IN ('deployed','broken')`,
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
          WHERE legal_body_id = ?`,
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
    // refuses a fractional delay too, but as a bare CHECK failure.
    if (!Number.isInteger(p.amendmentDelay))
      throw new Error(`amendmentDelay must be a whole number of seconds, got ${p.amendmentDelay}`);
    const tenantId = getAddress(p.tenantId);
    const legalBodyId = `lb_${randomUUID()}`;
    return this.db.transaction(() => {
      this.stmts.insert.run({
        legal_body_id: legalBodyId,
        public_id: randomUUID(),
        tenant_id: tenantId,
        company_id: p.companyId,
        chain_id: p.chainId,
        factory: getAddress(p.factory),
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
    // Refused here, before anything is written, with a message that names the field: the table
    // refuses it too, but as a bare CHECK failure.
    if (!Number.isInteger(a.version))
      throw new Error(`the agreement version must be a whole number, got ${a.version}`);
    return this.move(
      legalBodyId,
      () => this.stmts.freeze.run(a.hash, a.version, legalBodyId),
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
      throw new Error(`agentId must be a uint256 in decimal, got ${JSON.stringify(l.agentId)}`);
    const identityOwner = getAddress(l.identityOwner);
    const bodyAddress = getAddress(l.bodyAddress);

    const row = this.stmts.findById.get(legalBodyId) as Row | undefined;
    if (!row || row.binding_state !== "draft") return "not_draft";
    if (row.oa_manifest_hash === null) return "not_frozen";

    try {
      return this.db.transaction((): ReserveOutcome => {
        const { changes } = this.stmts.reserve.run({
          legal_body_id: legalBodyId,
          agent_id: agentId,
          identity_owner: identityOwner,
          link_digest: l.linkDigest,
          link_deadline: l.linkDeadline,
          link_signature: l.linkSignature,
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
    return this.move(
      legalBodyId,
      () => this.stmts.recordDeploySubmission.run(s.txHash, legalBodyId),
      "deploy_submitted",
      s.txHash,
      { rawTx: s.rawTx, nonce: s.nonce },
    );
  }

  markDeployed(legalBodyId: string, d: { txHash: Hex; deployedAt: number }): boolean {
    return this.move(
      legalBodyId,
      () => this.stmts.markDeployed.run(d.txHash, d.deployedAt, legalBodyId),
      "deployed",
      d.txHash,
      null,
    );
  }

  lapse(legalBodyId: string, reason: string): boolean {
    return this.move(legalBodyId, () => this.stmts.lapse.run(legalBodyId), "lapsed", null, {
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
  ): void {
    this.stmts.scheduleBindingCheck.run(nextAt, intervalMs, legalBodyId);
  }

  listBindingDue(now: number, limit: number): LegalBodyRecord[] {
    return (this.stmts.listBindingDue.all(now, limit) as Row[]).map(toRecord);
  }

  recordEvent(
    legalBodyId: string,
    kind: LegalBodyEventKind,
    actor: LegalBodyActor,
    txHash: Hex | null,
    detail: Record<string, unknown> | null,
  ): void {
    // Redacted at the write, the rule the entity event log follows, so no producer has to
    // remember: detail may one day carry a provider's error text or a customer's words, and an
    // SSN that reached this append-only table could never be taken out again. The redactor
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
