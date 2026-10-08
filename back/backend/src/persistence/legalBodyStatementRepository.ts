import type Database from "better-sqlite3";
import { type Address, type Hex, getAddress, isAddress } from "viem";
import { type Deployment, LegalBodyInputError } from "./legalBodyRepository";

/**
 * THE STATEMENT LOG: one row for each DISTINCT set of claims Novi signed about a legal body, kept
 * for disputes. A statement someone presents is checked by recomputing its claims hash and finding
 * the row; the row's evidence ids say what the claims rested on. The signature itself proves what
 * was signed, so the log keeps no signature. The table, and the guards the database itself holds
 * (no update, no delete, no insert over an existing row, ids in order), are `statement_log` in
 * db.ts.
 *
 * Identical claims add no row, so the log grows with changes, not with traffic: a row keeps the
 * block and the time of the FIRST statement with its claims. A changed attestor adds a row, so the
 * log also records each rotation of the signing key.
 *
 * The evidence holds ids, enums and booleans only: never a name, a filing number or an address of
 * a person. The agent's wallet is kept beside it, for the lookup by wallet.
 *
 * Like the legal-body repository, it throws a `LegalBodyInputError`, before anything is written,
 * for a value no row may hold: that is a bug in the caller, never the outcome of a race.
 */

/** What a statement's claims rested on: ids, enums and booleans, stored as JSON numbers, strings
 *  and booleans. */
export interface StatementEvidence {
  /** The company's latest check, when it is a pass (the evidence behind `controlVerified` and the
   *  filing facts); null otherwise. */
  checkId: number | null;
  /** The body's first `revoked` event; null when it has none. */
  revocationEventId: number | null;
  companyStatus: "draft" | "ready" | "abandoned";
  humanVerified: boolean;
}

export interface NewStatementRecord {
  legalBodyId: string;
  chainId: number;
  factory: Address;
  /** The ERC-8004 agentId, a uint256 in decimal; stored without leading zeros. */
  agentId: string;
  /** The zero address when the agent has no wallet. */
  agentWallet: Address;
  /** The address of the key that signed the statement. */
  attestor: Address;
  standing: "pending" | "active" | "unknown" | "inactive";
  /** 32 bytes; stored lower-case. */
  claimsHash: Hex;
  /** The block the first statement with these claims was read at. */
  observedAtBlock: number;
  /** Unix seconds: when the first statement with these claims was issued. */
  issuedAt: number;
  evidence: StatementEvidence;
}

export interface StatementRecord extends NewStatementRecord {
  id: number;
  /** UTC, `YYYY-MM-DD HH:MM:SS`, as SQLite's CURRENT_TIMESTAMP writes it. */
  createdAt: string;
}

export interface LegalBodyStatementRepository {
  /**
   * One immediate transaction: insert only when the body's latest row differs in claims hash or
   * attestor. Answers whether a row was inserted. Addresses are stored checksummed and the hash
   * lower-case, so both compare in any letter case; the evidence is stored as exactly its four
   * fields. A statement no row may hold throws a `LegalBodyInputError` before anything is written;
   * a body that does not exist is refused by the database's foreign key.
   */
  appendIfChanged(s: NewStatementRecord): boolean;
  /** The body's newest row. */
  latest(legalBodyId: string): StatementRecord | undefined;
  /**
   * Distinct agent ids whose rows of this deployment record this wallet, newest first: by each
   * agent's newest matching row. At most `limit`, a whole number from 1 to 100. The wallet matches
   * in any letter case; the zero address, and a value that is not an address, match nothing. A
   * `limit` out of range, or a deployment no row may hold, throws a `LegalBodyInputError`.
   */
  agentIdsByWallet(d: Deployment, wallet: Address, limit: number): string[];
}

interface Row {
  id: number;
  legal_body_id: string;
  chain_id: number;
  factory: string;
  agent_id: string;
  agent_wallet: string;
  attestor: string;
  standing: NewStatementRecord["standing"];
  claims_hash: string;
  observed_at_block: number;
  issued_at: number;
  evidence: string;
  created_at: string;
}

type NewRow = Omit<Row, "id" | "created_at">;

