import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PARTY_EDIT_ALLOWED_SQL, everSubmitted } from "../formation/freeze";
import type { EncryptedSsn } from "../formation/pii";
import type { SsnErasedReason } from "../formation/ssnErasure";
import type { CompanyStatus } from "./companyRepository";
import type { FormationState } from "./formationRepository";

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
  /**
   * WHY this row holds no SSN, or null when the question has never arisen (§4.6a).
   *
   * Read by the FILER, not only by an operator: `ttl` means the CLOCK took a number the caller
   * supplied, before anything was ever sent — and a filing that discovers that must park for a
   * human rather than quietly file a body without it. `none` is the mark left by a human who
   * decided to proceed without one.
   */
  ssnErasedReason: SsnErasedReason | null;
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
  "partyId" | "entityKey" | "companyId" | "deletedAt" | "createdAt" | "ssnErasedReason"
> & {
  partyId?: string;
};

/**
 * The ten columns the party-edit door may rewrite (design §7, A3) — the identity, and nothing
 * that decides what happens to it.
 *
 * Its own type rather than an `Omit` of `NewFormationParty`, so that what a caller may change is
 * a positive list somebody wrote down. `tenant_id` (ownership), `synthetic` (a property of the
 * DEPLOYMENT the party was created against), `company_id` (single-use, and this is not a re-bind)
 * and every `ssn_*` column are absent by construction, not by subtraction.
 */
export type EditablePartyFields = Pick<
  FormationPartyRecord,
  | "legalFirstName"
  | "legalLastName"
  | "email"
  | "phone"
  | "line1"
  | "line2"
  | "city"
  | "region"
  | "postalCode"
  | "country"
>;

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
  ssn_erased_reason: string | null;
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
    ssnErasedReason: (r.ssn_erased_reason as SsnErasedReason | null) ?? null,
  };
}

/**
 * One SSN-holding row, with everything the TTL sweeper needs to decide (design §4.6a).
 *
 * It is a JOIN rather than four reads because the decision is a conjunction over three tables,
 * and it is answered in TypeScript rather than in SQL because the set is tiny by construction —
 * only rows that still hold an SSN, which is the handful of companies between an intake and a
 * `provider_ref`. A predicate this consequential is worth reading as prose.
 */
export interface SsnRetentionRow {
  partyId: string;
  companyId: string;
  /**
   * When the SSN was captured, as a SQLite UTC TEXT — `formation_parties.ssn_captured_at`.
   *
   * It used to be the COMPANY's `created_at`, on the argument that the SSN rides the same
   * request that mints the company. That is true of the FIRST capture and false of every other
   * one: §4.7's edit-and-retry captures a fresh number onto a company that may be a week old, and
   * a clock keyed to the company row would erase it on the next sweep — deleting, within minutes,
   * a number the caller had just been asked for and believes is in flight. The clock has to run
   * from the CAPTURE, so the capture is what the column records.
   *
   * Rows written before the column existed have NULL, and the query falls back to the company's
   * `created_at`: the same answer those rows have always had.
   */
  capturedAt: string;
  companyStatus: CompanyStatus;
  /** `create_provider`'s state, or null when the step was never opened at all. */
  createState: FormationState | null;
  providerRef: string | null;
  /**
   * Has this company's filing EVER been in flight at doola?
   *
   * Deliberately broader than "the row is currently `submitted`", because a row that was
   * submitted and then failed is back at `failed` and its state no longer remembers. It is true
   * for a live/terminal state, for a persisted `provider_ref`, and for a `detail` carrying a
   * customer id or a `companySentAttempt` — any one of which means we have talked to doola about
   * this company. The failure direction is deliberate: keeping an SSN a week too long is a
   * retention miss, while erasing one mid-flight wedges a same-key retry (§4.4).
   */
  everSubmitted: boolean;
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

