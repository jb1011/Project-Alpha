import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DoolaEnvironment } from "../adapters/doola/types";
import type { CompanyNameOption } from "../formation/intake";

/**
 * COMPANIES (design 2026-08-26 §2) — the row a filing belongs to, and the thing entities attach
 * to many-to-one.
 *
 * The table exists because the entity was the wrong key for all of it. A company can be filed and
 * have its documents fetched before any agent attaches; ten agents can share one filing; and the
 * intake (names, purpose, industry, the responsible party) describes a COMPANY, not an agent.
 *
 * Two things are deliberately NOT columns here:
 *  - "paying", which is `EXISTS (formation_payments … quoted|settling)` — derived, so a refund or
 *    an expired quote needs no second write and cannot drift;
 *  - filing progress, which is derived from `formation_requests` by `deriveFormationStatus`.
 *
 * `status` is only what the company itself owns: `draft` (intake taken, not yet payable/fileable),
 * `ready` (fileable), `abandoned` (terminal, and it has exactly three writers — draft expiry, the
 * max-attempt path, and the operator CLI).
 */
export type CompanyStatus = "draft" | "ready" | "abandoned";

export interface CompanyRecord {
  companyId: string;
  tenantId: string;
  status: CompanyStatus;
  /** "doola". Copied onto every attached entity's pin, never re-read from config. */
  provider: string;
  environment: DoolaEnvironment;
  /** True = filed with a labeled sandbox identity, not a real natural person. */
  synthetic: boolean;
  nameOptions: CompanyNameOption[];
  businessPurpose: string;
  industryLabel: string;
  /** True = the intake was DERIVED (the migration, or the A1 shim), not typed by a human. */
  intakeSynthesized: boolean;
  /** OUR candidate string that doola's reported name matched (§5) — never doola free text, and
   *  null until a match is made, which is what keeps `manifest.legal.companyName` honest. */
  legalNameFiled: string | null;
  /** Unix SECONDS the STATE filed the company. */
  filedAt: number | null;
  filingNumber: string | null;
  /** The real EIN once the IRS issues one. */
  ein: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewCompany = Omit<
  CompanyRecord,
  "companyId" | "legalNameFiled" | "filedAt" | "filingNumber" | "ein" | "createdAt" | "updatedAt"
> & { companyId?: string };

interface Row {
  company_id: string;
  tenant_id: string;
  status: CompanyStatus;
  provider: string;
  environment: string;
  synthetic: number;
  name_options: string;
  business_purpose: string;
  industry_label: string;
  intake_synthesized: number;
  legal_name_filed: string | null;
  filed_at: number | null;
  filing_number: string | null;
  ein: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(r: Row): CompanyRecord {
  return {
    companyId: r.company_id,
    tenantId: r.tenant_id,
    status: r.status,
    provider: r.provider,
    environment: r.environment as DoolaEnvironment,
    synthetic: r.synthetic === 1,
    nameOptions: parseNameOptions(r.name_options),
    businessPurpose: r.business_purpose,
    industryLabel: r.industry_label,
    intakeSynthesized: r.intake_synthesized === 1,
    legalNameFiled: r.legal_name_filed,
    filedAt: r.filed_at,
    filingNumber: r.filing_number,
    ein: r.ein,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** ONE shape, and an unreadable blob is an empty list rather than a throw: the name candidates
 *  are re-derivable from the filing, and a corrupt blob must never make a company unreadable. */
function parseNameOptions(raw: string): CompanyNameOption[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CompanyNameOption[]) : [];
  } catch {
    return [];
  }
}

export interface CompanyRepository {
  /** Mint a company. Called INSIDE the caller's transaction, beside the party bind CAS. */
  create(input: NewCompany): string;
  find(companyId: string): CompanyRecord | undefined;
  /** A company the tenant owns. Undefined for unknown AND for not-yours, deliberately: telling
   *  them apart would make the route an existence oracle over other tenants' company ids. */
  findOwned(tenantId: string, companyId: string): CompanyRecord | undefined;
  /**
   * A tenant's companies, NEWEST FIRST.
   *
   * The ordering is an API-level contract, not a convenience: the wizard's reuse picker defaults
   * to the last-used company and `list_companies` must agree with it, so the order lives here
   * rather than in two renderers.
   */
  listByTenant(tenantId: string): CompanyRecord[];
  findMany(companyIds: string[]): Map<string, CompanyRecord>;
  /**
   * Companies this tenant has SPENT or COMMITTED on — `ready`, or carrying a live payment.
   *
   * Drafts are excluded: with payment on, a company can sit in draft for days before its create
   * fires, and counting those would let an abandoned form exhaust a real quota. The platform
   * DAILY ceiling stays on `create_provider` rows, where the fee is actually incurred.
   */
  countChargeableByTenant(tenantId: string): number;
  /** Live payment rows (`quoted`/`settling`) for one company. Zero until B1 writes any. */
  livePaymentCount(companyId: string): number;
  /** Entities attached to one company — the FORMATION_MAX_AGENTS_PER_COMPANY reader. */
  countAgents(companyId: string): number;
  /** CAS the status. Returns whether THIS caller made the move. */
  setStatus(companyId: string, from: CompanyStatus, to: CompanyStatus): boolean;
  /**
   * Write the filing facts, NEVER downgrading: a value we hold is not overwritten with a null
   * doola happens not to have returned this time (the `healFilingFacts` rule, applied to the
   * column that now owns these facts). Returns whether anything changed.
   */
  recordFilingFacts(
    companyId: string,
    facts: {
      filedAt?: number | null;
      filingNumber?: string | null;
      legalNameFiled?: string | null;
    },
  ): boolean;
  /** The EIN, once the IRS has issued it. Returns whether anything changed. */
  recordEin(companyId: string, ein: string): boolean;
}

export class SqliteCompanyRepository implements CompanyRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO companies
           (company_id, tenant_id, status, provider, environment, synthetic,
            name_options, business_purpose, industry_label, intake_synthesized)
         VALUES (@company_id, @tenant_id, @status, @provider, @environment, @synthetic,
                 @name_options, @business_purpose, @industry_label, @intake_synthesized)`,
      ),
      find: db.prepare("SELECT * FROM companies WHERE company_id = ?"),
      findOwned: db.prepare("SELECT * FROM companies WHERE company_id = ? AND tenant_id = ?"),
      listByTenant: db.prepare(
        "SELECT * FROM companies WHERE tenant_id = ? ORDER BY created_at DESC, company_id",
      ),
      // The quota reader. The EXISTS is the derived-paying predicate, written out once here and
      // once in `livePaymentCount`, both against the same partial index.
      countChargeable: db.prepare(
        `SELECT COUNT(*) AS n FROM companies c
          WHERE c.tenant_id = ?
            AND (c.status = 'ready'
                 OR EXISTS (SELECT 1 FROM formation_payments p
                             WHERE p.company_id = c.company_id
                               AND p.status IN ('quoted','settling')))`,
      ),
      livePayments: db.prepare(
        `SELECT COUNT(*) AS n FROM formation_payments
          WHERE company_id = ? AND status IN ('quoted','settling')`,
      ),
      countAgents: db.prepare("SELECT COUNT(*) AS n FROM entities WHERE company_id = ?"),
      setStatus: db.prepare(
        `UPDATE companies SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE company_id = ? AND status = ?`,
      ),
      // COALESCE in the value position and a NOT-NULL guard in the WHERE: a fact we already hold
      // is never replaced by a null, and a write that would change nothing reports `false`.
      facts: db.prepare(
        `UPDATE companies
            SET filed_at         = COALESCE(@filed_at, filed_at),
                filing_number    = COALESCE(@filing_number, filing_number),
                legal_name_filed = COALESCE(@legal_name_filed, legal_name_filed),
                updated_at       = CURRENT_TIMESTAMP
          WHERE company_id = @company_id
            AND (   (@filed_at IS NOT NULL AND (filed_at IS NULL OR filed_at <> @filed_at))
                 OR (@filing_number IS NOT NULL
                     AND (filing_number IS NULL OR filing_number <> @filing_number))
                 OR (@legal_name_filed IS NOT NULL
                     AND (legal_name_filed IS NULL OR legal_name_filed <> @legal_name_filed)))`,
      ),
      ein: db.prepare(
        `UPDATE companies SET ein = ?, updated_at = CURRENT_TIMESTAMP
          WHERE company_id = ? AND (ein IS NULL OR ein <> ?)`,
      ),
    };
  }

  create(input: NewCompany): string {
    const companyId = input.companyId ?? randomUUID();
    this.stmts.insert.run({
      company_id: companyId,
      tenant_id: input.tenantId,
      status: input.status,
      provider: input.provider,
      environment: input.environment,
      synthetic: input.synthetic ? 1 : 0,
      name_options: JSON.stringify(input.nameOptions),
      business_purpose: input.businessPurpose,
      industry_label: input.industryLabel,
      intake_synthesized: input.intakeSynthesized ? 1 : 0,
    });
    return companyId;
  }

  find(companyId: string): CompanyRecord | undefined {
    const r = this.stmts.find.get(companyId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findOwned(tenantId: string, companyId: string): CompanyRecord | undefined {
    const r = this.stmts.findOwned.get(companyId, tenantId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  listByTenant(tenantId: string): CompanyRecord[] {
    return (this.stmts.listByTenant.all(tenantId) as Row[]).map(toRecord);
  }

  findMany(companyIds: string[]): Map<string, CompanyRecord> {
    const out = new Map<string, CompanyRecord>();
    if (companyIds.length === 0) return out;
    // Chunked at 400, clear of SQLITE_MAX_VARIABLE_NUMBER — the same idiom `stepsOfMany` uses,
    // and for the same reason: the list routes render a whole page in one read.
    for (let i = 0; i < companyIds.length; i += 400) {
      const chunk = companyIds.slice(i, i + 400);
      const rows = this.db
        .prepare(`SELECT * FROM companies WHERE company_id IN (${chunk.map(() => "?").join(",")})`)
        .all(...chunk) as Row[];
      for (const r of rows) out.set(r.company_id, toRecord(r));
    }
    return out;
  }

  countChargeableByTenant(tenantId: string): number {
    return (this.stmts.countChargeable.get(tenantId) as { n: number }).n;
  }

  livePaymentCount(companyId: string): number {
    return (this.stmts.livePayments.get(companyId) as { n: number }).n;
  }

  countAgents(companyId: string): number {
    return (this.stmts.countAgents.get(companyId) as { n: number }).n;
  }

  setStatus(companyId: string, from: CompanyStatus, to: CompanyStatus): boolean {
    return this.stmts.setStatus.run(to, companyId, from).changes === 1;
  }

  recordFilingFacts(
    companyId: string,
    facts: {
      filedAt?: number | null;
      filingNumber?: string | null;
      legalNameFiled?: string | null;
    },
  ): boolean {
    return (
      this.stmts.facts.run({
        company_id: companyId,
        filed_at: facts.filedAt ?? null,
        filing_number: facts.filingNumber?.trim() || null,
        legal_name_filed: facts.legalNameFiled?.trim() || null,
      }).changes === 1
    );
  }

  recordEin(companyId: string, ein: string): boolean {
    return this.stmts.ein.run(ein, companyId, ein).changes === 1;
  }
}