function toRecord(r: Row): StatementRecord {
  return {
    id: r.id,
    legalBodyId: r.legal_body_id,
    chainId: r.chain_id,
    factory: r.factory as Address,
    agentId: r.agent_id,
    agentWallet: r.agent_wallet as Address,
    attestor: r.attestor as Address,
    standing: r.standing,
    claimsHash: r.claims_hash as Hex,
    observedAtBlock: r.observed_at_block,
    issuedAt: r.issued_at,
    // Valid JSON, by the table's CHECK.
    evidence: JSON.parse(r.evidence) as StatementEvidence,
    createdAt: r.created_at,
  };
}

const STANDINGS: readonly NewStatementRecord["standing"][] = [
  "pending",
  "active",
  "unknown",
  "inactive",
];
const COMPANY_STATUSES: readonly StatementEvidence["companyStatus"][] = [
  "draft",
  "ready",
  "abandoned",
];

/** The most agent ids one lookup by wallet returns. */
const MAX_AGENT_IDS = 100;

/** The largest time the seconds column holds. A time in milliseconds is past it for centuries. */
const MAX_UNIX_SECONDS = 99_999_999_999;

const UINT256_MAX = 2n ** 256n - 1n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const HASH_32 = /^0x[0-9a-fA-F]{64}$/;

/** A JS number that is an exact integer in [min, max]: not a string, a bigint, NaN or a fraction. */
function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** The address checksummed, the one form rows store it in, or a `LegalBodyInputError`. */
function requireAddress(field: string, value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    throw new LegalBodyInputError(`${field} must be a 0x address`);
  return getAddress(value);
}

/** A 32-byte hash, lower-cased: one spelling per hash, so stored hashes compare as text. */
function requireHash(field: string, value: unknown): Hex {
  if (typeof value !== "string" || !HASH_32.test(value))
    throw new LegalBodyInputError(`${field} must be 0x and 64 hex digits (a 32-byte hash)`);
  return value.toLowerCase() as Hex;
}

/**
 * An agentId in the one spelling rows store it: a uint256 in decimal without leading zeros. A
 * string only: a JavaScript number cannot hold every uint256.
 */
function requireAgentId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || BigInt(value) > UINT256_MAX)
    throw new LegalBodyInputError("agentId must be a string holding a uint256 in decimal");
  return BigInt(value).toString();
}

/** An id of another table's row (a check, an event), positive, or null when there is none. */
function requireIdOrNull(field: string, value: unknown): number | null {
  if (value === null) return null;
  if (!isIntegerWithin(value, 1, Number.MAX_SAFE_INTEGER))
    throw new LegalBodyInputError(`${field} must be a positive whole number, or null`);
  return value;
}

/**
 * The evidence exactly as it is stored: its four fields, in one order, and nothing a caller's
 * object carried besides them.
 */
function requireEvidence(value: unknown): StatementEvidence {
  const e = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const checkId = requireIdOrNull("evidence.checkId", e.checkId);
  const revocationEventId = requireIdOrNull("evidence.revocationEventId", e.revocationEventId);
  const companyStatus = e.companyStatus as StatementEvidence["companyStatus"];
  if (!COMPANY_STATUSES.includes(companyStatus))
    throw new LegalBodyInputError(
      `evidence.companyStatus must be one of ${COMPANY_STATUSES.join(", ")}`,
    );
  if (typeof e.humanVerified !== "boolean")
    throw new LegalBodyInputError("evidence.humanVerified must be a boolean");
  return { checkId, revocationEventId, companyStatus, humanVerified: e.humanVerified };
}

/** The deployment as rows store it: the factory checksummed, so a lookup matches any casing. */
function requireDeployment(d: unknown): { chain_id: number; factory: Address } {
  const { chainId, factory } = (d ?? {}) as { chainId?: unknown; factory?: unknown };
  if (!isIntegerWithin(chainId, 1, Number.MAX_SAFE_INTEGER))
    throw new LegalBodyInputError(
      `a deployment's chainId must be a positive whole number, got ${String(chainId)}`,
    );
  return { chain_id: chainId, factory: requireAddress("a deployment's factory", factory) };
}

