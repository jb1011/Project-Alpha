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
 *  - a party is bound to at most ONE entity (`entity_key` is UNIQUE), exactly once, at the
 *    onboarding claim. Re-using a bound party would file two companies for one person's consent.
 *
 * A party is created BEFORE its entity exists, which is why the row is keyed by `party_id` and
 * carries its own `tenant_id`: ownership must be answerable with no entity to answer it from.
 */
export interface FormationPartyRecord {
  partyId: string;
  /** Null until the onboarding claim binds it. */
  entityKey: string | null;
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
  "partyId" | "entityKey" | "deletedAt" | "createdAt"
> & {
  partyId?: string;
};

interface Row {
  party_id: string;
  entity_key: string | null;
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
  /** Bind a party to an entity. CAS: only an UNBOUND party owned by this tenant moves, and only
   *  once — the return value says whether THIS caller made the binding. */
  bind(partyId: string, entityKey: string, tenantId: string): boolean;
  /** The bound party for an entity — what `create_provider` files with. */
  findByEntityKey(entityKey: string): FormationPartyRecord | undefined;
  /**
   * Erasure candidates (design §3, audit H7, C7). Two disjoint reasons, one query each:
   *
   *  - a party bound to an entity whose formation is TERMINAL (`create_provider` abandoned) and
   *    which was PROVABLY NEVER FILED;
   *  - an **unbound** party older than the cutoff — a form that was filled in and never used, and
   *    with no entity there is nothing it could have been filed for.
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
   * ERASE: NULL every column that is personal data and stamp `deleted_at`. `party_id`,
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
      bind: db.prepare(
        `UPDATE formation_parties SET entity_key = ?
          WHERE party_id = ? AND tenant_id = ? AND entity_key IS NULL AND deleted_at IS NULL`,
      ),
      findByEntity: db.prepare(
        "SELECT * FROM formation_parties WHERE entity_key = ? AND deleted_at IS NULL",
      ),
      listAbandoned: db.prepare(
        `SELECT p.party_id AS party_id
           FROM formation_parties p
           JOIN formation_requests f
             ON f.entity_key = p.entity_key AND f.step = 'create_provider'
          WHERE p.deleted_at IS NULL
            AND f.state = 'abandoned'
            -- A company id means the create RETURNED. Whatever the saga decided afterwards, a
            -- real filing may exist under this person's name.
            AND f.provider_ref IS NULL
            -- And doola's own answer never said the state filed it.
            AND NOT EXISTS (
                  SELECT 1 FROM formation_requests g
                   WHERE g.entity_key = p.entity_key
                     AND g.step = 'await_filing'
                     AND g.state = 'confirmed')`,
      ),
      listStaleUnbound: db.prepare(
        `SELECT party_id FROM formation_parties
          WHERE deleted_at IS NULL AND entity_key IS NULL AND created_at < ?`,
      ),
      // Every PII column to NULL in ONE statement — a loop, or a second pass, is a window in
      // which half a person's data is erased and half is not.
      erase: db.prepare(
        `UPDATE formation_parties
            SET legal_first_name = NULL, legal_last_name = NULL, email = NULL, phone = NULL,
                line1 = NULL, line2 = NULL, city = NULL, region = NULL,
                postal_code = NULL, country = NULL,
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

  bind(partyId: string, entityKey: string, tenantId: string): boolean {
    // A compare-and-set, not a read-then-write: two onboards racing the same partyId must not
    // both believe they own it, and the entity_key UNIQUE constraint is the second lock (one
    // party per entity, one entity per party).
    return this.stmts.bind.run(entityKey, partyId, tenantId).changes === 1;
  }

  findByEntityKey(entityKey: string): FormationPartyRecord | undefined {
    const r = this.stmts.findByEntity.get(entityKey) as Row | undefined;
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
    // The two sets are disjoint by construction (one requires a bound entity_key, the other
    // requires it to be NULL), so no de-duplication is needed or wanted.
    return [...abandoned, ...unbound];
  }

  erase(partyId: string): boolean {
    return this.stmts.erase.run(partyId).changes === 1;
  }
}
