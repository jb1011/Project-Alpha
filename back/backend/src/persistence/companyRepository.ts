import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DoolaEnvironment } from "../adapters/doola/types";
import { INTAKE_FROZEN_SQL } from "../formation/freeze";
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
 * max-attempt path, and the operator CLI — plus, for a customer's own declared company, its tenant
 * (`abandonCustomerCompany`) and the stale sweep (`expireStaleCustomerCompanies`)).
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
   *
   * Formation companies only: a customer's own company (provider `customer`) has its own cap,
   * `countCustomerOpenByTenant`, and does not use up the formation quota.
   */
  countChargeableByTenant(tenantId: string): number;
  /**
   * A tenant's customer companies that are still open: provider `customer`, status `draft` or
   * `ready`. The cap on a tenant's open declarations reads it, so an abandoned one has left it.
   */
  countCustomerOpenByTenant(tenantId: string): number;
  /**
   * Customer companies that are stale, oldest first, at most `limit`: every condition of the rule
   * but the open legal body, which the caller asks about itself. A company is stale when
   *  - its provider is `customer` and its status `draft` or `ready`;
   *  - it was created at or before `cutoffUtc`;
   *  - it has no payment `quoted`, `settling`, `settled` or `refunded`;
   *  - it has no check, or its latest check `failed` and was recorded before `cutoffUtc`;
   *  - and no customer upload was made since its latest check (with no check, none at all).
   * So a company with an upload no check has followed is waiting for the operator and is never
   * stale, and neither is one whose latest check passed, revoked or reinstated it. Times are
   * compared at one-second resolution, and a check recorded in the same second as an upload is not
   * after it. `cutoffUtc` is the text the `created_at` columns hold (see `sqliteUtcTimestamp`).
   */
  listStaleCustomerCandidates(cutoffUtc: string, limit: number): CompanyRecord[];
  /** The listing's rule, for one company: whether it is stale at `cutoffUtc`. */
  isStaleCustomerCandidate(companyId: string, cutoffUtc: string): boolean;
  /** Live payment rows (`quoted`/`settling`) for one company. Zero until B1 writes any. */
  livePaymentCount(companyId: string): number;
  /**
   * Whether this company has a payment that is live or that moved money: a row `quoted`,
   * `settling`, `settled` or `refunded`. Wider than `livePaymentCount` on purpose: a company that
   * was paid for, or refunded, is not one its tenant may simply walk away from.
   */
  hasLiveOrSettledPayment(companyId: string): boolean;
  /** Entities attached to one company — the FORMATION_MAX_AGENTS_PER_COMPANY reader. */
  countAgents(companyId: string): number;
  /**
   * The two counts above for a WHOLE PAGE, one `GROUP BY` each (M5's rule, applied to the company
   * list).
   *
   * `GET /companies` and MCP `list_companies` rendered every row with its own `stepsOf`, its own
   * `livePaymentCount` and its own `countAgents`: 3N+1 queries for a page, on two authenticated
   * surfaces, for three answers a single grouped scan gives. Companies absent from the map have
   * a count of zero — a map, not a default, so the caller cannot mistake "no rows" for "not
   * asked".
   */
  countAgentsMany(companyIds: string[]): Map<string, number>;
  livePaymentCountMany(companyIds: string[]): Map<string, number>;
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

  /**
   * INTAKE IMMUTABILITY (design 2026-08-26 §4.7), enforced HERE rather than at the route.
   *
   * Name options, purpose and industry are FROZEN once the first create has been sent, and the
   * freeze is a property of the ROW, not of a door: three surfaces can reach a company and only
   * one predicate may decide whether it is still editable. So the whole rule is the WHERE clause
   * of one UPDATE, and a caller learns the answer from whether it changed anything.
   *
   * The predicate is `INTAKE_FROZEN_SQL`, imported from `formation/freeze.ts` — which is also
   * where the prose explaining each of its four clauses lives, and where the TypeScript twin the
   * filer uses sits beside it under a test that asserts the two agree.
   *
   * `intake_synthesized` is cleared: a human typed these values.
   */
  updateIntake(
    companyId: string,
    intake: {
      nameOptions: CompanyNameOption[];
      businessPurpose: string;
      industryLabel: string;
    },
  ): boolean;
}

