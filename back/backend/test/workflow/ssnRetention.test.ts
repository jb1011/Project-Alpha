/**
 * THE SHORT CLOCK — SSN retention in the sweeper (design 2026-08-26 §4.6a).
 *
 * The clause is short and every word of it is load-bearing, so each gets its own case:
 *
 *  - erase when the company is TERMINAL, or when the SSN is older than 7 days AND the filing was
 *    never in flight;
 *  - at day 7 with no `provider_ref`, raise `formation_stale` and KEEP the intake. A NULL
 *    `provider_ref` is not proof no company exists at doola — the adopt path exists for exactly
 *    that case, and an erased party makes adoption unrecoverable;
 *  - nothing here manufactures `abandoned` from a clock;
 *  - PARTY erasure (C7's two disjoint arms) is a different clock over a different fact, and is
 *    untouched.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { encryptSsn, parsePiiKey } from "../../src/formation/pii";
import { SSN_MAX_AGE_MS } from "../../src/formation/schedule";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import { FormationSweeper } from "../../src/workflow/formationSweeper";

const TENANT = "0x000000000000000000000000000000000000000A";
const SSN = "123-45-6789";
const RING = { current: parsePiiKey(Buffer.alloc(32, 3).toString("base64"), "FORMATION_PII_KEY") };
const NOW = Date.parse("2026-08-31T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let repo: SqliteEntityRepository;
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  repo = new SqliteEntityRepository(db);
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    printed.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/**
 * A company holding an SSN, captured `ageMs` ago.
 *
 * Both clocks are backdated together, because the ordinary case is that they agree: the SSN rides
 * the same request that mints the company. `ssn_captured_at` is the one the sweeper reads, and
 * `recaptured` below is the case where they DISAGREE.
 */
