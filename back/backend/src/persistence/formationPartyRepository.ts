import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * The formation party — the natural person legally answerable for a filed entity (design §3/§5).
 *
 * **This is the only table in the system that holds PII, and it is the only module allowed to
 * read it.** The discipline it exists to enforce:
 *
 *  - PII never rides in `spec` (spec_json is persisted AND rendered) and never in an MCP tool
 *    argument. A caller posts a legal identity ONCE, gets an opaque `partyId`, and passes that
 *    handle to onboard;
 *  - nothing here is ever projected into `EntityView`, `/transparency`, `/metadata`, the OA
 *    manifest, or opsLog. The only identifiers that may leave this module are the `partyId` and
 *    a truncated tenant id;
 *  - a party is SINGLE-USE: it is bound to at most ONE company (`company_id` is UNIQUE), exactly
 *    once, inside the transaction that mints that company. Re-using a bound party would file two
 *    companies for one person's consent, so a second company needs a second row — fresh intake,
 *    fresh SSN capture, its own erasure clocks.
 *
 * A party is created BEFORE its company exists, which is why the row is keyed by `party_id` and
 * carries its own `tenant_id`: ownership must be answerable with no company to answer it from.
 * `entity_key` is kept, and still UNIQUE, but nothing binds it any more: it is the legacy locator
 * the migration left behind, and it is what keeps an old row's history readable.
 */
export interface FormationPartyRecord {
  partyId: string;
  /** Legacy locator: the entity a pre-2026-08-26 party was bound to. Never written any more. */
  entityKey: string | null;
  /** Null until `createCompany` binds it, and then never again — the single-use rule. */
  companyId: string | null;
  tenantId: string;
  legalFirstName: string;
  legalLastName: string;
  email: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  /** US: the 2-letter state. Null for the countries that have no state/province. */
  region: string | null;
  postalCode: string;
  /** ISO-3166-1 alpha-3, e.g. "USA". */
  country: string;
  /** When this row was created (SQLite UTC TEXT). Survives erasure — see `erase`. */
  createdAt: string;
  /** True = a labeled sandbox fixture, not a real natural person (§3, audit H7). */
  synthetic: boolean;
  /** Erasure marker for a party that never reached a filing. */
  deletedAt: string | null;
}

/**
 * What the intake surfaces hand in.
 *
 * `partyId` is optional and is NOT a caller-facing field: the sandbox fixture's email embeds the
 * id (`sandbox+<partyId>@novicorpus.com`), so that one path mints the uuid before building the
 * row. Every other path leaves it out and gets one from here.
 */
export type NewFormationParty = Omit<
  FormationPartyRecord,
  "partyId" | "entityKey" | "companyId" | "deletedAt" | "createdAt"
> & {
  partyId?: string;
};

interface Row {
  party_id: string;
  entity_key: string | null;
  company_id: string | null;
  tenant_id: string;
  legal_first_name: string;
  legal_last_name: string;
  email: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postal_code: string;
  country: string;
  synthetic: number;
  created_at: string;
  deleted_at: string | null;
}

function toRecord(r: Row): FormationPartyRecord {
  return {
    partyId: r.party_id,
    entityKey: r.entity_key,
    companyId: r.company_id,
    tenantId: r.tenant_id,
    legalFirstName: r.legal_first_name,
    legalLastName: r.legal_last_name,
    email: r.email,
    phone: r.phone,
    line1: r.line1,
    line2: r.line2,
    city: r.city,
    region: r.region,
    postalCode: r.postal_code,
    country: r.country,
    synthetic: r.synthetic === 1,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
  };
}

/** The narrow surface the doors and the saga use. Injectable so tests fake it honestly. */
export interface FormationPartyRepository {
  create(input: NewFormationParty): string;
  /** A party the tenant owns, whether or not it is bound. Undefined = not theirs / not there. */
  findOwned(tenantId: string, partyId: string): FormationPartyRecord | undefined;
  /** Bind a party to a COMPANY. CAS: only an UNBOUND party owned by this tenant moves, and only
   *  once — the return value says whether THIS caller made the binding, and a `false` is what
   *  rolls back the company insert it sits beside. */
  bindToCompany(partyId: string, companyId: string, tenantId: string): boolean;
  /** The bound party for a company — what `create_provider` files with. */
  findByCompanyId(companyId: string): FormationPartyRecord | undefined;
  /**
   * Erasure candidates (design §3, audit H7, C7). Two disjoint reasons, one query each:
   *
   *  - a party bound to a COMPANY whose formation is TERMINAL (`create_provider` abandoned) and
   *    which was PROVABLY NEVER FILED;
   *  - an **unbound** party older than the cutoff — a form that was filled in and never used, and
   *    with neither a company nor an entity there is nothing it could have been filed for.
   *
   * "Provably never filed" is the whole of C7, and it is deliberately conservative, because the
   * two errors are not symmetric: erasing too late is a retention-policy miss, while erasing too
   * early destroys the identity of the responsible party on a REAL Wyoming filing — data we are
   * required to hold and cannot reconstruct. So it takes BOTH:
   *
   *  - `create_provider` has **no `provider_ref`**. A ref means `POST /companies` returned: a
   *    company exists, or very likely exists, at doola. `abandoned` says our SAGA gave up, which
   *    is a statement about our retries and not about Wyoming's records;
   *  - `await_filing` is **not confirmed**. That row is the one that says the STATE filed it, and
   *    it is written from doola's own answer.
   *
   * A party bound to a filing that DID happen is therefore never in this list, whatever the saga
   * subsequently did — erasing our copy would not unfile it.
   */
  listErasable(unboundCutoffUtc: string): { partyId: string; reason: "abandoned" | "unbound" }[];
  /**
   * ERASE: NULL every column that is personal data — the four SSN columns included — and stamp
   * `deleted_at`. `party_id`,
   * `tenant_id` and the timestamps survive so the erasure itself remains auditable — "this handle
   * existed and its contents were destroyed on this date" is the record we owe, and a deleted row
   * could not carry it.
   *
   * Returns false when the row was already erased (idempotent under a re-run of the sweep).
   */
  erase(partyId: string): boolean;
}

