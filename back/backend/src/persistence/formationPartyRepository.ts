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
  /** True = a labeled sandbox fixture, not a real natural person (§3, audit H7). */
  synthetic: boolean;
  /** Erasure marker for a party that never reached a filing. */
  deletedAt: string | null;
}

/** What the intake surfaces hand in. `partyId` is minted here, never supplied by a caller. */
export type NewFormationParty = Omit<FormationPartyRecord, "partyId" | "entityKey" | "deletedAt">;

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
    };
  }

  create(input: NewFormationParty): string {
    const partyId = randomUUID();
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
}