/**
 * The stale-customer rule (`listStaleCustomerCandidates`), as one WHERE clause over `companies c`
 * taking `@cutoff`, so the listing and the one-company re-read cannot disagree. The latest check is
 * the one with the highest id, as everywhere else that reads `company_checks`. With no check, the
 * first subquery is NULL (stale so far) and the upload clause compares with '' (any upload keeps
 * the company).
 */
const STALE_CUSTOMER_WHERE = `
      c.provider = 'customer'
  AND c.status IN ('draft','ready')
  AND c.created_at <= @cutoff
  AND NOT EXISTS (SELECT 1 FROM formation_payments p
                   WHERE p.company_id = c.company_id
                     AND p.status IN ('quoted','settling','settled','refunded'))
  AND IFNULL((SELECT l.result = 'failed' AND l.created_at < @cutoff
                FROM company_checks l
               WHERE l.company_id = c.company_id
               ORDER BY l.check_id DESC LIMIT 1), 1) = 1
  AND NOT EXISTS (SELECT 1 FROM documents d
                   WHERE d.company_id = c.company_id
                     AND d.source = 'customer'
                     AND d.created_at >= IFNULL((SELECT l.created_at FROM company_checks l
                                                  WHERE l.company_id = c.company_id
                                                  ORDER BY l.check_id DESC LIMIT 1), ''))`;

/** What `CURRENT_TIMESTAMP` writes. An ISO instant (`2026-01-02T00:00:00Z`) sorts after every
 *  stored time of its day, so a cutoff given in that form would take companies up to a day young. */
const SQLITE_UTC_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;

function assertCutoff(cutoffUtc: string): void {
  if (typeof cutoffUtc !== "string" || !SQLITE_UTC_TEXT.test(cutoffUtc))
    throw new Error(
      "companies: the cutoff is SQLite UTC text, YYYY-MM-DD HH:MM:SS (sqliteUtcTimestamp)",
    );
}

