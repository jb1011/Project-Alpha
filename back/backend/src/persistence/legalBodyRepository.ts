import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Address, Hex } from "viem";
import { redactPii } from "../formation/pii";
import { sqliteUtcTimestamp } from "../util/sqliteTime";
import {
  LegalBodyInputError,
  MAX_UNIX_SECONDS,
  ZERO_ADDRESS,
  canonicalAgentId,
  checksummed,
  isIntegerWithin,
  lowerHash,
  requireAddress,
  requireDeployment,
  requireHash,
  requirePublicLimit,
  requireSeconds,
} from "./legalBodyInput";

/**
 * LEGAL BODIES: the legal wrapper ordered for an agent identity its customer already owns, one row
 * per body order, in tables of their own (`LEGAL_BODIES_DDL` in db.ts lists the invariants the
 * database itself enforces, and their scope).
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
 * transaction, and the event only when the UPDATE changed the row: a method never logs a move it
 * did not make, and never makes one it does not log. Input that could match a row without moving
 * it (an agreement with no hash) is refused before the UPDATE runs.
 *
 * One move touches another row: `markLinked` first moves the body linked before it, for the same
 * chain, factory and agentId, to `broken`, in the same transaction, since one deployment links at
 * most one body per identity.
 *
 * One event records no move: `recordBrokenReason` appends a `broken` event to a row that is already
 * broken, to record what its body was found to be since the break (`latestBrokenReason` reads the
 * newest). It writes nothing to the row itself.
 *
 * Times: chain times (`linkDeadline`, `deployedAt`, `pointerSeenAt`, a block time) are unix
 * SECONDS; a schedule (`nextBindingCheckAt`, `firstCheckAt`) and a `now` or `since` handed to a
 * listing or a counter are unix MILLISECONDS; `createdAt` is SQLite UTC text.
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
 * The states of an order on its way: at most one row per (chain, factory, agentId) is in one of
 * them, which the partial unique index `idx_legal_bodies_inflight_agent` enforces with this same
 * list. A `linked` body is not on its way: the index `idx_legal_bodies_linked_agent` allows one
 * more, so a replacement can be ordered while a body is linked.
 */
export const IN_FLIGHT_BINDING_STATES = ["reserved", "deployed"] as const;

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
  | "note"
  | "gas_seed_requested"
  | "gas_seeded";

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
  /** Unix seconds: the sighting of the pointer that opened the latest linked stretch. */
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

export type ReserveOutcome =
  | "reserved"
  | "agent_in_flight"
  | "body_taken"
  | "not_draft"
  | "not_frozen";

/** Why a reservation was closed without a body. */
export type LapseReason =
  | "deadline_passed"
  | "foreign_body"
  | "owner_changed"
  | "refused_before_send";

const LAPSE_REASONS: readonly LapseReason[] = [
  "deadline_passed",
  "foreign_body",
  "owner_changed",
  "refused_before_send",
];

/** One create transaction as it was recorded before it was sent (a `deploy_submitted` event). */
export interface DeploySubmission {
  legalBodyId: string;
  txHash: Hex;
  rawTx: Hex;
  nonce: number;
  /** The id of the event that recorded it. */
  eventId: number;
}

/** One factory on one chain: the rows a sweeper or a cap of this deployment looks at. */
export type Deployment = { chainId: number; factory: Address };

