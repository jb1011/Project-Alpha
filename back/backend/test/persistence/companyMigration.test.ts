import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { DEFAULT_DESCRIPTION, DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteOaAnchorRepository } from "../../src/persistence/oaAnchorRepository";
import {
  legacyDocument,
  legacyEntity,
  legacyParty,
  legacyStep,
  openLegacyDb,
} from "../helpers/legacyFormationDb";

/**
 * THE MIGRATION (design 2026-08-26 §2, step 5's fixtures).
 *
 * Every case here is a failure two adversarial passes found in the naive version: a duplicate
 * LLC, an erased responsible party, a re-anchored fleet. They run against a GENUINE pre-migration
 * database (`test/helpers/legacyFormationDb.ts`), because a fixture built by the code under test
 * would prove only that the code agrees with itself.
 */

function companyOf(db: Database.Database, entityKey: string) {
  return db
    .prepare(
      `SELECT c.* FROM companies c JOIN entities e ON e.company_id = c.company_id
        WHERE e.idempotency_key = ?`,
    )
    .get(entityKey) as Record<string, unknown> | undefined;
}

describe("the entity → company re-key", () => {
  test("a PR-4-era database with a formed entity migrates losslessly", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db, {
      filedAt: 1_756_000_000,
      filingNumber: "2026-123456",
      einReal: "88-1234567",
      specJson: JSON.stringify({ metadata: { description: "A research agent." } }),
    });
    legacyParty(db, { partyId: "p1", entityKey: key });
    legacyStep(db, {
      entityKey: key,
      step: "create_provider",
      state: "confirmed",
      providerRef: "cmp-1",
      attempt: 2,
      detail: '{"customerId":"cus-1"}',
    });
    legacyStep(db, {
      entityKey: key,
      step: "await_filing",
      state: "confirmed",
      updatedAt: "2026-08-03 09:00:00",
    });
    legacyStep(db, { entityKey: key, step: "fetch_documents", state: "confirmed" });
    legacyStep(db, {
      entityKey: key,
      step: "await_ein",
      state: "pending",
      nextPollAt: 1_756_100_000,
    });
    legacyDocument(db, {
      id: "doc-a",
      entityKey: key,
      docType: "ArticlesOfOrganization",
      providerDocId: "d1",
    });

    migrate(db);

    const company = companyOf(db, key);
    expect(company).toBeDefined();
    expect(company?.status).toBe("ready");
    expect(company?.intake_synthesized).toBe(1);
    expect(company?.provider).toBe("doola");
    expect(company?.environment).toBe("sandbox");
    expect(company?.industry_label).toBe(DEFAULT_INDUSTRY);
    expect(company?.business_purpose).toBe("A research agent.");
    // The canonical name-option shape, position 1, ending split off.
    expect(JSON.parse(company?.name_options as string)).toEqual([
      { name: "Formation Agent", entityTypeEnding: "LLC", position: 1 },
    ]);
    // The legal facts moved onto the company — that is what deriveLegalBlock reads now.
    expect(company?.filed_at).toBe(1_756_000_000);
    expect(company?.filing_number).toBe("2026-123456");
    expect(company?.ein).toBe("88-1234567");
    // …and the filed NAME is null, which is what keeps every migrated manifest byte-identical.
    expect(company?.legal_name_filed).toBeNull();

    // All four sub-saga rows survive, re-keyed, with their columns copied VERBATIM.
    const steps = db
      .prepare("SELECT * FROM formation_requests WHERE company_id = ? ORDER BY step")
      .all(company?.company_id) as Record<string, unknown>[];
    expect(steps).toHaveLength(4);
    const create = steps.find((s) => s.step === "create_provider")!;
    expect(create.state).toBe("confirmed");
    expect(create.attempt).toBe(2);
    expect(create.provider_ref).toBe("cmp-1");
    expect(create.detail).toBe('{"customerId":"cus-1"}');
    const ein = steps.find((s) => s.step === "await_ein")!;
    expect(ein.next_poll_at).toBe(1_756_100_000);

    // The party and the document follow the entity onto the company.
    expect(
      (
        db.prepare("SELECT company_id FROM formation_parties WHERE party_id = 'p1'").get() as {
          company_id: string;
        }
      ).company_id,
    ).toBe(company?.company_id);
    const doc = db.prepare("SELECT * FROM documents WHERE id = 'doc-a'").get() as Record<
      string,
      unknown
    >;
    expect(doc.company_id).toBe(company?.company_id);
    // The index id and the path are NOT re-derived: the manifest commits to these bytes.
    expect(doc.path).toBe("doc-doc-a.pdf");
    expect(doc.entity_key).toBe(key);
  });

  test("timestamps are copied VERBATIM — a re-stamp would make every formed entity due forever", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db);
    legacyParty(db, { partyId: "p1", entityKey: key });
    legacyStep(db, {
      entityKey: key,
      step: "create_provider",
      state: "confirmed",
      providerRef: "cmp-1",
      createdAt: "2026-07-01 08:00:00",
      updatedAt: "2026-07-02 09:30:00",
    });

    migrate(db);

    const row = db
      .prepare("SELECT * FROM formation_requests WHERE step = 'create_provider'")
      .get() as Record<string, string>;
    expect(row.created_at).toBe("2026-07-01 08:00:00");
    expect(row.updated_at).toBe("2026-07-02 09:30:00");
    // facts_updated_at is INITIALISED to updated_at, never to now.
    expect(row.facts_updated_at).toBe("2026-07-02 09:30:00");
  });

  test("an in-flight create REFUSES the migration, and the message names formation:abandon", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db, { key: "tenant-a:in-flight" });
    legacyParty(db, { partyId: "p1", entityKey: key });
    legacyStep(db, { entityKey: key, step: "create_provider", state: "submitted" });

    expect(() => migrate(db)).toThrow(/formation:abandon/);
    expect(() => migrate(db)).toThrow(/tenant-a:in-flight/);
    // Nothing was written: the refusal is BEFORE the transaction.
    expect((db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n).toBe(0);
  });

  test("a failed create with NO provider_ref also refuses — it re-sends the same key", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db);
    legacyStep(db, { entityKey: key, step: "create_provider", state: "failed" });
    expect(() => migrate(db)).toThrow(/still in flight/);
  });

  test("a failed create WITH a provider_ref migrates — the adopt path owns it", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db);
    legacyParty(db, { partyId: "p1", entityKey: key });
    legacyStep(db, {
      entityKey: key,
      step: "create_provider",
      state: "failed",
      providerRef: "cmp-9",
    });
    expect(() => migrate(db)).not.toThrow();
    expect(companyOf(db, key)).toBeDefined();
  });

  test("no migrated create_provider row is in a key-re-deriving state", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db);
    legacyStep(db, {
      entityKey: key,
      step: "create_provider",
      state: "confirmed",
      providerRef: "c",
    });
    const other = legacyEntity(db, { key: "tenant-a:agent-2" });
    legacyStep(db, { entityKey: other, step: "create_provider", state: "abandoned" });

    migrate(db);

    const live = db
      .prepare(
        "SELECT COUNT(*) AS n FROM formation_requests WHERE step='create_provider' AND state IN ('pending','submitted')",
      )
      .get() as { n: number };
    expect(live.n).toBe(0);
  });

  test("an UNOPENED entity gets a `ready` company — it stays fileable", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db);
    legacyParty(db, { partyId: "p1", entityKey: key });
    // No formation rows at all: the crash window between the claim and claimAllSteps.
    migrate(db);
    const company = companyOf(db, key);
    expect(company?.status).toBe("ready");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM formation_requests").get() as { n: number }).n,
    ).toBe(0);
  });

  test("an abandoned-with-provider_ref party survives, attached", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db);
    legacyParty(db, { partyId: "p1", entityKey: key });
    legacyStep(db, {
      entityKey: key,
      step: "create_provider",
      state: "abandoned",
      providerRef: "cmp-real",
    });

    migrate(db);

    const party = db.prepare("SELECT * FROM formation_parties WHERE party_id = 'p1'").get() as
      | Record<string, unknown>
      | undefined;
    expect(party?.deleted_at).toBeNull();
    expect(party?.legal_first_name).toBe("Ada");
    expect(party?.company_id).toBe(companyOf(db, key)?.company_id);
  });

  test("an entity with a bound party but NO pin still gets a company (the PII must stay attached)", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db, { provider: null, environment: null });
    legacyParty(db, { partyId: "p1", entityKey: key });
    migrate(db);
    const company = companyOf(db, key);
    expect(company).toBeDefined();
    // Pinned to sandbox so the environment check REFUSES rather than routing it somewhere.
    expect(company?.environment).toBe("sandbox");
  });

  test("an UNBOUND party keeps company_id NULL — it is still `never used`", () => {
    const db = openLegacyDb();
    legacyParty(db, { partyId: "loose", entityKey: null });
    migrate(db);
    const party = db.prepare("SELECT * FROM formation_parties WHERE party_id = 'loose'").get() as {
      company_id: string | null;
    };
    expect(party.company_id).toBeNull();
  });

  test("the migration is a no-op the second time (marker + shape guard)", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db);
    legacyParty(db, { partyId: "p1", entityKey: key });
    migrate(db);
    const first = companyOf(db, key)?.company_id;
    migrate(db);
    expect(companyOf(db, key)?.company_id).toBe(first);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n).toBe(1);
  });

  test("a corrupt spec blob falls back to the default purpose rather than failing the boot", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db, { specJson: "{not json" });
    legacyParty(db, { partyId: "p1", entityKey: key });
    migrate(db);
    expect(companyOf(db, key)?.business_purpose).toBe(DEFAULT_DESCRIPTION);
  });

  test("a fresh database gets the new shape, the marker, and both new tables", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const cols = (
      db.prepare("PRAGMA table_info(formation_requests)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("company_id");
    expect(cols).toContain("facts_updated_at");
    expect(cols).not.toContain("entity_key");
    expect(
      db.prepare("SELECT value FROM meta WHERE key LIKE 'formation_company_rekey%'").get(),
    ).toBeDefined();
    // formation_payments ships now and is written by B1; the live-rows index is the invariant.
    const idx = (
      db.prepare("PRAGMA index_list(formation_payments)").all() as { name: string }[]
    ).map((i) => i.name);
    expect(idx).toContain("idx_formation_payments_one_live");
  });

  test("the live-payment index admits a re-quote and a second product, but not two live rows", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label) VALUES ('c1','t','draft','doola','sandbox','[]','p','i')",
    ).run();
    const insert = (id: string, product: string, status: string) =>
      db
        .prepare(
          `INSERT INTO formation_payments (payment_id, company_id, product, status, amount_usdc, nonce, valid_before)
           VALUES (?, 'c1', ?, ?, '399000000', 'ff', 1)`,
        )
        .run(id, product, status);
    insert("p1", "formation", "quoted");
    expect(() => insert("p2", "formation", "settling")).toThrow(/UNIQUE/);
    // A terminal row frees the slot; a second product is independent.
    db.prepare("UPDATE formation_payments SET status='expired' WHERE payment_id='p1'").run();
    expect(() => insert("p3", "formation", "quoted")).not.toThrow();
    expect(() => insert("p4", "maintenance_year", "quoted")).not.toThrow();
  });

  test("a party is SINGLE-USE: two companies cannot claim the same row", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO formation_parties (party_id, tenant_id, legal_first_name) VALUES ('p1','t','Ada')",
    ).run();
    db.prepare(
      "INSERT INTO formation_parties (party_id, tenant_id, legal_first_name) VALUES ('p2','t','Bob')",
    ).run();
    db.prepare("UPDATE formation_parties SET company_id='c1' WHERE party_id='p1'").run();
    expect(() =>
      db.prepare("UPDATE formation_parties SET company_id='c1' WHERE party_id='p2'").run(),
    ).toThrow(/UNIQUE/);
    // …but any number of parties may stay unbound (SQLite NULLs are distinct in a UNIQUE index).
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM formation_parties WHERE company_id IS NULL")
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  // ── The three fixtures that are about what happens AFTER the boot (§2 step 5) ─────────────

  test("a party bound to a FILED company is not erasable, eight days later", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db, { filedAt: 1_756_000_000, filingNumber: "2026-1" });
    legacyParty(db, { partyId: "p1", entityKey: key, createdAt: "2026-08-01 00:00:00" });
    legacyStep(db, {
      entityKey: key,
      step: "create_provider",
      state: "confirmed",
      providerRef: "cmp-1",
    });
    legacyStep(db, { entityKey: key, step: "await_filing", state: "confirmed" });

    migrate(db);

    // Day 8 for an UNBOUND handle is the erasure cutoff. This one is bound to a real Wyoming
    // filing: erasing it would destroy the identity of a responsible party we are required to
    // hold and could not reconstruct. `listStaleUnbound` requires BOTH keys to be null, which is
    // what the backfill makes true — and the abandoned arm requires an abandoned create.
    const parties = new SqliteFormationPartyRepository(db);
    expect(parties.listErasable("2026-08-09 00:00:00")).toEqual([]);
    expect(parties.findOwned("tenant-a", "p1")?.legalFirstName).toBe("Ada");
  });

  test("a migrated entity's legal block is byte-identical — no fleet-wide re-anchor", () => {
    const db = openLegacyDb();
    const key = legacyEntity(db, {
      filedAt: 1_756_000_000,
      filingNumber: "2026-123456",
      einReal: "88-1234567",
    });
    legacyParty(db, { partyId: "p1", entityKey: key });
    for (const step of ["create_provider", "await_filing", "fetch_documents", "await_ein"])
      legacyStep(db, { entityKey: key, step, state: "confirmed", providerRef: "cmp-1" });
    legacyDocument(db, {
      id: "doc-a",
      entityKey: key,
      docType: "ArticlesOfOrganization",
      providerDocId: "d1",
    });

    migrate(db);

    const companies = new SqliteCompanyRepository(db);
    const company = companies.find(
      (
        db.prepare("SELECT company_id AS c FROM entities WHERE idempotency_key = ?").get(key) as {
          c: string;
        }
      ).c,
    )!;
    // The facts MOVED, unchanged: the block the anchor loop builds next carries exactly what the
    // entity columns held, so `sameLegal` short-circuits and no new version is opened.
    const entity = db.prepare("SELECT * FROM entities WHERE idempotency_key = ?").get(key) as {
      formation_filed_at: number;
      formation_filing_number: string;
      ein_real: string;
    };
    expect(company.filedAt).toBe(entity.formation_filed_at);
    expect(company.filingNumber).toBe(entity.formation_filing_number);
    expect(company.ein).toBe(entity.ein_real);
    // …and the ONE field that could have changed the bytes is absent. `normalizeLegal` emits
    // `companyName` only for a non-empty filed name, and no migrated company has one.
    expect(company.legalNameFiled).toBeNull();
    // The document keeps its index id and its path: the manifest commits to those bytes.
    const doc = db.prepare("SELECT * FROM documents WHERE id = 'doc-a'").get() as {
      path: string;
      sha256: string;
    };
    expect(doc.path).toBe("doc-doc-a.pdf");
    expect(doc.sha256).toBe("sha-d1");
  });

  test("the anchor due-set is the SAME set before and after the migration", () => {
    const db = openLegacyDb();
    // One entity whose facts moved since its last anchor write (due), and one that is settled.
    const due = legacyEntity(db, { key: "tenant-a:due" });
    const settled = legacyEntity(db, { key: "tenant-a:settled" });
    for (const k of [due, settled]) {
      legacyParty(db, { partyId: `p-${k}`, entityKey: k });
      legacyStep(db, { entityKey: k, step: "create_provider", state: "confirmed", providerRef: k });
      legacyStep(db, {
        entityKey: k,
        step: "await_filing",
        state: "confirmed",
        updatedAt: "2026-08-02 11:22:33",
      });
    }
    // The settled one already anchored AFTER its facts moved.
    db.prepare(
      `INSERT INTO oa_anchors (entity_key, version, manifest_hash, state, updated_at)
       VALUES (?, 2, '0xaa', 'executed', '2026-08-03 00:00:00')`,
    ).run(settled);

    // The PRE-migration query, written out against the legacy schema — the only honest way to
    // compare a set across a schema change is to ask the old shape the old question.
    const before = (
      db
        .prepare(
          `SELECT k FROM (
             SELECT DISTINCT entity_key AS k FROM oa_anchors
              WHERE state IN ('pending','scheduled','vetoed','failed')
             UNION
             SELECT f.entity_key AS k
               FROM formation_requests f
               LEFT JOIN (SELECT entity_key, MAX(updated_at) AS last
                            FROM oa_anchors GROUP BY entity_key) a
                 ON a.entity_key = f.entity_key
              WHERE f.state = 'confirmed'
                AND (a.last IS NULL OR f.updated_at >= a.last)
           ) ORDER BY k LIMIT 50`,
        )
        .all() as { k: string }[]
    ).map((r) => r.k);
    expect(before).toEqual([due]);

    migrate(db);

    expect(new SqliteOaAnchorRepository(db).listDueEntityKeys(50)).toEqual(before);
  });
});