/** The statement as a row, every field checked and in the form rows store it. */
function toNewRow(s: NewStatementRecord): NewRow {
  if (!isIntegerWithin(s.chainId, 1, Number.MAX_SAFE_INTEGER))
    throw new LegalBodyInputError(
      `chainId must be a positive whole number, got ${String(s.chainId)}`,
    );
  if (!STANDINGS.includes(s.standing))
    throw new LegalBodyInputError(`standing must be one of ${STANDINGS.join(", ")}`);
  if (!isIntegerWithin(s.observedAtBlock, 1, Number.MAX_SAFE_INTEGER))
    throw new LegalBodyInputError(
      `observedAtBlock must be a positive whole block number, got ${String(s.observedAtBlock)}`,
    );
  if (!isIntegerWithin(s.issuedAt, 1, MAX_UNIX_SECONDS))
    throw new LegalBodyInputError(
      `issuedAt must be a whole number of unix seconds (1 to ${MAX_UNIX_SECONDS}), got ${String(s.issuedAt)}`,
    );
  return {
    legal_body_id: s.legalBodyId,
    chain_id: s.chainId,
    factory: requireAddress("factory", s.factory),
    agent_id: requireAgentId(s.agentId),
    agent_wallet: requireAddress("agentWallet", s.agentWallet),
    attestor: requireAddress("attestor", s.attestor),
    standing: s.standing,
    claims_hash: requireHash("claimsHash", s.claimsHash),
    observed_at_block: s.observedAtBlock,
    issued_at: s.issuedAt,
    evidence: JSON.stringify(requireEvidence(s.evidence)),
  };
}

export class SqliteLegalBodyStatementRepository implements LegalBodyStatementRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      latest: db.prepare(
        "SELECT * FROM statement_log WHERE legal_body_id = ? ORDER BY id DESC LIMIT 1",
      ),
      insert: db.prepare(
        `INSERT INTO statement_log
           (legal_body_id, chain_id, factory, agent_id, agent_wallet, attestor, standing,
            claims_hash, observed_at_block, issued_at, evidence)
         VALUES (@legal_body_id, @chain_id, @factory, @agent_id, @agent_wallet, @attestor,
                 @standing, @claims_hash, @observed_at_block, @issued_at, @evidence)`,
      ),
      // The zero-address term repeats the WHERE of the partial index on the wallet, which SQLite
      // must see in the query before it will use that index; it also keeps the zero address, which
      // a row records for an agent with no wallet, from ever matching.
      agentIdsByWallet: db.prepare(
        `SELECT agent_id FROM statement_log
          WHERE chain_id = @chain_id AND factory = @factory
            AND lower(agent_wallet) = @wallet
            AND agent_wallet <> '0x0000000000000000000000000000000000000000'
          GROUP BY agent_id
          ORDER BY MAX(id) DESC
          LIMIT @limit`,
      ),
    };
  }

  appendIfChanged(s: NewStatementRecord): boolean {
    const row = toNewRow(s);
    // IMMEDIATE: the write lock is held from the read of the latest row, so no other writer can
    // add a row between the comparison and the insert.
    return this.db
      .transaction((): boolean => {
        const latest = this.stmts.latest.get(row.legal_body_id) as Row | undefined;
        if (
          latest !== undefined &&
          latest.claims_hash === row.claims_hash &&
          latest.attestor.toLowerCase() === row.attestor.toLowerCase()
        )
          return false;
        this.stmts.insert.run(row);
        return true;
      })
      .immediate();
  }

  latest(legalBodyId: string): StatementRecord | undefined {
    const r = this.stmts.latest.get(legalBodyId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  agentIdsByWallet(d: Deployment, wallet: Address, limit: number): string[] {
    const deployment = requireDeployment(d);
    if (!isIntegerWithin(limit, 1, MAX_AGENT_IDS))
      throw new LegalBodyInputError(
        `limit must be a whole number from 1 to ${MAX_AGENT_IDS}, got ${String(limit)}`,
      );
    if (typeof wallet !== "string" || !isAddress(wallet, { strict: false })) return [];
    const lower = wallet.toLowerCase();
    if (lower === ZERO_ADDRESS) return [];
    return (
      this.stmts.agentIdsByWallet.all({ ...deployment, wallet: lower, limit }) as {
        agent_id: string;
      }[]
    ).map((r) => r.agent_id);
  }
}