type MarkLinkedOutcome = { outcome: "linked"; replaced: string[] } | { outcome: "not_linkable" };

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
  /**
   * The order on its way (`reserved` or `deployed`) for `agentId` under this deployment: at most
   * one row, by the in-flight index. Leading zeros are normalized away; a value that is not a
   * uint256 in decimal holds nothing. A deployment that no row may hold (a chain id that is not a
   * positive whole number, a factory that is not an address) throws a `LegalBodyInputError`, here
   * and in every method that takes one.
   */
  listInFlightByAgent(d: Deployment, agentId: string): LegalBodyRecord[];
  /** The body linked for `agentId` under this deployment, if any; agentIds as above. */
  findLinkedByAgent(d: Deployment, agentId: string): LegalBodyRecord | undefined;
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
   * Accept the identity owner's signed link: `draft` (agreement frozen) → `reserved`. The same
   * write puts the row on the schedule, at `firstCheckAt` with an interval of 30 seconds, and its
   * `link_accepted` event records `observedAtBlock`, as a number.
   *
   * Losing a race is an answer, never an exception: `agent_in_flight` when another order for the
   * agentId is on its way under this row's chain and factory (it takes precedence when the body
   * address collides too), `body_taken` when another row already recorded the body address, in
   * any casing. A body linked for the agentId does not stop a reservation: it is its replacement.
   *
   * Throws a `LegalBodyInputError`, before anything is written and whatever the body's state, for
   * input no row may hold: an agentId that is not a STRING holding a uint256 in decimal (a number
   * or a bigint is refused, because a JavaScript number cannot hold every uint256), an owner or a
   * body that is not an address, a body that is the zero address or the factory of this row, a
   * digest that is not a 32-byte hash, a signature that is not `0x` followed by whole bytes of hex
   * (`0x` alone is a signature: an owner contract can approve the digest and sign nothing), a
   * deadline that is not a whole number of unix SECONDS, a block that is not a whole number, zero
   * or more, or a first check that is not a time in unix MILLISECONDS (see
   * `scheduleBindingCheck`). The digest and the signature are stored lower-case.
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
      observedAtBlock: number;
      firstCheckAt: number;
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
  /**
   * `reserved` → `lapsed`: the reservation is closed without a deploy, and no longer holds its
   * agentId. The same write clears the row's check schedule, so no caller has to take it off
   * first. The event records the reason and the time of the block the decision was read at, in
   * unix SECONDS, as a number. A reason that is not a `LapseReason`, or a block time that is not
   * in seconds, throws a `LegalBodyInputError` before anything is written.
   */
  lapse(legalBodyId: string, p: { reason: LapseReason; blockTime: number }): boolean;
  /**
   * Close a `draft` for good: `draft` → `abandoned`, frozen agreement or not. A draft's company,
   * delay and agreement are write-once and rows are never deleted, so an order opened by mistake,
   * never signed or expired is closed rather than corrected. Nothing leaves `abandoned`. The
   * event names `actor`, the system unless another is given.
   */
  abandon(legalBodyId: string, reason: string, actor?: LegalBodyActor): boolean;
  /**
   * `deployed` | `broken` | `superseded` → `linked`, for the body the chain names now.
   *
   * Mark linked. Any OTHER row recorded as linked for the same chain, factory and agent is moved
   * to `broken` (detail { reason: "replaced", by }) first, in the same transaction. `replaced`
   * lists those rows. `not_linkable`, with nothing written, when this body is in none of the
   * three states (an unknown id included). The unit holds the write lock from its first read, so
   * no other writer can link a body for the agent in between. `seenAt` is a whole number of unix
   * SECONDS; anything else (a fraction, a time in milliseconds) throws a `LegalBodyInputError`
   * before anything is written.
   */
  markLinked(legalBodyId: string, seenAt: number): MarkLinkedOutcome;
  markBroken(legalBodyId: string, detail: Record<string, unknown>): boolean;
  /**
   * Record what a broken body was found to be since its break, with NO state move: one more
   * `broken` event (actor `system`) on a row that was linked once and is not linked now, `broken`
   * or `superseded` with a pointer seen, so `latestBrokenReason` reads it. The row itself is not
   * written: its state, its schedule and its `updatedAt` stay as they were, so a time counted from
   * the break still counts from the break. False, with nothing written, for any other row (an
   * unknown id included). A reason that is not a non-empty string throws a `LegalBodyInputError`
   * before anything is written. The detail follows `recordEvent`'s rules.
   */
  recordBrokenReason(
    legalBodyId: string,
    detail: { reason: string } & Record<string, unknown>,
  ): boolean;
  /**
   * `deployed` | `broken` → `superseded`: the body gives its agentId up, which frees it for a new
   * link. Not final. Which body an identity's owner names is decided on chain, where a body that
   * was set aside can be named again, so `markLinked` takes a superseded body back to `linked`.
   * The event names `actor`, the system unless another is given.
   */
  supersede(legalBodyId: string, bySupersedingId: string, actor?: LegalBodyActor): boolean;
  /**
   * Set the next check: `nextAt` in unix MILLISECONDS (100,000,000,000 or more: anything below
   * is a time in seconds, the unit of the chain) with `intervalMs` (one or more), or null with
   * null to take the row off the schedule. Anything else, a NaN out of a caller's arithmetic
   * included, throws a `LegalBodyInputError`.
   *
   * Answers whether a row was updated. Setting a time never updates a `draft`, an `abandoned` or
   * a `lapsed` row: there is nothing on chain to check for them. Taking a row off the schedule
   * works in every state. An unknown id is never updated. Not a state change, so no event.
   */
  scheduleBindingCheck(
    legalBodyId: string,
    nextAt: number | null,
    intervalMs: number | null,
  ): boolean;
  /**
   * Reserved rows of this deployment whose schedule is due at `nowMs` (unix MILLISECONDS, zero or
   * more), soonest first (ties by id), at most `limit` (one or more) of them. Any other `nowMs`
   * or `limit` throws a `LegalBodyInputError`: to SQLite a negative limit means no limit at all.
   */
  listReserved(d: Deployment, nowMs: number, limit: number): LegalBodyRecord[];
  /**
   * Due rows of this deployment in a checkable state only: deployed, linked, broken, superseded.
   * Ordered and bounded as `listReserved`. A `reserved` row is never listed here, whatever its
   * schedule columns hold: it is resolved (`listReserved`), not checked.
   */
  listBindingDue(d: Deployment, nowMs: number, limit: number): LegalBodyRecord[];
  /** Drafts created more than 24 hours before `nowMs`, oldest first, at most `limit`. */
  listExpiredDrafts(nowMs: number, limit: number): LegalBodyRecord[];
  /**
   * The create transactions recorded for this body, newest first. An event written around the
   * repository whose detail does not read as a submission is left out.
   */
  listDeploySubmissions(legalBodyId: string): DeploySubmission[];
  /** The newest create this deployment recorded at that nonce: any order, in any state. */
  deploySubmissionAtNonce(d: Deployment, nonce: number): DeploySubmission | undefined;
  /** The block `reserve` observed the link at, from the `link_accepted` event. */
  acceptedAtBlock(legalBodyId: string): number | undefined;
  /** The `reason` of the newest `broken` event, when it holds one as text. */
  latestBrokenReason(legalBodyId: string): string | undefined;
  /** Whether a `revoked` event was ever recorded for this body. */
  isRevoked(legalBodyId: string): boolean;
  /**
   * Whether the company has a body or an order for one: a draft under 24 hours old, or a
   * `reserved`, `deployed` or `linked` row. A linked body counts here, and not in
   * `countOpenByTenant`, on purpose: a company "has a body" while one is linked, and the cap on
   * open orders stops counting a body once it is linked.
   */
  hasOpenForCompany(companyId: string, nowMs: number): boolean;
  hasLinkedForCompany(companyId: string): boolean;
  /**
   * The tenant's open orders at `nowMs`: a draft under 24 hours old, a `reserved` row, and a
   * `deployed` row for 7 days after its `deployedAt`. A value that is not an address owns none.
   */
  countOpenByTenant(tenantId: string, nowMs: number): number;
  /** Rows the tenant created at or after `sinceMs`, in any state. */
  countOrdersCreatedByTenant(tenantId: string, sinceMs: number): number;
  /** Create transactions (`deploy_submitted` events) recorded for the tenant's rows since then. */
  countCreatesByTenant(tenantId: string, sinceMs: number): number;
  /** Create transactions recorded for this deployment's rows since then. */
  countCreatesSince(d: Deployment, sinceMs: number): number;
  /** Events of one kind across the tenant's rows, ever. */
  countEventsByTenant(tenantId: string, kind: LegalBodyEventKind): number;
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
  /**
   * Run fn inside a single SQLite transaction (atomic; rolls back if fn throws), which holds the
   * write lock from its first statement. A unit that reads and then moves is therefore never
   * overtaken by another process between the two: that process waits for its turn instead.
   * Called inside another `transaction`, it is a savepoint of the outer one.
   */
  transaction<T>(fn: () => T): T;
}

