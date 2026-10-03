import type Database from "better-sqlite3";
import type { Address, Hex } from "viem";

/**
 * A CUSTOMER'S DECLARATION: the statement of authority by which a guardian names an existing
 * Wyoming LLC as the company behind a legal body. One row per company, written once.
 *
 * The row is evidence. It holds exactly what the guardian signed (the sentence, its hash, the
 * typed-data digest and the signature), so the signature can be checked again from the row at any
 * time. The declarant's name and title, and the four values they could be read back from, are
 * erased together once the company is abandoned; the company, the filing it named and who
 * declared it (as a nullifier) stay.
 *
 * The table and the guards the database itself holds (one row per company, no delete, the erasure
 * as the only update) are `company_declarations` in db.ts.
 */

/** The filing number as rows compare it: `TEST-00-01`, `TEST-0001` and `test-0001` are one filing. */
export const filingKeyOf = (filingNumber: string): string =>
  filingNumber.toUpperCase().replaceAll("-", "");

export interface CompanyDeclaration {
  companyId: string;
  tenantId: Address;
  humanNullifier: string;
  declarantName: string | null; // null once erased
  declarantTitle: string | null;
  statementText: string | null;
  statementHash: Hex | null;
  statementDigest: Hex | null;
  signature: Hex | null;
  companyName: string;
  jurisdiction: "WY";
  filingNumber: string;
  filingKey: string;
  wordingVersion: string;
  chainId: number;
  factory: Address;
  issuedAt: number; // seconds
  synthetic: boolean;
  piiErasedAt: number | null; // seconds
  createdAt: string;
}

export type NewCompanyDeclaration = Omit<
  CompanyDeclaration,
  "piiErasedAt" | "createdAt" | "filingKey"
>;

export interface CompanyDeclarationRepository {
  /** Throws on a second row for the company, and on a second row for the same digest. */
  insert(d: NewCompanyDeclaration): void;
  find(companyId: string): CompanyDeclaration | undefined;
  /** The tenant's own declaration with this digest; another tenant's is never returned. */
  findByDigest(tenantId: string, digest: Hex): CompanyDeclaration | undefined;
  /** Every declaration of one filing, oldest first. The key is normalised, so a filing number
   *  in any spelling finds the same rows. */
  listByFilingKey(filingKey: string): CompanyDeclaration[];
  /**
   * The tenant's declarations created at or after `sinceUtc`, abandoned ones included.
   * `sinceUtc` is the text the `created_at` column holds (`YYYY-MM-DD HH:MM:SS`, UTC; see
   * `sqliteUtcTimestamp`); anything else throws, since it would not compare as a time.
   */
  countCreatedSince(tenantId: string, sinceUtc: string): number;
  /**
   * Erase the six personal fields and stamp `atSeconds`, a whole number of unix seconds (anything
   * else throws). False when already erased, unknown, or not abandoned, with nothing changed.
   */
  erasePii(companyId: string, atSeconds: number): boolean;
}

interface Row {
  company_id: string;
  tenant_id: string;
  human_nullifier: string;
  declarant_name: string | null;
  declarant_title: string | null;
  statement_text: string | null;
  statement_hash: string | null;
  statement_digest: string | null;
  signature: string | null;
  company_name: string;
  jurisdiction: string;
  filing_number: string;
  filing_key: string;
  wording_version: string;
  chain_id: number;
  factory: string;
  issued_at: number;
  synthetic: number;
  pii_erased_at: number | null;
  created_at: string;
}

function toDeclaration(r: Row): CompanyDeclaration {
  return {
    companyId: r.company_id,
    tenantId: r.tenant_id as Address,
    humanNullifier: r.human_nullifier,
    declarantName: r.declarant_name,
    declarantTitle: r.declarant_title,
    statementText: r.statement_text,
    statementHash: r.statement_hash as Hex | null,
    statementDigest: r.statement_digest as Hex | null,
    signature: r.signature as Hex | null,
    companyName: r.company_name,
    jurisdiction: r.jurisdiction as "WY",
    filingNumber: r.filing_number,
    filingKey: r.filing_key,
    wordingVersion: r.wording_version,
    chainId: r.chain_id,
    factory: r.factory as Address,
    issuedAt: r.issued_at,
    synthetic: r.synthetic === 1,
    piiErasedAt: r.pii_erased_at,
    createdAt: r.created_at,
  };
}

/** What `CURRENT_TIMESTAMP` writes. An ISO instant (`2026-01-02T00:00:00Z`) sorts after every
 *  stored time of its day, so a window given in that form would quietly count too few rows. */
