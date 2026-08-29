import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { DEFAULT_DESCRIPTION, DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { migrate, openDatabase } from "../../src/persistence/db";
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
});