/**
 * The read-only finders behind a public answer about a legal body: the rows an agent's answer can
 * be about, the agents an address was recorded as owning, and the bodies recorded as linked. They
 * only SELECT, and what they return is the database's record, never a reading of the chain.
 *
 * Kept apart from `LegalBodyRepository` on purpose: test fakes implement that interface, and a
 * member added to it would break every one of them.
 *
 * The rules they share. A deployment that no row may hold throws a `LegalBodyInputError`, as in
 * every method that takes one, and so does a `limit` that is not a whole number from 1 to 100;
 * both are checked first, so a bad one throws even when nothing would be found. An agent id that
 * is not a uint256 in decimal finds nothing, and leading zeros are normalized away, as
 * `findLinkedByAgent` does ("042" is agent 42). An owner that is not an address finds nothing.
 */
export interface LegalBodyPublicFinders {
  /** Rows of this deployment for the agent in deployed, linked, broken or superseded. Order: the
   *  `deployed` row first (at most one per agent: the in-flight index), then pointer_seen_at
   *  descending (NULL last), then rowid descending. The currently linked row always has the
   *  highest pointer_seen_at (it is rewritten on every move to linked), so a limit of 4 keeps it. */
  listPublicByAgent(d: Deployment, agentId: string, limit: number): LegalBodyRecord[];
  /** Distinct agent ids of rows in those four states whose identity_owner equals `owner`, any
   *  case, newest first. */
  listAgentIdsByIdentityOwner(d: Deployment, owner: Address, limit: number): string[];
  /** Rows of this deployment in `linked`, newest pointer_seen_at first. */
  listLinked(d: Deployment, limit: number): LegalBodyRecord[];
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

// `LegalBodyInputError` is defined with the input rules it enforces (`legalBodyInput.ts`, shared
// with the statement log), and exported from here as well, where its callers have always found it.
export { LegalBodyInputError };

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;
/** A link signature: whole bytes of hex, or none at all (`0x`) for an owner that signs nothing. */
const SIGNATURE_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/** One or more whole bytes of hex, lower-cased. */
function requireBytes(field: string, value: unknown): Hex {
  if (typeof value !== "string" || !HEX_BYTES.test(value))
    throw new LegalBodyInputError(`${field} must be 0x and one or more whole bytes of hex`);
  return value.toLowerCase() as Hex;
}

/**
 * The smallest time a schedule takes, in unix MILLISECONDS: one past the largest time in seconds,
 * so the two units never overlap. A schedule below it is a time in seconds, and would make the row
 * due at once, on every tick.
 */
const MIN_SCHEDULE_MS = MAX_UNIX_SECONDS + 1;

/** The largest time a `Date` holds, in milliseconds: a `now` or `since` is turned into one. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** The interval of the first check a reservation schedules. */
const RESERVE_CHECK_INTERVAL_MS = 30_000;

/** A draft can be linked for this long after its creation; after it, it is expired. */
const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** A deployed body counts as an open order for this long after its block, and no longer. */
const DEPLOYED_OPEN_MS = 7 * 24 * 60 * 60 * 1000;

/** A time in unix MILLISECONDS read by a listing or a counter: zero or more, within a `Date`. */
function requireMillis(field: string, value: unknown): number {
  if (!isIntegerWithin(value, 0, MAX_DATE_MS))
    throw new LegalBodyInputError(
      `${field} must be a time in unix milliseconds, zero or more, got ${String(value)}`,
    );
  return value;
}

/** A row count for LIMIT: one or more. To SQLite a negative limit means no limit at all. */
function requireLimit(value: unknown): number {
  if (!isIntegerWithin(value, 1, Number.MAX_SAFE_INTEGER))
    throw new LegalBodyInputError(
      `limit must be a whole number, one or more, got ${String(value)}`,
    );
  return value;
}

/** The `created_at` text a draft created at `nowMs` minus its lifetime carries: at or after it,
 *  the draft is still open; before it, expired. One cutoff, so a draft is always one or the other. */
function draftCutoff(nowMs: number): string {
  return sqliteUtcTimestamp(nowMs - DRAFT_LIFETIME_MS);
}

/**
 * Whether `row` is a draft created more than 24 hours before `nowMs` (unix MILLISECONDS): the very
 * cutoff `listExpiredDrafts` and the open counts use, so a door and the housekeeping never disagree
 * about one draft. A row in any other state is not an expired draft. A `nowMs` that is not a time
 * in milliseconds throws a `LegalBodyInputError`.
 */
export function isDraftExpired(
  row: Pick<LegalBodyRecord, "bindingState" | "createdAt">,
  nowMs: number,
): boolean {
  return row.bindingState === "draft" && row.createdAt < draftCutoff(requireMillis("nowMs", nowMs));
}

/**
 * An agentId as a lookup takes it: canonical, or null when the value cannot be one (a lookup
 * finds nothing for it rather than throwing).
 */
function agentKey(value: unknown): string | null {
  return typeof value === "string" ? canonicalAgentId(value) : null;
}

/** The in-flight predicate, spelled exactly as the partial index's WHERE so SQLite can use it. */
const IN_FLIGHT_STATES_SQL = `binding_state IN (${IN_FLIGHT_BINDING_STATES.map((s) => `'${s}'`).join(",")})`;

/**
 * The states a schedule applies to: every state but `draft`, `abandoned` and `lapsed`, which have
 * nothing on chain to check. Setting a time filters on it: a reserved row is scheduled too, for
 * its resolution.
 */
const CHECKED_STATES_SQL = "binding_state NOT IN ('draft','abandoned','lapsed')";

/** The states a binding check reads the chain for: a body exists, so a pointer can name it. */
const BINDING_CHECK_STATES_SQL = "binding_state IN ('deployed','linked','broken','superseded')";

/**
 * The states a public answer can be about: the body's creation is recorded (the table's CHECKs
 * require `deployed_at` in these four and refuse it in every other). The same four a binding check
 * reads, named apart: the two lists answer different questions and need not change together.
 */
const PUBLIC_STATES_SQL = "binding_state IN ('deployed','linked','broken','superseded')";

/** The states `markLinked` moves a body out of. */
const LINKABLE_STATES: readonly BindingState[] = ["deployed", "broken", "superseded"];

/**
 * How SQLite names each unique index in its violation message, which is how a lost race is told
 * apart. A column index is named by its columns: both agentId indexes are on (chain_id, factory,
 * agent_id), so their messages are the same text, and the state a write sets tells which one
 * refused it (a reservation can only meet the in-flight one). An EXPRESSION index, like the
 * body-address one on `lower(body_address)`, is named only by its index name. The schema tests
 * pin both messages.
 */
const LIVE_AGENT_CONFLICT = "legal_bodies.chain_id, legal_bodies.factory, legal_bodies.agent_id";
const BODY_ADDRESS_CONFLICT = "index 'idx_legal_bodies_body'";

export class SqliteLegalBodyRepository implements LegalBodyRepository, LegalBodyPublicFinders {
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
      // Each states predicate repeats the WHERE of its partial index, which SQLite must see in
      // the query before it will use that index.
      listInFlightByAgent: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE chain_id = @chain_id AND factory = @factory
            AND agent_id = @agent_id AND ${IN_FLIGHT_STATES_SQL}
          ORDER BY rowid`,
      ),
      findLinkedByAgent: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE chain_id = @chain_id AND factory = @factory
            AND agent_id = @agent_id AND binding_state = 'linked'
          ORDER BY rowid`,
      ),
      // Compares the lower-case form, exactly as the unique index on (chain_id,
      // lower(body_address)) does: the lookup and the index then agree on every row, whatever
      // casing it was stored in. The IS NOT NULL term changes no answer; it repeats the WHERE of
      // that partial index, which SQLite must see in the query before it will use the index.
      findByBodyAddress: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE chain_id = @chain_id AND lower(body_address) = lower(@address)
            AND body_address IS NOT NULL`,
      ),
      listByTenant: db.prepare(
        "SELECT * FROM legal_bodies WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC",
      ),
      listByCompany: db.prepare(
        "SELECT * FROM legal_bodies WHERE company_id = ? ORDER BY created_at DESC, rowid DESC",
      ),
      // The public finders (`LegalBodyPublicFinders`). No index serves this first one: the two
      // agentId indexes are partial, one over the order on its way and one over the linked body,
      // and a broken or superseded row is in neither. So it scans the table, as the next one does.
      listPublicByAgent: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE chain_id = @chain_id AND factory = @factory
            AND agent_id = @agent_id AND ${PUBLIC_STATES_SQL}
          ORDER BY binding_state = 'deployed' DESC, pointer_seen_at IS NULL,
                   pointer_seen_at DESC, rowid DESC
          LIMIT @limit`,
      ),
      // There is no index on identity_owner: adding one changes the legal-body schema, which takes
      // a written migration. Each side is compared lower-case, since the column's CHECK takes an
      // address in any casing. An agent's place is that of its newest row among those the WHERE
      // keeps, by rowid: rows are never deleted, so rowid is the order they were created in.
      listAgentIdsByIdentityOwner: db
        .prepare(
          `SELECT agent_id FROM legal_bodies
            WHERE chain_id = @chain_id AND factory = @factory
              AND lower(identity_owner) = lower(@owner) AND ${PUBLIC_STATES_SQL}
            GROUP BY agent_id
            ORDER BY MAX(rowid) DESC
            LIMIT @limit`,
        )
        .pluck(),
      // The state term repeats the WHERE of the linked index, which SQLite must see in the query
      // before it will use that index.
      listLinked: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE chain_id = @chain_id AND factory = @factory AND binding_state = 'linked'
          ORDER BY pointer_seen_at DESC, rowid DESC
          LIMIT @limit`,
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
                next_binding_check_at = @first_check_at,
                binding_check_interval_ms = ${RESERVE_CHECK_INTERVAL_MS},
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
      // A lapsed row is never on the check schedule, so the lapse clears it in the same write.
      lapse: db.prepare(
        `UPDATE legal_bodies
            SET binding_state = 'lapsed', next_binding_check_at = NULL,
                binding_check_interval_ms = NULL, updated_at = CURRENT_TIMESTAMP
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
          WHERE legal_body_id = ? AND ${CHECKED_STATES_SQL}`,
      ),
      // Taking a row off the schedule is allowed in every state.
      clearBindingCheck: db.prepare(
        `UPDATE legal_bodies SET next_binding_check_at = NULL, binding_check_interval_ms = NULL
          WHERE legal_body_id = ?`,
      ),
      // The two due listings: the IS NOT NULL term repeats the WHERE of the schedule's partial
      // index, as above.
      listReserved: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE binding_state = 'reserved' AND next_binding_check_at <= @now
            AND next_binding_check_at IS NOT NULL
            AND chain_id = @chain_id AND factory = @factory
          ORDER BY next_binding_check_at, legal_body_id LIMIT @limit`,
      ),
      listBindingDue: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE ${BINDING_CHECK_STATES_SQL} AND next_binding_check_at <= @now
            AND next_binding_check_at IS NOT NULL
            AND chain_id = @chain_id AND factory = @factory
          ORDER BY next_binding_check_at, legal_body_id LIMIT @limit`,
      ),
      listExpiredDrafts: db.prepare(
        `SELECT * FROM legal_bodies
          WHERE binding_state = 'draft' AND created_at < @cutoff
          ORDER BY created_at, rowid LIMIT @limit`,
      ),
      hasOpenForCompany: db.prepare(
        `SELECT EXISTS (
           SELECT 1 FROM legal_bodies
            WHERE company_id = @company_id
              AND (binding_state IN ('reserved','deployed','linked')
                   OR (binding_state = 'draft' AND created_at >= @draft_cutoff))) AS found`,
      ),
      hasLinkedForCompany: db.prepare(
        `SELECT EXISTS (
           SELECT 1 FROM legal_bodies
            WHERE company_id = @company_id AND binding_state = 'linked') AS found`,
      ),
      // `deployed_at` is in seconds and the cutoff in milliseconds: the product stays well inside
      // SQLite's 64-bit integers, since the column is at most 99,999,999,999.
      countOpenByTenant: db.prepare(
        `SELECT COUNT(*) AS n FROM legal_bodies
          WHERE tenant_id = @tenant_id
            AND (binding_state = 'reserved'
                 OR (binding_state = 'draft' AND created_at >= @draft_cutoff)
                 OR (binding_state = 'deployed' AND deployed_at * 1000 > @deployed_cutoff))`,
      ),
      countOrdersCreatedByTenant: db.prepare(
        `SELECT COUNT(*) AS n FROM legal_bodies
          WHERE tenant_id = @tenant_id AND created_at >= @since`,
      ),
      countCreatesByTenant: db.prepare(
        `SELECT COUNT(*) AS n FROM legal_bodies b
           JOIN legal_body_events e ON e.legal_body_id = b.legal_body_id
          WHERE b.tenant_id = @tenant_id AND e.kind = 'deploy_submitted' AND e.created_at >= @since`,
      ),
      countCreatesSince: db.prepare(
        `SELECT COUNT(*) AS n FROM legal_bodies b
           JOIN legal_body_events e ON e.legal_body_id = b.legal_body_id
          WHERE b.chain_id = @chain_id AND b.factory = @factory
            AND e.kind = 'deploy_submitted' AND e.created_at >= @since`,
      ),
      countEventsByTenant: db.prepare(
        `SELECT COUNT(*) AS n FROM legal_bodies b
           JOIN legal_body_events e ON e.legal_body_id = b.legal_body_id
          WHERE b.tenant_id = @tenant_id AND e.kind = @kind`,
      ),
      insertEvent: db.prepare(
        `INSERT INTO legal_body_events (legal_body_id, kind, actor, tx_hash, detail)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      listEvents: db.prepare("SELECT * FROM legal_body_events WHERE legal_body_id = ? ORDER BY id"),
      eventsOfKind: db.prepare(
        `SELECT * FROM legal_body_events
          WHERE legal_body_id = @legal_body_id AND kind = @kind ORDER BY id DESC`,
      ),
      // A detail written around the repository may not be JSON, and json_extract THROWS on such a
      // blob: the CASE reads it only when it is valid, so one bad row cannot fail the lookup.
      deploySubmissionsAtNonce: db.prepare(
        `SELECT e.* FROM legal_bodies b
           JOIN legal_body_events e ON e.legal_body_id = b.legal_body_id
          WHERE b.chain_id = @chain_id AND b.factory = @factory AND e.kind = 'deploy_submitted'
            AND CASE WHEN json_valid(e.detail) THEN json_extract(e.detail, '$.nonce') END = @nonce
          ORDER BY e.id DESC`,
      ),
    };
  }

  create(p: {
    tenantId: Address;
    companyId: string;
    chainId: number;
    factory: Address;
    amendmentDelay: number;
  }): LegalBodyRecord {
    // Refused here, before anything is written, with a message that names the field. The table
    // has CHECKs of its own, but they fail without naming the mistake, and a number passed as
    // text would be converted by the column rather than refused.
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

  listInFlightByAgent(d: Deployment, agentId: string): LegalBodyRecord[] {
    const deployment = requireDeployment(d);
    const agent = agentKey(agentId);
    if (agent === null) return [];
    return (this.stmts.listInFlightByAgent.all({ ...deployment, agent_id: agent }) as Row[]).map(
      toRecord,
    );
  }

  findLinkedByAgent(d: Deployment, agentId: string): LegalBodyRecord | undefined {
    const deployment = requireDeployment(d);
    const agent = agentKey(agentId);
    if (agent === null) return undefined;
    const r = this.stmts.findLinkedByAgent.get({ ...deployment, agent_id: agent }) as
      | Row
      | undefined;
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

  listPublicByAgent(d: Deployment, agentId: string, limit: number): LegalBodyRecord[] {
    const deployment = requireDeployment(d);
    const n = requirePublicLimit(limit);
    const agent = agentKey(agentId);
    if (agent === null) return [];
    return (
      this.stmts.listPublicByAgent.all({ ...deployment, agent_id: agent, limit: n }) as Row[]
    ).map(toRecord);
  }

  listAgentIdsByIdentityOwner(d: Deployment, owner: Address, limit: number): string[] {
    const deployment = requireDeployment(d);
    const n = requirePublicLimit(limit);
    const address = typeof owner === "string" ? checksummed(owner) : null;
    if (address === null) return [];
    return this.stmts.listAgentIdsByIdentityOwner.all({
      ...deployment,
      owner: address,
      limit: n,
    }) as string[];
  }

  listLinked(d: Deployment, limit: number): LegalBodyRecord[] {
    const deployment = requireDeployment(d);
    const n = requirePublicLimit(limit);
    return (this.stmts.listLinked.all({ ...deployment, limit: n }) as Row[]).map(toRecord);
  }

  freezeAgreement(legalBodyId: string, a: { hash: Hex; version: number }): boolean {
    // No agreement, no freeze: a missing or malformed hash or version is answered like any other
    // freeze that did not happen, before the UPDATE runs, so nothing is written and nothing is
    // logged. The table refuses such a value too, but as a bare CHECK failure.
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
      observedAtBlock: number;
      firstCheckAt: number;
    },
  ): ReserveOutcome {
    // A string only. A number would be read as its decimal spelling, and past 2^53 that spelling
    // is no longer the id the caller meant; so the type is refused, not the range.
    if (typeof l.agentId !== "string")
      throw new LegalBodyInputError(
        `agentId must be a string holding a uint256 in decimal, got a ${typeof l.agentId}`,
      );
    const agentId = canonicalAgentId(l.agentId);
    if (agentId === null)
      throw new LegalBodyInputError(
        `agentId must be a uint256 in decimal, got ${JSON.stringify(l.agentId)}`,
      );
    const identityOwner = requireAddress("identityOwner", l.identityOwner);
    const bodyAddress = requireAddress("bodyAddress", l.bodyAddress);
    if (bodyAddress.toLowerCase() === ZERO_ADDRESS)
      throw new LegalBodyInputError("bodyAddress must not be the zero address");
    const linkDigest = requireHash("linkDigest", l.linkDigest);
    if (typeof l.linkSignature !== "string" || !SIGNATURE_BYTES.test(l.linkSignature))
      throw new LegalBodyInputError(
        "linkSignature must be 0x followed by whole bytes of hex (none at all for 0x)",
      );
    const linkSignature = l.linkSignature.toLowerCase() as Hex;
    const linkDeadline = requireSeconds("linkDeadline", l.linkDeadline);
    if (!isIntegerWithin(l.observedAtBlock, 0, Number.MAX_SAFE_INTEGER))
      throw new LegalBodyInputError(
        `observedAtBlock must be a whole block number, zero or more, got ${String(l.observedAtBlock)}`,
      );
    const observedAtBlock = l.observedAtBlock;
    if (!isIntegerWithin(l.firstCheckAt, MIN_SCHEDULE_MS, Number.MAX_SAFE_INTEGER))
      throw new LegalBodyInputError(
        `firstCheckAt must be a time in unix milliseconds (${MIN_SCHEDULE_MS} or more), got ${String(l.firstCheckAt)}`,
      );
    const firstCheckAt = l.firstCheckAt;

    const row = this.stmts.findById.get(legalBodyId) as Row | undefined;
    // The factory is a fact of the row, so this one refusal waits for the row to be read.
    if (row && row.factory.toLowerCase() === bodyAddress.toLowerCase())
      throw new LegalBodyInputError("bodyAddress must not be the factory that creates the body");
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
          first_check_at: firstCheckAt,
        });
        // Zero rows: another caller moved this body out of draft between the read and the write.
        if (changes !== 1) return "not_draft";
        // A number, never a string: nine digits written as text would be redacted as SSN-shaped.
        this.recordEvent(legalBodyId, "link_accepted", "system", null, { observedAtBlock });
        return "reserved";
      })();
    } catch (e) {
      // The two unique indexes a reservation can meet ARE the race guard: whoever loses a race
      // for an agentId or a body address lands here, and gets an answer rather than an exception.
      // A reservation sets `reserved`, so of the two agentId indexes only the in-flight one can
      // refuse it: a body linked for the agentId does not.
      if ((e as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") throw e;
      const message = e instanceof Error ? e.message : String(e);
      // An order on its way for the agentId wins the precedence, whichever index SQLite names.
      // The body address is derived from the signed link digest, so one tenant ordering twice for
      // one agent with the same agreement and deadline collides on BOTH indexes, and SQLite
      // reports only one of them (in practice the body index).
      if (
        message.includes(LIVE_AGENT_CONFLICT) ||
        this.stmts.listInFlightByAgent.get({
          chain_id: row.chain_id,
          factory: row.factory,
          agent_id: agentId,
        })
      )
        return "agent_in_flight";
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

  lapse(legalBodyId: string, p: { reason: LapseReason; blockTime: number }): boolean {
    const { reason, blockTime } = (p ?? {}) as { reason?: unknown; blockTime?: unknown };
    if (!LAPSE_REASONS.includes(reason as LapseReason))
      throw new LegalBodyInputError(
        `a lapse reason must be one of ${LAPSE_REASONS.join(", ")}, got ${JSON.stringify(reason)}`,
      );
    const at = requireSeconds("blockTime", blockTime);
    return this.move(legalBodyId, () => this.stmts.lapse.run(legalBodyId), "lapsed", null, {
      reason,
      blockTime: at,
    });
  }

  abandon(legalBodyId: string, reason: string, actor: LegalBodyActor = "system"): boolean {
    return this.move(
      legalBodyId,
      () => this.stmts.abandon.run(legalBodyId),
      "abandoned",
      null,
      { reason },
      actor,
    );
  }

  markLinked(legalBodyId: string, seenAt: number): MarkLinkedOutcome {
    const at = requireSeconds("seenAt", seenAt);
    try {
      // Immediate: the unit holds the write lock from its first read, so the body linked for the
      // agent cannot change between the read that finds it and the writes that replace it.
      return this.db
        .transaction((): MarkLinkedOutcome => {
          const row = this.stmts.findById.get(legalBodyId) as Row | undefined;
          if (!row || !LINKABLE_STATES.includes(row.binding_state))
            return { outcome: "not_linkable" };
          // One linked body per chain, factory and agentId (the linked index): the one the chain
          // named before gives way first, or the link below would be refused.
          const replaced: string[] = [];
          const holders = this.stmts.findLinkedByAgent.all({
            chain_id: row.chain_id,
            factory: row.factory,
            agent_id: row.agent_id,
          }) as Row[];
          for (const holder of holders) {
            if (this.stmts.markBroken.run(holder.legal_body_id).changes !== 1)
              throw new MoveNotMade();
            this.recordEvent(holder.legal_body_id, "broken", "system", null, {
              reason: "replaced",
              by: legalBodyId,
            });
            replaced.push(holder.legal_body_id);
          }
          // `seenAt` goes into the event too: the column is overwritten by every re-link, the log
          // keeps each sighting.
          if (this.stmts.markLinked.run(at, legalBodyId).changes !== 1) throw new MoveNotMade();
          this.recordEvent(legalBodyId, "linked", "system", null, { seenAt: at });
          return { outcome: "linked", replaced };
        })
        .immediate();
    } catch (e) {
      // A move the unit read as possible and then could not make: the replacements were rolled
      // back with it, so nothing is recorded. Anything else is a real failure, and propagates.
      if (e instanceof MoveNotMade) return { outcome: "not_linkable" };
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

  recordBrokenReason(
    legalBodyId: string,
    detail: { reason: string } & Record<string, unknown>,
  ): boolean {
    const reason: unknown = detail?.reason;
    if (typeof reason !== "string" || reason.length === 0)
      throw new LegalBodyInputError(
        `a broken reason is a non-empty string, got ${typeof reason === "string" ? "an empty string" : typeof reason}`,
      );
    // Immediate: the state is read and the event written under the write lock, so the row cannot
    // be linked in between.
    return this.db
      .transaction((): boolean => {
        const row = this.stmts.findById.get(legalBodyId) as Row | undefined;
        const linkedOnceNotNow =
          row !== undefined &&
          (row.binding_state === "broken" ||
            (row.binding_state === "superseded" && row.pointer_seen_at !== null));
        if (!linkedOnceNotNow) return false;
        this.recordEvent(legalBodyId, "broken", "system", null, detail);
        return true;
      })
      .immediate();
  }

  supersede(
    legalBodyId: string,
    bySupersedingId: string,
    actor: LegalBodyActor = "system",
  ): boolean {
    return this.move(
      legalBodyId,
      () => this.stmts.supersede.run(legalBodyId),
      "superseded",
      null,
      { by: bySupersedingId },
      actor,
    );
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
        isIntegerWithin(nextAt, MIN_SCHEDULE_MS, Number.MAX_SAFE_INTEGER) &&
        isIntegerWithin(intervalMs, 1, Number.MAX_SAFE_INTEGER)
      )
    )
      throw new LegalBodyInputError(
        `a check is a time in unix milliseconds (${MIN_SCHEDULE_MS} or more) with an interval in milliseconds (one or more), or null with null; got ${String(nextAt)}, ${String(intervalMs)}`,
      );
    const { changes } = cleared
      ? this.stmts.clearBindingCheck.run(legalBodyId)
      : this.stmts.scheduleBindingCheck.run(nextAt, intervalMs, legalBodyId);
    return changes === 1;
  }

  listReserved(d: Deployment, nowMs: number, limit: number): LegalBodyRecord[] {
    return this.listDue(this.stmts.listReserved, d, nowMs, limit);
  }

  listBindingDue(d: Deployment, nowMs: number, limit: number): LegalBodyRecord[] {
    return this.listDue(this.stmts.listBindingDue, d, nowMs, limit);
  }

  listExpiredDrafts(nowMs: number, limit: number): LegalBodyRecord[] {
    const cutoff = draftCutoff(requireMillis("nowMs", nowMs));
    return (this.stmts.listExpiredDrafts.all({ cutoff, limit: requireLimit(limit) }) as Row[]).map(
      toRecord,
    );
  }

  listDeploySubmissions(legalBodyId: string): DeploySubmission[] {
    const events = this.stmts.eventsOfKind.all({
      legal_body_id: legalBodyId,
      kind: "deploy_submitted",
    }) as EventRow[];
    return events.map(toSubmission).filter((s): s is DeploySubmission => s !== undefined);
  }

  deploySubmissionAtNonce(d: Deployment, nonce: number): DeploySubmission | undefined {
    const deployment = requireDeployment(d);
    if (!isIntegerWithin(nonce, 0, Number.MAX_SAFE_INTEGER))
      throw new LegalBodyInputError(
        `nonce must be a whole number, zero or more, got ${String(nonce)}`,
      );
    const events = this.stmts.deploySubmissionsAtNonce.all({ ...deployment, nonce }) as EventRow[];
    for (const e of events) {
      const submission = toSubmission(e);
      if (submission !== undefined) return submission;
    }
    return undefined;
  }

  acceptedAtBlock(legalBodyId: string): number | undefined {
    const block = this.latestDetail(legalBodyId, "link_accepted")?.observedAtBlock;
    return isIntegerWithin(block, 0, Number.MAX_SAFE_INTEGER) ? block : undefined;
  }

  latestBrokenReason(legalBodyId: string): string | undefined {
    const reason = this.latestDetail(legalBodyId, "broken")?.reason;
    return typeof reason === "string" ? reason : undefined;
  }

  isRevoked(legalBodyId: string): boolean {
    return (
      this.stmts.eventsOfKind.get({ legal_body_id: legalBodyId, kind: "revoked" }) !== undefined
    );
  }

  hasOpenForCompany(companyId: string, nowMs: number): boolean {
    const draft_cutoff = draftCutoff(requireMillis("nowMs", nowMs));
    const r = this.stmts.hasOpenForCompany.get({ company_id: companyId, draft_cutoff }) as {
      found: number;
    };
    return r.found === 1;
  }

  hasLinkedForCompany(companyId: string): boolean {
    const r = this.stmts.hasLinkedForCompany.get({ company_id: companyId }) as { found: number };
    return r.found === 1;
  }

  countOpenByTenant(tenantId: string, nowMs: number): number {
    const now = requireMillis("nowMs", nowMs);
    const tenant = checksummed(tenantId);
    if (tenant === null) return 0;
    return this.count(this.stmts.countOpenByTenant, {
      tenant_id: tenant,
      draft_cutoff: draftCutoff(now),
      deployed_cutoff: now - DEPLOYED_OPEN_MS,
    });
  }

  countOrdersCreatedByTenant(tenantId: string, sinceMs: number): number {
    const since = sqliteUtcTimestamp(requireMillis("sinceMs", sinceMs));
    const tenant = checksummed(tenantId);
    if (tenant === null) return 0;
    return this.count(this.stmts.countOrdersCreatedByTenant, { tenant_id: tenant, since });
  }

  countCreatesByTenant(tenantId: string, sinceMs: number): number {
    const since = sqliteUtcTimestamp(requireMillis("sinceMs", sinceMs));
    const tenant = checksummed(tenantId);
    if (tenant === null) return 0;
    return this.count(this.stmts.countCreatesByTenant, { tenant_id: tenant, since });
  }

  countCreatesSince(d: Deployment, sinceMs: number): number {
    const deployment = requireDeployment(d);
    const since = sqliteUtcTimestamp(requireMillis("sinceMs", sinceMs));
    return this.count(this.stmts.countCreatesSince, { ...deployment, since });
  }

  countEventsByTenant(tenantId: string, kind: LegalBodyEventKind): number {
    const tenant = checksummed(tenantId);
    if (tenant === null) return 0;
    return this.count(this.stmts.countEventsByTenant, { tenant_id: tenant, kind });
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
    // IMMEDIATE, not the default deferred: a deferred transaction takes the write lock at its
    // first write, and if another connection has committed since this one's first READ, that
    // write fails at once with a stale-snapshot error no busy timeout can wait out.
    return this.db.transaction(fn).immediate();
  }

  /**
   * One compare-and-set move and, only if THIS call made it, its event, in one transaction.
   * What a move records is the system observing or making it, unless the caller names another
   * actor: `abandon` and `supersede` take one, since a tenant or an operator can decide those.
   * Other operator and tenant actions are written with `recordEvent`.
   */
  private move(
    legalBodyId: string,
    update: () => Database.RunResult,
    kind: LegalBodyEventKind,
    txHash: Hex | null,
    detail: Record<string, unknown> | null,
    actor: LegalBodyActor = "system",
  ): boolean {
    return this.db.transaction(() => {
      if (update().changes !== 1) return false;
      this.recordEvent(legalBodyId, kind, actor, txHash, detail);
      return true;
    })();
  }

  /** A due listing of one deployment: its arguments checked, then the statement run. */
  private listDue(
    stmt: Database.Statement,
    d: Deployment,
    nowMs: number,
    limit: number,
  ): LegalBodyRecord[] {
    const deployment = requireDeployment(d);
    const now = requireMillis("nowMs", nowMs);
    return (stmt.all({ ...deployment, now, limit: requireLimit(limit) }) as Row[]).map(toRecord);
  }

  private count(stmt: Database.Statement, params: Record<string, unknown>): number {
    return (stmt.get(params) as { n: number }).n;
  }

  /** The detail of the newest event of `kind` for this body, when it is a JSON object. */
  private latestDetail(
    legalBodyId: string,
    kind: LegalBodyEventKind,
  ): Record<string, unknown> | undefined {
    const e = this.stmts.eventsOfKind.get({ legal_body_id: legalBodyId, kind }) as
      | EventRow
      | undefined;
    const detail = e ? parseDetail(e.detail) : undefined;
    return detail !== null && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : undefined;
  }
}

/** Thrown inside a unit to roll it back when a move it read as possible could not be made. */
class MoveNotMade extends Error {}

/**
 * A `deploy_submitted` event as the submission it records, or undefined when it does not read as
 * one: `recordDeploySubmission` writes a 32-byte hash, raw bytes and a nonce, so only an event
 * written around it can fail this.
 */
function toSubmission(e: EventRow): DeploySubmission | undefined {
  const txHash = lowerHash(e.tx_hash);
  const detail = parseDetail(e.detail);
  if (txHash === null || detail === null || typeof detail !== "object") return undefined;
  const { rawTx, nonce } = detail as { rawTx?: unknown; nonce?: unknown };
  if (typeof rawTx !== "string" || !HEX_BYTES.test(rawTx)) return undefined;
  if (!isIntegerWithin(nonce, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  return { legalBodyId: e.legal_body_id, txHash, rawTx: rawTx as Hex, nonce, eventId: e.id };
}