export class SqliteCompanyRepository implements CompanyRepository {
  private readonly stmts;
  /** The stale-customer statements, prepared on first use rather than here: they read
   *  `company_checks`, which a database not yet migrated to hold the operator's checks lacks, and
   *  an operator command that runs without the migration (`formation:abandon`) constructs this
   *  repository too. */
  private staleStmts?: { list: Database.Statement; one: Database.Statement };

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
      // once in `livePaymentCount`, both against the same partial index. A customer's own company
      // is left out of both arms: it has its own cap below.
      //
      // 'customer' is the provider value of a customer's own company, here and in the cap below
      // (CUSTOMER_PROVIDER in legalBody/provider.ts).
      countChargeable: db.prepare(
        `SELECT COUNT(*) AS n FROM companies c
          WHERE c.tenant_id = ?
            AND c.provider <> 'customer'
            AND (c.status = 'ready'
                 OR EXISTS (SELECT 1 FROM formation_payments p
                             WHERE p.company_id = c.company_id
                               AND p.status IN ('quoted','settling')))`,
      ),
      countCustomerOpen: db.prepare(
        `SELECT COUNT(*) AS n FROM companies
          WHERE tenant_id = ? AND provider = 'customer' AND status IN ('draft','ready')`,
      ),
      livePayments: db.prepare(
        `SELECT COUNT(*) AS n FROM formation_payments
          WHERE company_id = ? AND status IN ('quoted','settling')`,
      ),
      liveOrSettledPayment: db.prepare(
        `SELECT EXISTS (SELECT 1 FROM formation_payments
                         WHERE company_id = ?
                           AND status IN ('quoted','settling','settled','refunded')) AS found`,
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
      // The §4.7 freeze, as the WHERE clause of the one UPDATE that can re-open an intake — and
      // the predicate itself is IMPORTED, not written here: the filer asks the same question of
      // the same row (`resolveSsn`), and two spellings of the idempotency contract is one
      // spelling too many. See `formation/freeze.ts` for why each disjunct is there.
      //
      // The company-level arm stays local, because it is a predicate over the row being updated
      // rather than over the sub-saga: an `abandoned` company is over, whatever its step says.
      updateIntake: db.prepare(
        `UPDATE companies
            SET name_options = @name_options,
                business_purpose = @business_purpose,
                industry_label = @industry_label,
                -- A human typed these.
                intake_synthesized = 0,
                updated_at = CURRENT_TIMESTAMP
          WHERE company_id = @company_id
            AND status <> 'abandoned'
            AND NOT ${INTAKE_FROZEN_SQL}`,
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

  countCustomerOpenByTenant(tenantId: string): number {
    return (this.stmts.countCustomerOpen.get(tenantId) as { n: number }).n;
  }

  private stale(): { list: Database.Statement; one: Database.Statement } {
    // 'customer' here too is CUSTOMER_PROVIDER.
    this.staleStmts ??= {
      list: this.db.prepare(
        `SELECT c.* FROM companies c
          WHERE ${STALE_CUSTOMER_WHERE}
          ORDER BY c.created_at, c.company_id
          LIMIT @limit`,
      ),
      one: this.db.prepare(
        `SELECT EXISTS (SELECT 1 FROM companies c
                         WHERE c.company_id = @company_id AND ${STALE_CUSTOMER_WHERE}) AS found`,
      ),
    };
    return this.staleStmts;
  }

  listStaleCustomerCandidates(cutoffUtc: string, limit: number): CompanyRecord[] {
    assertCutoff(cutoffUtc);
    // Checked here because SQLite reads a negative LIMIT as no limit at all.
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("companies: limit must be a positive whole number");
    return (this.stale().list.all({ cutoff: cutoffUtc, limit }) as Row[]).map(toRecord);
  }

  isStaleCustomerCandidate(companyId: string, cutoffUtc: string): boolean {
    assertCutoff(cutoffUtc);
    return (
      (
        this.stale().one.get({ company_id: companyId, cutoff: cutoffUtc }) as {
          found: number;
        }
      ).found === 1
    );
  }

  livePaymentCount(companyId: string): number {
    return (this.stmts.livePayments.get(companyId) as { n: number }).n;
  }

  hasLiveOrSettledPayment(companyId: string): boolean {
    return (this.stmts.liveOrSettledPayment.get(companyId) as { found: number }).found === 1;
  }

  countAgents(companyId: string): number {
    return (this.stmts.countAgents.get(companyId) as { n: number }).n;
  }

  countAgentsMany(companyIds: string[]): Map<string, number> {
    return this.groupCount(
      companyIds,
      (list) =>
        `SELECT company_id AS k, COUNT(*) AS n FROM entities
          WHERE company_id IN (${list}) GROUP BY company_id`,
    );
  }

  livePaymentCountMany(companyIds: string[]): Map<string, number> {
    return this.groupCount(
      companyIds,
      (list) =>
        `SELECT company_id AS k, COUNT(*) AS n FROM formation_payments
          WHERE company_id IN (${list}) AND status IN ('quoted','settling')
          GROUP BY company_id`,
    );
  }

  /** Chunked at 400, clear of SQLITE_MAX_VARIABLE_NUMBER — the `findMany` idiom, for counts. */
  private groupCount(companyIds: string[], sql: (list: string) => string): Map<string, number> {
    const out = new Map<string, number>();
    if (companyIds.length === 0) return out;
    for (let i = 0; i < companyIds.length; i += 400) {
      const chunk = companyIds.slice(i, i + 400);
      const rows = this.db.prepare(sql(chunk.map(() => "?").join(","))).all(...chunk) as {
        k: string;
        n: number;
      }[];
      for (const r of rows) out.set(r.k, r.n);
    }
    return out;
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

  updateIntake(
    companyId: string,
    intake: {
      nameOptions: CompanyNameOption[];
      businessPurpose: string;
      industryLabel: string;
    },
  ): boolean {
    return (
      this.stmts.updateIntake.run({
        company_id: companyId,
        name_options: JSON.stringify(intake.nameOptions),
        business_purpose: intake.businessPurpose,
        industry_label: intake.industryLabel,
      }).changes === 1
    );
  }
}