export class SqliteFormationPartyRepository implements FormationPartyRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO formation_parties
           (party_id, tenant_id, legal_first_name, legal_last_name, email, phone,
            line1, line2, city, region, postal_code, country, synthetic)
         VALUES (@party_id, @tenant_id, @legal_first_name, @legal_last_name, @email, @phone,
                 @line1, @line2, @city, @region, @postal_code, @country, @synthetic)`,
      ),
      // `deleted_at IS NULL` on every read: an erased party is gone for every purpose, and a
      // lookup that ignored the marker would file with data we promised to have destroyed.
      findOwned: db.prepare(
        "SELECT * FROM formation_parties WHERE party_id = ? AND tenant_id = ? AND deleted_at IS NULL",
      ),
      bindToCompany: db.prepare(
        `UPDATE formation_parties SET company_id = ?
          WHERE party_id = ? AND tenant_id = ? AND company_id IS NULL AND deleted_at IS NULL`,
      ),
      findByCompany: db.prepare(
        "SELECT * FROM formation_parties WHERE company_id = ? AND deleted_at IS NULL",
      ),
      // The SAME three conditions, restated at company scope (2026-08-26 §2 step 4).
      listAbandoned: db.prepare(
        `SELECT p.party_id AS party_id
           FROM formation_parties p
           JOIN formation_requests f
             ON f.company_id = p.company_id AND f.step = 'create_provider'
          WHERE p.deleted_at IS NULL
            AND f.state = 'abandoned'
            -- A company id means the create RETURNED. Whatever the saga decided afterwards, a
            -- real filing may exist under this person's name.
            AND f.provider_ref IS NULL
            -- And doola's own answer never said the state filed it.
            AND NOT EXISTS (
                  SELECT 1 FROM formation_requests g
                   WHERE g.company_id = p.company_id
                     AND g.step = 'await_filing'
                     AND g.state = 'confirmed')`,
      ),
      // BOTH keys must be null. "Never used" is the claim this query makes, and a row a backfill
      // missed — bound to an entity, attached to no company — is not that. A predicate on
      // `company_id` alone would NULL the responsible party of every pre-migration filing.
      listStaleUnbound: db.prepare(
        `SELECT party_id FROM formation_parties
          WHERE deleted_at IS NULL AND company_id IS NULL AND entity_key IS NULL
            AND created_at < ?`,
      ),
      // Every PII column to NULL in ONE statement — a loop, or a second pass, is a window in
      // which half a person's data is erased and half is not.
      erase: db.prepare(
        `UPDATE formation_parties
            SET legal_first_name = NULL, legal_last_name = NULL, email = NULL, phone = NULL,
                line1 = NULL, line2 = NULL, city = NULL, region = NULL,
                postal_code = NULL, country = NULL,
                -- The SSN columns are part of the ONE statement, not a second pass: half a
                -- person's data erased and half not is exactly the window this shape avoids.
                ssn_ciphertext = NULL, ssn_iv = NULL, ssn_key_id = NULL,
                ssn_deleted_at = COALESCE(ssn_deleted_at, CURRENT_TIMESTAMP),
                deleted_at = CURRENT_TIMESTAMP
          WHERE party_id = ? AND deleted_at IS NULL`,
      ),
    };
  }

  create(input: NewFormationParty): string {
    const partyId = input.partyId ?? randomUUID();
    this.stmts.insert.run({
      party_id: partyId,
      tenant_id: input.tenantId,
      legal_first_name: input.legalFirstName,
      legal_last_name: input.legalLastName,
      email: input.email,
      phone: input.phone,
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      region: input.region,
      postal_code: input.postalCode,
      country: input.country,
      synthetic: input.synthetic ? 1 : 0,
    });
    return partyId;
  }

  findOwned(tenantId: string, partyId: string): FormationPartyRecord | undefined {
    const r = this.stmts.findOwned.get(partyId, tenantId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  bindToCompany(partyId: string, companyId: string, tenantId: string): boolean {
    // A compare-and-set, not a read-then-write: two creates racing the same partyId must not both
    // believe they own it, and the `company_id` UNIQUE index is the second lock (one party per
    // company, one company per party).
    return this.stmts.bindToCompany.run(companyId, partyId, tenantId).changes === 1;
  }

  findByCompanyId(companyId: string): FormationPartyRecord | undefined {
    const r = this.stmts.findByCompany.get(companyId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  listErasable(unboundCutoffUtc: string): { partyId: string; reason: "abandoned" | "unbound" }[] {
    const abandoned = (this.stmts.listAbandoned.all() as { party_id: string }[]).map((r) => ({
      partyId: r.party_id,
      reason: "abandoned" as const,
    }));
    const unbound = (
      this.stmts.listStaleUnbound.all(unboundCutoffUtc) as { party_id: string }[]
    ).map((r) => ({ partyId: r.party_id, reason: "unbound" as const }));
    // The two sets are disjoint by construction (one requires a bound company, the other requires
    // BOTH keys to be NULL), so no de-duplication is needed or wanted.
    return [...abandoned, ...unbound];
  }

  erase(partyId: string): boolean {
    return this.stmts.erase.run(partyId).changes === 1;
  }
}