function holding(ageMs: number): { partyId: string; companyId: string } {
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
    nameOptions: [{ name: "Acme", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "p",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
  db.prepare("UPDATE companies SET created_at = ? WHERE company_id = ?").run(
    sqliteUtcTimestamp(NOW - ageMs),
    companyId,
  );
  parties.bindToCompany(partyId, companyId, TENANT);
  parties.storeSsn(partyId, companyId, encryptSsn(RING, SSN, { partyId, companyId }));
  db.prepare("UPDATE formation_parties SET ssn_captured_at = ? WHERE party_id = ?").run(
    sqliteUtcTimestamp(NOW - ageMs),
    partyId,
  );
  return { partyId, companyId };
}

/** A sweeper with only the wiring this leg touches — no doola, no anchors, no timer. */
function sweeper(): FormationSweeper {
  return new FormationSweeper({
    repo,
    companies,
    parties,
    requests,
    events: { listUnprocessed: () => [], markProcessed: () => {}, deleteOlderThan: () => 0 },
    documents: {} as never,
    docStore: {} as never,
    doola: {} as never,
    environment: "production",
    pii: RING,
    intervalMs: 60_000,
    now: () => NOW,
  } as never);
}

const held = (companyId: string) => parties.findSsnByCompanyId(companyId) !== undefined;
const capturedAtOn = (partyId: string) =>
  (
    db.prepare("SELECT ssn_captured_at FROM formation_parties WHERE party_id = ?").get(partyId) as {
      ssn_captured_at: string | null;
    }
  ).ssn_captured_at;
const reasonOn = (companyId: string) =>
  (
    db
      .prepare("SELECT ssn_erased_reason FROM formation_parties WHERE company_id = ?")
      .get(companyId) as { ssn_erased_reason: string | null }
  ).ssn_erased_reason;
const opsLines = () => printed.filter((l) => l.includes('"opslog"')).map((l) => JSON.parse(l));

// ── erase: terminal ────────────────────────────────────────────────────────────────────────

test("a company whose create is CONFIRMED has its SSN erased — the idempotent backstop", async () => {
  // §4.4 already erased it in the transaction that persisted `provider_ref`. This catches a row
  // that somehow missed that, and is a backstop rather than a TTL: no clock is consulted.
  const { companyId } = holding(0);
  requests.claimStep(companyId, "create_provider");
  requests.transition(companyId, "create_provider", "pending", "confirmed", {
    providerRef: "cmp_1",
  });
  await sweeper().tick();
  expect(held(companyId)).toBe(false);
  expect(opsLines().find((l) => l.opslog === "formation_ssn_erased")).toMatchObject({
    companyId,
    reason: "terminal",
  });
});

test("an ABANDONED company, by either writer, has its SSN erased", async () => {
  for (const abandon of [
    (c: string) => companies.setStatus(c, "ready", "abandoned"),
    (c: string) => {
      requests.claimStep(c, "create_provider");
      requests.transition(c, "create_provider", "pending", "abandoned", {});
    },
  ]) {
    const { companyId } = holding(0);
    abandon(companyId);
    await sweeper().tick();
    expect(held(companyId)).toBe(false);
  }
});

// ── erase: the TTL ─────────────────────────────────────────────────────────────────────────

test("an SSN older than 7 days whose filing NEVER started is erased", async () => {
  const { companyId } = holding(SSN_MAX_AGE_MS + DAY);
  await sweeper().tick();
  expect(held(companyId)).toBe(false);
  expect(opsLines().find((l) => l.opslog === "formation_ssn_erased")).toMatchObject({
    companyId,
    reason: "ttl",
  });
  // …and the reason is on the ROW too, not only in journald: the filer reads it back (§4.6a).
  expect(reasonOn(companyId)).toBe("ttl");
  // The company itself is UNTOUCHED — no clock manufactures `abandoned` (§4.6a).
  expect(companies.find(companyId)!.status).toBe("ready");
});

test("a RE-CAPTURED SSN starts a FRESH clock — the company's age is not the SSN's age", async () => {
  // The bug this pins: the clock used to read `companies.created_at`, which is the moment the
  // company was minted and NOT the moment the number was supplied. §4.7's edit-and-retry captures
  // a new SSN onto a company that may be a week old, so the very next sweep — minutes later —
  // erased a number the caller had just been asked for and believed was in flight.
  const { partyId, companyId } = holding(SSN_MAX_AGE_MS + DAY);
  const wasCapturedAt = capturedAtOn(partyId);
  // The re-capture: erase, then store, exactly as `updateCompanyIntake` does it.
  parties.eraseSsn(companyId, "intake_reopened");
  parties.storeSsn(partyId, companyId, encryptSsn(RING, SSN, { partyId, companyId }));
  // `storeSsn` re-stamped the clock — that is the whole mechanism.
  expect(capturedAtOn(partyId)).not.toBe(wasCapturedAt);
  // Pinned to the sweeper's clock rather than the wall clock, so the assertion below is about
  // the RULE and not about what today's date happens to be.
  db.prepare("UPDATE formation_parties SET ssn_captured_at = ? WHERE party_id = ?").run(
    sqliteUtcTimestamp(NOW - DAY),
    partyId,
  );

  await sweeper().tick();

  expect(held(companyId)).toBe(true);
  // The company is still eight days old; only the SSN is new.
  expect(
    (
      db.prepare("SELECT created_at FROM companies WHERE company_id = ?").get(companyId) as {
        created_at: string;
      }
    ).created_at,
  ).toBe(sqliteUtcTimestamp(NOW - (SSN_MAX_AGE_MS + DAY)));
});

test("a YOUNG SSN is kept, however open the filing is", async () => {
  const { companyId } = holding(DAY);
  await sweeper().tick();
  expect(held(companyId)).toBe(true);
});

test("an SSN past 7 days whose filing IS in flight is KEPT — erasing it would wedge the retry", async () => {
  // The safety property behind §4.5: a live idempotency key is bound to a body that carried the
  // SSN, and a retry that cannot rebuild it parks for a human. So the clock yields to the filing.
  for (const inFlight of [
    (c: string) => {
      requests.claimStep(c, "create_provider");
      requests.transition(c, "create_provider", "pending", "submitted", {});
    },
    // …and the case the STATE alone cannot see: sent, then failed, and the state has forgotten.
    (c: string) => {
      requests.claimStep(c, "create_provider");
      requests.transition(c, "create_provider", "pending", "failed", {
        detail: JSON.stringify({ companySentAttempt: 0 }),
        error: "lost",
      });
    },
  ]) {
    const { companyId } = holding(SSN_MAX_AGE_MS + DAY);
    inFlight(companyId);
    await sweeper().tick();
    expect(held(companyId)).toBe(true);
  }
});

// ── the stale alarm ────────────────────────────────────────────────────────────────────────

test("day 7 with a filing in flight and NO provider_ref raises formation_stale and KEEPS everything", async () => {
  const { companyId, partyId } = holding(SSN_MAX_AGE_MS + DAY);
  requests.claimStep(companyId, "create_provider");
  requests.transition(companyId, "create_provider", "pending", "failed", {
    detail: JSON.stringify({ customerId: "cus_1" }),
    error: "lost",
  });
  // An attached agent, so the guardian-visible half has somewhere to land.
  db.prepare(
    `INSERT INTO entities (idempotency_key, name, status, manager, guardian, amendment_delay,
                           ein, formation_date, company_id)
     VALUES ('e1','e1','bound','0x1','0x2','86400','STUB',0,?)`,
  ).run(companyId);

  await sweeper().tick();

  const stale = opsLines().find((l) => l.opslog === "formation_stale");
  expect(stale).toMatchObject({
    companyId,
    severity: "CRITICAL",
    level: "error",
    reason: "ssn_ttl_no_provider_ref",
  });
  // NOTHING was destroyed and NOTHING was abandoned: a NULL provider_ref is not proof no company
  // exists at doola, and an erased party makes the adopt path unrecoverable.
  expect(held(companyId)).toBe(true);
  expect(companies.find(companyId)!.status).toBe("ready");
  expect(parties.findOwned(TENANT, partyId)).toBeDefined();
  // …and the owner is told, where the UI already renders it.
  const events = repo.listEvents("e1").map((e) => e.step);
  expect(events).toContain("formationStale");
});

test("the stale alarm is once a day, not once a tick", async () => {
  const { companyId } = holding(SSN_MAX_AGE_MS + DAY);
  requests.claimStep(companyId, "create_provider");
  requests.transition(companyId, "create_provider", "pending", "failed", {
    detail: JSON.stringify({ customerId: "cus_1" }),
    error: "lost",
  });
  const s = sweeper();
  await s.tick();
  await s.tick();
  await s.tick();
  expect(opsLines().filter((l) => l.opslog === "formation_stale")).toHaveLength(1);
  expect(companyId).toBeTruthy();
});

// ── the other clock is untouched ───────────────────────────────────────────────────────────

test("PARTY erasure is a different clock over a different fact, and still is", async () => {
  // C7's two disjoint arms. An SSN erased at day 7 must not drag the identity with it: the party
  // of a real filing is data we are required to hold.
  const { companyId, partyId } = holding(SSN_MAX_AGE_MS + DAY);
  await sweeper().tick();
  expect(held(companyId)).toBe(false);
  const row = parties.findOwned(TENANT, partyId)!;
  expect(row.legalFirstName).toBe("Ada");
  expect(row.deletedAt).toBeNull();
});