const SQLITE_UTC_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;

/** The largest time in unix seconds accepted. A time in milliseconds is past it for centuries. */
const MAX_UNIX_SECONDS = 99_999_999_999;

export class SqliteCompanyDeclarationRepository implements CompanyDeclarationRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO company_declarations
           (company_id, tenant_id, human_nullifier, declarant_name, declarant_title,
            statement_text, statement_hash, statement_digest, signature, company_name,
            jurisdiction, filing_number, filing_key, wording_version, chain_id, factory,
            issued_at, synthetic)
         VALUES (@company_id, @tenant_id, @human_nullifier, @declarant_name, @declarant_title,
                 @statement_text, @statement_hash, @statement_digest, @signature, @company_name,
                 @jurisdiction, @filing_number, @filing_key, @wording_version, @chain_id, @factory,
                 @issued_at, @synthetic)`,
      ),
      find: db.prepare("SELECT * FROM company_declarations WHERE company_id = ?"),
      findByDigest: db.prepare(
        "SELECT * FROM company_declarations WHERE statement_digest = ? AND tenant_id = ?",
      ),
      // Rows are never deleted or replaced, so rowid order is the order they were written in.
      listByFilingKey: db.prepare(
        "SELECT * FROM company_declarations WHERE filing_key = ? ORDER BY created_at, rowid",
      ),
      countCreatedSince: db.prepare(
        "SELECT COUNT(*) AS n FROM company_declarations WHERE tenant_id = ? AND created_at >= ?",
      ),
      // The erasure, and nothing else the update guard would refuse: a row already erased, or
      // whose company is not abandoned (or has no row at all), is left out by the WHERE and the
      // caller is told so by the change count.
      erase: db.prepare(
        `UPDATE company_declarations
            SET declarant_name = NULL, declarant_title = NULL, statement_text = NULL,
                statement_hash = NULL, statement_digest = NULL, signature = NULL,
                pii_erased_at = @at
          WHERE company_id = @company_id
            AND pii_erased_at IS NULL
            AND (SELECT status FROM companies WHERE company_id = @company_id) = 'abandoned'`,
      ),
    };
  }

  insert(d: NewCompanyDeclaration): void {
    this.stmts.insert.run({
      company_id: d.companyId,
      // Stored as it arrives from the session, already checksummed.
      tenant_id: d.tenantId,
      human_nullifier: d.humanNullifier,
      declarant_name: d.declarantName,
      declarant_title: d.declarantTitle,
      statement_text: d.statementText,
      statement_hash: d.statementHash,
      statement_digest: d.statementDigest,
      signature: d.signature,
      company_name: d.companyName,
      jurisdiction: d.jurisdiction,
      filing_number: d.filingNumber,
      filing_key: filingKeyOf(d.filingNumber),
      wording_version: d.wordingVersion,
      chain_id: d.chainId,
      factory: d.factory,
      issued_at: d.issuedAt,
      synthetic: d.synthetic ? 1 : 0,
    });
  }

  find(companyId: string): CompanyDeclaration | undefined {
    const r = this.stmts.find.get(companyId) as Row | undefined;
    return r ? toDeclaration(r) : undefined;
  }

  findByDigest(tenantId: string, digest: Hex): CompanyDeclaration | undefined {
    const r = this.stmts.findByDigest.get(digest, tenantId) as Row | undefined;
    return r ? toDeclaration(r) : undefined;
  }

  listByFilingKey(filingKey: string): CompanyDeclaration[] {
    return (this.stmts.listByFilingKey.all(filingKeyOf(filingKey)) as Row[]).map(toDeclaration);
  }

  countCreatedSince(tenantId: string, sinceUtc: string): number {
    if (!SQLITE_UTC_TEXT.test(sinceUtc))
      throw new Error(
        "countCreatedSince takes the time as SQLite UTC text, YYYY-MM-DD HH:MM:SS (sqliteUtcTimestamp)",
      );
    return (this.stmts.countCreatedSince.get(tenantId, sinceUtc) as { n: number }).n;
  }

  erasePii(companyId: string, atSeconds: number): boolean {
    if (!Number.isSafeInteger(atSeconds) || atSeconds < 1 || atSeconds > MAX_UNIX_SECONDS)
      throw new Error(`erasePii takes a whole number of unix seconds (1 to ${MAX_UNIX_SECONDS})`);
    return this.stmts.erase.run({ company_id: companyId, at: atSeconds }).changes === 1;
  }
}