  /**
   * REWRITE the identity, and NOTHING else (design §7, A3's party-edit door).
   *
   * The ten PII columns, tenant-scoped and refusing an erased row. Deliberately NOT in the
   * statement: `company_id` (the bind is single-use and this is not a re-bind), `synthetic` (a
   * property of the DEPLOYMENT the party was created against, never of a request), `tenant_id`,
   * and every `ssn_*` column — an SSN is not editable here and never travels to this door, which
   * is why there is no field for one to arrive in.
   *
   * Returns whether the row moved. WHEN it may move is `PARTY_EDIT_ALLOWED_SQL`, carried IN THE
   * WHERE CLAUSE — the `INTAKE_FROZEN_SQL` precedent. It is a correlated subquery over a
   * DIFFERENT table (the company's `create_provider` step), which is why it was left in
   * TypeScript at first; but a rule that lives only above the write is a rule the next caller of
   * this method has to remember, and `test/formation/freeze.test.ts` runs the two spellings over
   * one matrix so they cannot drift. The domain function asks the TypeScript twin as well,
   * because that is what produces the actionable refusal rather than a bare `false`.
   *
   * `companyId` is REQUIRED and is part of the WHERE: the door is company-addressed, and the
   * statement will only move a party that is bound to the company the caller named.
   */
  update(
    partyId: string,
    tenantId: string,
    companyId: string,
    fields: EditablePartyFields,
  ): boolean;
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

  // ── THE SSN (design 2026-08-26 §4) ────────────────────────────────────────────────────────
  //
  // Three operations and one query, and every one of them is keyed by the COMPANY as well as the
  // party. That is not redundancy: the AAD the ciphertext is sealed under is `party_id ||
  // company_id`, so a read that did not know the company could not decrypt anyway, and a write
  // that did not check it could seal a row under a binding nothing will ever satisfy.

  /**
   * Store an encrypted SSN against a bound party. Returns whether it was written.
   *
   * CAS on the (party, company) pair AND on there being no live ciphertext, so an SSN is
   * WRITE-ONCE for as long as one exists. `ssn_deleted_at` is cleared, because the one path that
   * writes over an erased row is the §4.7 edit-and-retry re-capture, and a row holding a live
   * ciphertext under an "erased on" stamp would be a lie in the audit trail.
   */
  storeSsn(partyId: string, companyId: string, rec: EncryptedSsn): boolean;

  /**
   * The stored SSN for a company, with the party id the AAD needs. Undefined when there is none —
   * which is the ordinary state of every company past its `provider_ref`.
   */
  findSsnByCompanyId(companyId: string): (EncryptedSsn & { partyId: string }) | undefined;

  /**
   * ERASE the SSN, stamp `ssn_deleted_at`, and RECORD WHY, leaving the rest of the party intact.
   *
   * Its own operation, distinct from `erase`: the SSN dies at the moment the filing no longer
   * needs it (§4.4 — the transaction that persists `provider_ref`), which is typically YEARS
   * before the party row itself is erasable, if ever. Idempotent: false means there was nothing
   * to erase, which is what every backstop pass sees.
   *
   * The reason is REQUIRED rather than optional: the record is the only thing that remains once
   * the value is gone. Call it through `eraseSsnLogged`, which is what makes the ops line
   * unforgettable too.
   */
  eraseSsn(companyId: string, reason: Exclude<SsnErasedReason, "none">): boolean;

  /**
   * Record that a human chose to file WITHOUT an SSN after the clock erased one (§4.6a).
   *
   * The second exit from the park a `ttl` erasure causes. Returns whether the row moved — false
   * when the company holds a live SSN (nothing to decide) or has no party.
   */
  proceedWithoutSsn(companyId: string): boolean;

  /** Every party still holding an SSN, with what the TTL clock needs to judge it (§4.6a). */
  listSsnRetention(): SsnRetentionRow[];

