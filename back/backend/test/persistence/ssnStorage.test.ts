/**
 * The SSN's life in the DATABASE (design 2026-08-26 §4) — write-once, company-keyed, erasable on
 * its own, and visible to the TTL clock with everything that clock needs to judge it.
 *
 * The intake-freeze CAS lives here too, because it is a property of the ROW: three doors can
 * reach a company, and only one predicate may decide whether its intake is still editable.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { companyNameOptions } from "../../src/formation/intake";
import { encryptSsn, parsePiiKey } from "../../src/formation/pii";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";

const TENANT = "0x000000000000000000000000000000000000000A";
const SSN = "123-45-6789";
const RING = { current: parsePiiKey(Buffer.alloc(32, 1).toString("base64"), "FORMATION_PII_KEY") };

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
});
afterEach(() => db.close());

/** A bound (party, company) pair — the shape every SSN operation is keyed by. */
function bound(): { partyId: string; companyId: string } {
  const partyId = parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
  const companyId = companies.create({
    tenantId: TENANT,
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions("Acme One", "Acme Two", "Acme Three"),
    businessPurpose: "Building agents.",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
  expect(parties.bindToCompany(partyId, companyId, TENANT)).toBe(true);
  return { partyId, companyId };
}

function reasonOf(partyId: string): string | null {
  return (
    db.prepare("SELECT ssn_erased_reason FROM formation_parties WHERE party_id = ?").get(partyId) as
      | { ssn_erased_reason: string | null }
      | undefined
  )?.ssn_erased_reason as string | null;
}

function store(b: { partyId: string; companyId: string }): boolean {
  return parties.storeSsn(b.partyId, b.companyId, encryptSsn(RING, SSN, b));
}

// ── store / read / erase ───────────────────────────────────────────────────────────────────

test("an SSN is stored against the bound pair and reads back decryptable", () => {
  const b = bound();
  expect(store(b)).toBe(true);
  const found = parties.findSsnByCompanyId(b.companyId)!;
  expect(found.partyId).toBe(b.partyId);
  expect(found.keyId).toBe(RING.current.id);
  expect(found.iv).toHaveLength(12);
  // The columns hold BYTES, not text: a TEXT column would have mangled the ciphertext on the way
  // through SQLite's encoding.
  expect(Buffer.isBuffer(found.ciphertext)).toBe(true);
});

test("the write is keyed by the PAIR: a wrong company or party writes nothing", () => {
  const a = bound();
  const other = bound();
  expect(parties.storeSsn(a.partyId, other.companyId, encryptSsn(RING, SSN, a))).toBe(false);
  expect(parties.storeSsn(other.partyId, a.companyId, encryptSsn(RING, SSN, a))).toBe(false);
  expect(parties.findSsnByCompanyId(a.companyId)).toBeUndefined();
});

test("WRITE-ONCE while one exists — a second SSN under a live key is refused", () => {
  // A second SSN would change the create body under an idempotency key doola may already be
  // holding (§4.4/§4.5).
  const b = bound();
  expect(store(b)).toBe(true);
  expect(store(b)).toBe(false);
});

test("eraseSsn NULLs the three columns, stamps the date, records WHY, and leaves the party intact", () => {
  const b = bound();
  store(b);
  expect(parties.eraseSsn(b.companyId, "provider_persisted")).toBe(true);
  expect(parties.findSsnByCompanyId(b.companyId)).toBeUndefined();

  const row = db
    .prepare("SELECT * FROM formation_parties WHERE party_id = ?")
    .get(b.partyId) as Record<string, unknown>;
  expect([row.ssn_ciphertext, row.ssn_iv, row.ssn_key_id]).toEqual([null, null, null]);
  expect(row.ssn_deleted_at).toBeTruthy();
  // The record is the only thing that survives the value, so it is written by the SAME statement.
  expect(row.ssn_erased_reason).toBe("provider_persisted");
  // The SSN dies at `provider_ref`; the party lives for as long as the filing does.
  expect(row.deleted_at).toBeNull();
  expect(row.legal_first_name).toBe("Ada");
  expect(parties.findOwned(TENANT, b.partyId)).toBeDefined();
});

test("eraseSsn is idempotent — every backstop pass after the first says false", () => {
  const b = bound();
  store(b);
  expect(parties.eraseSsn(b.companyId, "ttl")).toBe(true);
  expect(parties.eraseSsn(b.companyId, "ttl")).toBe(false);
  expect(parties.eraseSsn("no-such-company", "ttl")).toBe(false);
});

test("a RE-CAPTURE after an erasure clears the deletion stamp", () => {
  // The §4.7 edit-and-retry path. A live ciphertext sitting under an "erased on" stamp would be
  // a lie in the audit trail.
  const b = bound();
  store(b);
  expect(parties.eraseSsn(b.companyId, "intake_reopened")).toBe(true);
  expect(reasonOf(b.partyId)).toBe("intake_reopened");
  expect(store(b)).toBe(true);
  const row = db
    .prepare("SELECT ssn_deleted_at FROM formation_parties WHERE party_id = ?")
    .get(b.partyId) as { ssn_deleted_at: string | null };
  expect(row.ssn_deleted_at).toBeNull();
});

test("the party ERASE still takes the SSN with it, in one statement", () => {
  // A1 already wrote this; it is asserted here now that there is a real ciphertext to destroy.
  const b = bound();
  store(b);
  expect(parties.erase(b.partyId)).toBe(true);
  expect(parties.findSsnByCompanyId(b.companyId)).toBeUndefined();
  const row = db
    .prepare("SELECT * FROM formation_parties WHERE party_id = ?")
    .get(b.partyId) as Record<string, unknown>;
  expect(row.ssn_ciphertext).toBeNull();
  expect(row.ssn_deleted_at).toBeTruthy();
  expect(row.legal_first_name).toBeNull();
});

// ── the TTL clock's view (§4.6a) ───────────────────────────────────────────────────────────

test("listSsnRetention returns only rows that still HOLD an SSN, with the capture time", () => {
  const held = bound();
  store(held);
  const erased = bound();
  store(erased);
  parties.eraseSsn(erased.companyId, "terminal");
  bound(); // never had one

  const rows = parties.listSsnRetention();
  expect(rows.map((r) => r.companyId)).toEqual([held.companyId]);
  // The COMPANY's created_at is the SSN's capture time: the two happen in one transaction.
  expect(rows[0]!.capturedAt).toBe(companies.find(held.companyId)!.createdAt);
  expect(rows[0]!.companyStatus).toBe("ready");
  // No create_provider row at all is a legitimate shape — the filing has not been opened.
  expect(rows[0]!.createState).toBeNull();
  expect(rows[0]!.everSubmitted).toBe(false);
});

test("everSubmitted is TRUE for every witness of a filing in flight, not just the state", () => {
  const cases: { label: string; apply: (companyId: string) => void; want: boolean }[] = [
    { label: "untouched", apply: () => {}, want: false },
    {
      label: "opened but pending",
      apply: (c) => requests.claimStep(c, "create_provider"),
      want: false,
    },
    {
      label: "currently submitted",
      apply: (c) => {
        requests.claimStep(c, "create_provider");
        requests.transition(c, "create_provider", "pending", "submitted", {});
      },
      want: true,
    },
    {
      // The case the STATE alone cannot see: submitted, then failed, and the state has forgotten.
      label: "failed after a send",
      apply: (c) => {
        requests.claimStep(c, "create_provider");
        requests.transition(c, "create_provider", "pending", "submitted", {
          detail: JSON.stringify({ companySentAttempt: 0 }),
        });
        requests.transition(c, "create_provider", "submitted", "failed", { error: "boom" });
      },
      want: true,
    },
    {
      label: "failed after a customer create only",
      apply: (c) => {
        requests.claimStep(c, "create_provider");
        requests.transition(c, "create_provider", "pending", "failed", {
          detail: JSON.stringify({ customerId: "cus_1" }),
        });
      },
      want: true,
    },
    {
      label: "a provider_ref exists",
      apply: (c) => {
        requests.claimStep(c, "create_provider");
        requests.transition(c, "create_provider", "pending", "failed", { providerRef: "cmp_1" });
      },
      want: true,
    },
    {
      // An unreadable blob is not evidence that nothing happened.
      label: "corrupt detail",
      apply: (c) => {
        requests.claimStep(c, "create_provider");
        db.prepare(
          "UPDATE formation_requests SET detail = '{not json' WHERE company_id = ? AND step = 'create_provider'",
        ).run(c);
      },
      want: true,
    },
  ];

  for (const { label, apply, want } of cases) {
    const b = bound();
    store(b);
    apply(b.companyId);
    const row = parties.listSsnRetention().find((r) => r.companyId === b.companyId)!;
    expect(row.everSubmitted, label).toBe(want);
    parties.eraseSsn(b.companyId, "terminal"); // keep the next case's listing clean
  }
});

// ── intake immutability (§4.7) ─────────────────────────────────────────────────────────────

test("intake is editable while no create has gone out under the CURRENT attempt", () => {
  const b = bound();
  const edit = {
    nameOptions: companyNameOptions("New One", "New Two", "New Three"),
    businessPurpose: "Something else.",
    industryLabel: "Software development",
  };
  // No formation row at all.
  expect(companies.updateIntake(b.companyId, edit)).toBe(true);
  expect(companies.find(b.companyId)!.businessPurpose).toBe("Something else.");
  // A human typed it, so the synthesized marker comes off.
  expect(companies.find(b.companyId)!.intakeSynthesized).toBe(false);

  // Opened, still `pending`: nothing has been sent.
  requests.claimStep(b.companyId, "create_provider");
  expect(companies.updateIntake(b.companyId, edit)).toBe(true);
});

test("the REJECTED shape is editable: the attempt burned, so the key is fresh", () => {
  // `rejected` is the ONLY failure that burns an attempt (C1), which is exactly what leaves
  // `companySentAttempt` BEHIND the current attempt — the design's rule, in our vocabulary.
  const b = bound();
  requests.claimStep(b.companyId, "create_provider");
  requests.transition(b.companyId, "create_provider", "pending", "submitted", {
    detail: JSON.stringify({ companySentAttempt: 0 }),
  });
  requests.bumpAttempt(b.companyId, "create_provider", "submitted"); // attempt -> 1, pending
  requests.transition(b.companyId, "create_provider", "pending", "failed", { error: "rejected" });

  expect(
    companies.updateIntake(b.companyId, {
      nameOptions: companyNameOptions("Fixed One", "Fixed Two", "Fixed Three"),
      businessPurpose: "Corrected.",
      industryLabel: "Software development",
    }),
  ).toBe(true);
});

test("the LOST / KEY_REUSED shape is FROZEN: the same key will be re-sent with the same body", () => {
  // These park WITHOUT burning the attempt, deliberately (C1) — so doola may be holding a body
  // under the key the next pass will use, and a new body under it is a 409.
  const b = bound();
  requests.claimStep(b.companyId, "create_provider");
  requests.transition(b.companyId, "create_provider", "pending", "submitted", {
    detail: JSON.stringify({ companySentAttempt: 0 }),
  });
  requests.transition(b.companyId, "create_provider", "submitted", "failed", { error: "lost" });

  expect(
    companies.updateIntake(b.companyId, {
      nameOptions: companyNameOptions("Nope"),
      businessPurpose: "x",
      industryLabel: "Software development",
    }),
  ).toBe(false);
  expect(companies.find(b.companyId)!.businessPurpose).toBe("Building agents.");
});

test("a filed, in-flight or abandoned company is FROZEN, whatever the detail says", () => {
  const edit = {
    nameOptions: companyNameOptions("Nope"),
    businessPurpose: "x",
    industryLabel: "Software development",
  };

  const filed = bound();
  requests.claimStep(filed.companyId, "create_provider");
  requests.transition(filed.companyId, "create_provider", "pending", "confirmed", {
    providerRef: "cmp_1",
  });
  expect(companies.updateIntake(filed.companyId, edit)).toBe(false);

  const inFlight = bound();
  requests.claimStep(inFlight.companyId, "create_provider");
  requests.transition(inFlight.companyId, "create_provider", "pending", "submitted", {});
  expect(companies.updateIntake(inFlight.companyId, edit)).toBe(false);

  // A `provider_ref` alone freezes it even from a non-terminal state: a company exists at doola.
  const withRef = bound();
  requests.claimStep(withRef.companyId, "create_provider");
  requests.transition(withRef.companyId, "create_provider", "pending", "failed", {
    providerRef: "cmp_2",
  });
  expect(companies.updateIntake(withRef.companyId, edit)).toBe(false);

  const abandonedCompany = bound();
  expect(companies.setStatus(abandonedCompany.companyId, "ready", "abandoned")).toBe(true);
  expect(companies.updateIntake(abandonedCompany.companyId, edit)).toBe(false);
});