  /**
   * The §4.6a DECISION STATE of a company's responsible party — an enum and a boolean, and
   * deliberately nothing else (A3).
   *
   * `awaitsSsnDecision` (formation/freeze.ts) is the predicate; this is the half of its input
   * that lives in the PII table. It exists as its own method rather than as a `findByCompanyId`
   * at the call site because the company detail VIEW asks it, and a view holding a whole party
   * record is a legal name one careless spread away from a response body. Undefined = no party
   * (or an erased one), which is not a state that can be waiting for a decision.
   */
  ssnState(
    companyId: string,
  ): { ssnErasedReason: SsnErasedReason | null; hasSsn: boolean } | undefined;
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
      // The ten PII columns and nothing else — see the interface comment for what is deliberately
      // absent from this list.
      update: db.prepare(
        `UPDATE formation_parties
            SET legal_first_name = @legal_first_name, legal_last_name = @legal_last_name,
                email = @email, phone = @phone,
                line1 = @line1, line2 = @line2, city = @city, region = @region,
                postal_code = @postal_code, country = @country
          WHERE party_id = @party_id AND tenant_id = @tenant_id
            AND company_id = @company_id
            AND deleted_at IS NULL
            -- THE FREEZE, in the statement itself (design §7, A3) — the INTAKE_FROZEN_SQL
            -- precedent, one predicate along. The domain function asks the TypeScript twin so it
            -- can return the actionable refusal; this is the lock that holds for a caller who
            -- reaches this method some other way, which is the failure mode a check living only
            -- above the write has always had.
            AND ${PARTY_EDIT_ALLOWED_SQL}`,
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
                -- COALESCE, so an erasure that already has a reason keeps it. C7 only ever
                -- fires for a company that provably never filed, or for a party that was never
                -- used at all, which is the same terminal fact 'terminal' names.
                ssn_erased_reason = COALESCE(ssn_erased_reason, 'terminal'),
                deleted_at = CURRENT_TIMESTAMP
          WHERE party_id = ? AND deleted_at IS NULL`,
      ),
      // ── the SSN (§4) ──────────────────────────────────────────────────────────────────────
      // Keyed on the (party, company) PAIR, which is the pair the ciphertext's AAD is sealed
      // under: a write against the wrong company would produce a row nothing can ever open.
      storeSsn: db.prepare(
        `UPDATE formation_parties
            SET ssn_ciphertext = @ciphertext, ssn_iv = @iv, ssn_key_id = @key_id,
                -- THE CLOCK STARTS HERE, on every capture including a re-capture (§4.6a).
                ssn_captured_at = CURRENT_TIMESTAMP,
                -- Cleared, not kept: the one path that writes over an erased row is the §4.7
                -- re-capture, and a live ciphertext under an "erased on" stamp is a lie. The
                -- reason goes with it — a row that HOLDS an SSN has no explanation to give for
                -- why it does not.
                ssn_deleted_at = NULL,
                ssn_erased_reason = NULL
          WHERE party_id = @party_id AND company_id = @company_id
            AND deleted_at IS NULL
            -- WRITE-ONCE while one exists. A second SSN for a live filing would change the body
            -- under an idempotency key doola is already holding (§4.4/§4.5).
            AND ssn_ciphertext IS NULL`,
      ),
      findSsn: db.prepare(
        `SELECT party_id, ssn_ciphertext, ssn_iv, ssn_key_id FROM formation_parties
          WHERE company_id = ? AND deleted_at IS NULL AND ssn_ciphertext IS NOT NULL`,
      ),
      eraseSsn: db.prepare(
        `UPDATE formation_parties
            SET ssn_ciphertext = NULL, ssn_iv = NULL, ssn_key_id = NULL,
                ssn_deleted_at = CURRENT_TIMESTAMP,
                -- WHY, on the row, in the same statement that destroys the value. Two writes
                -- would be two chances to record one and not the other.
                ssn_erased_reason = @reason,
                -- The capture clock ends with the value it timed. Leaving it would make a
                -- re-capture's freshness ambiguous, and ssn_deleted_at already records the
                -- other end of the interval.
                ssn_captured_at = NULL
          WHERE company_id = @company_id AND deleted_at IS NULL AND ssn_ciphertext IS NOT NULL`,
      ),
      // A human's decision to file WITHOUT one, after the clock took theirs (§4.6a). It is the
      // OTHER exit from the parked filing — the first being a fresh capture — and it is a fact
      // rather than a flag: the row stops saying "the clock took it" and starts saying "the
      // owner said go ahead", which is what lets the next pass send a body with no `ssn` key.
      proceedWithoutSsn: db.prepare(
        `UPDATE formation_parties SET ssn_erased_reason = 'none'
          WHERE company_id = ? AND deleted_at IS NULL AND ssn_ciphertext IS NULL`,
      ),
      // The §4.6a decision state, with NO personal column in the SELECT list at all: an enum and
      // a NULL-check, which is the whole of what `awaitsSsnDecision` reads.
      ssnState: db.prepare(
        `SELECT ssn_erased_reason AS reason, ssn_ciphertext IS NOT NULL AS has_ssn
           FROM formation_parties
          WHERE company_id = ? AND deleted_at IS NULL`,
      ),
      // Only rows that still HOLD an SSN — a handful at any moment, being exactly the companies
      // between an intake and a `provider_ref`.
      ssnRetention: db.prepare(
        `SELECT p.party_id      AS party_id,
                p.company_id    AS company_id,
                -- The CAPTURE, falling back to the company for rows written before the column
                -- existed — which is the clock those rows have always been judged by.
                COALESCE(p.ssn_captured_at, c.created_at) AS captured_at,
                c.status        AS company_status,
                f.state         AS create_state,
                f.provider_ref  AS provider_ref,
                f.detail        AS detail
           FROM formation_parties p
           JOIN companies c ON c.company_id = p.company_id
           LEFT JOIN formation_requests f
             ON f.company_id = p.company_id AND f.step = 'create_provider'
          WHERE p.deleted_at IS NULL AND p.ssn_ciphertext IS NOT NULL`,
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

  update(
    partyId: string,
    tenantId: string,
    companyId: string,
    fields: EditablePartyFields,
  ): boolean {
    return (
      this.stmts.update.run({
        party_id: partyId,
        tenant_id: tenantId,
        company_id: companyId,
        legal_first_name: fields.legalFirstName,
        legal_last_name: fields.legalLastName,
        email: fields.email,
        phone: fields.phone,
        line1: fields.line1,
        line2: fields.line2,
        city: fields.city,
        region: fields.region,
        postal_code: fields.postalCode,
        country: fields.country,
      }).changes === 1
    );
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

  storeSsn(partyId: string, companyId: string, rec: EncryptedSsn): boolean {
    return (
      this.stmts.storeSsn.run({
        party_id: partyId,
        company_id: companyId,
        ciphertext: rec.ciphertext,
        iv: rec.iv,
        key_id: rec.keyId,
      }).changes === 1
    );
  }

  findSsnByCompanyId(companyId: string): (EncryptedSsn & { partyId: string }) | undefined {
    const r = this.stmts.findSsn.get(companyId) as
      | {
          party_id: string;
          ssn_ciphertext: Buffer;
          ssn_iv: Buffer;
          ssn_key_id: string;
        }
      | undefined;
    return r
      ? {
          partyId: r.party_id,
          ciphertext: r.ssn_ciphertext,
          iv: r.ssn_iv,
          keyId: r.ssn_key_id,
        }
      : undefined;
  }

  eraseSsn(companyId: string, reason: Exclude<SsnErasedReason, "none">): boolean {
    return this.stmts.eraseSsn.run({ company_id: companyId, reason }).changes === 1;
  }

  proceedWithoutSsn(companyId: string): boolean {
    return this.stmts.proceedWithoutSsn.run(companyId).changes === 1;
  }

  ssnState(
    companyId: string,
  ): { ssnErasedReason: SsnErasedReason | null; hasSsn: boolean } | undefined {
    const r = this.stmts.ssnState.get(companyId) as
      | { reason: string | null; has_ssn: number }
      | undefined;
    return r
      ? { ssnErasedReason: (r.reason as SsnErasedReason | null) ?? null, hasSsn: r.has_ssn === 1 }
      : undefined;
  }

  listSsnRetention(): SsnRetentionRow[] {
    const rows = this.stmts.ssnRetention.all() as {
      party_id: string;
      company_id: string;
      captured_at: string;
      company_status: CompanyStatus;
      create_state: FormationState | null;
      provider_ref: string | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      partyId: r.party_id,
      companyId: r.company_id,
      capturedAt: r.captured_at,
      companyStatus: r.company_status,
      createState: r.create_state,
      providerRef: r.provider_ref,
      everSubmitted: everSubmitted(r.create_state, r.provider_ref, r.detail),
    }));
  }
}

// `everSubmitted` used to live here. It is now in `formation/freeze.ts`, beside the freeze
// predicate: both are read off the same `create_provider` row, both treat an unreadable `detail`
// as the cautious answer, and keeping them apart is how the two definitions of "in flight" drift.
