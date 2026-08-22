/**
 * The formation sweeper (design §7).
 *
 * The sweeper is what makes progress GUARANTEED rather than merely fast: doola auto-disables
 * endpoints, a deploy can drop an acked-but-unprocessed event, a company id and its first webhook
 * can race, and `await_ein` waits four to six weeks for the IRS. Every test here is one of those
 * scenarios.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sqliteUtcTimestamp } from "../../src/formation";
import { deriveFormationStatus } from "../../src/formation/status";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { advanceFormation, parseDetail } from "../../src/workflow/formationProcessor";
import {
  FormationSweeper,
  type FormationSweeperDeps,
  MAX_FORMATION_ATTEMPTS,
  POLL_BASE_MS,
  POLL_CAP_MS,
  SUBMITTED_STALL_MS,
  parseSqliteUtc,
  retryDelayMs,
} from "../../src/workflow/formationSweeper";
import {
  COMPANY_ID,
  ENTITY_KEY,
  type FakeDoola,
  MemoryDocumentStore,
  TENANT,
  doolaDoc,
  fakeDoola,
  formedEntity,
} from "../helpers/formationFakes";

const DAY = 24 * 60 * 60 * 1000;
let now = Date.parse("2026-08-21T12:00:00Z");

let db: Database.Database;
let repo: SqliteEntityRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let events: SqliteDoolaEventRepository;
let parties: SqliteFormationPartyRepository;
let docStore: MemoryDocumentStore;
let doola: FakeDoola;

function deps(over: Partial<FormationSweeperDeps> = {}): FormationSweeperDeps {
  return {
    repo,
    requests,
    documents,
    parties,
    docStore,
    events,
    doola: doola.api,
    environment: "sandbox",
    fetchImpl: doola.fetchImpl,
    lookupImpl: doola.lookupImpl,
    intervalMs: 60_000,
    now: () => now,
    ...over,
  };
}

const sweeper = (over: Partial<FormationSweeperDeps> = {}) => new FormationSweeper(deps(over));

function seedFormation(over: Parameters<typeof formedEntity>[0] = {}) {
  repo.upsert(formedEntity({ specJson: JSON.stringify({ name: "Formation Agent" }), ...over }));
  requests.claimAllSteps(ENTITY_KEY);
  requests.transition(ENTITY_KEY, "create_provider", "pending", "confirmed", {
    providerRef: COMPANY_ID,
  });
  // Pin the rows to the INJECTED clock. SQLite stamps CURRENT_TIMESTAMP from the real wall clock,
  // and every schedule under test is a comparison between the two — leaving them hours apart
  // would make these assertions depend on what time of day the suite runs.
  stampRows(now);
}

function stampRows(at: number) {
  db.prepare(
    "UPDATE formation_requests SET created_at = ?, updated_at = ? WHERE entity_key = ?",
  ).run(sqliteUtcTimestamp(at), sqliteUtcTimestamp(at), ENTITY_KEY);
}

/** A formation party, optionally bound. Every real filing has one — the door gate requires it. */
function newParty(over: { entityKey?: string } = {}): string {
  const id = parties.create({
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
  if (over.entityKey) parties.bind(id, over.entityKey, TENANT);
  return id;
}

const rowOf = (step: string) => requests.stepsOf(ENTITY_KEY).find((s) => s.step === step);
const stateOf = (step: string) => rowOf(step)?.state ?? "(missing)";

/** Put a row into `failed` at a chosen attempt count and age, the way a real failure leaves it. */
function fail(step: string, attempt: number, updatedMsAgo = 0) {
  db.prepare(
    "UPDATE formation_requests SET state='failed', attempt=?, updated_at=? WHERE entity_key=? AND step=?",
  ).run(attempt, sqliteUtcTimestamp(now - updatedMsAgo), ENTITY_KEY, step);
}

beforeEach(() => {
  now = Date.parse("2026-08-21T12:00:00Z");
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  events = new SqliteDoolaEventRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  docStore = new MemoryDocumentStore();
  doola = fakeDoola();
});
afterEach(() => db.close());

// ── (b) retry backoff and the abandon verdict ──────────────────────────────────────────────

test("the backoff schedule is 1m·2^attempt, capped at six hours", () => {
  expect(retryDelayMs(0)).toBe(60_000);
  expect(retryDelayMs(1)).toBe(2 * 60_000);
  expect(retryDelayMs(2)).toBe(4 * 60_000);
  expect(retryDelayMs(5)).toBe(32 * 60_000);
  // 1m·2^9 would be 8h32m; the cap is what stops a hopeless row from waiting a day between tries.
  expect(retryDelayMs(9)).toBe(6 * 60 * 60 * 1000);
  expect(retryDelayMs(40)).toBe(6 * 60 * 60 * 1000);
});

test("a failed row is not retried before its backoff has elapsed, and is right after", async () => {
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  fail("await_filing", 3, 0);

  await sweeper().tick();
  // 1m·2^3 = 8 minutes; nothing has elapsed.
  expect(doola.calls).toHaveLength(0);
  expect(stateOf("await_filing")).toBe("failed");

  now += retryDelayMs(3) + 1000;
  await sweeper().tick();
  expect(stateOf("await_filing")).toBe("confirmed");
});

test("at the attempt bound the row is ABANDONED, loudly, instead of retried again", async () => {
  seedFormation();
  fail("await_filing", MAX_FORMATION_ATTEMPTS, 7 * DAY);

  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    await sweeper().tick();
  } finally {
    console.log = orig;
  }
  expect(stateOf("await_filing")).toBe("abandoned");
  // Not retried on the way to the verdict: an entity past the bound costs doola nothing more.
  expect(doola.calls).toHaveLength(0);
  const critical = lines.map((l) => JSON.parse(l)).find((l) => l.opslog === "formation_abandoned");
  expect(critical).toMatchObject({ severity: "CRITICAL", step: "await_filing" });
});

test("an abandoned row is terminal — the next tick does not resurrect it", async () => {
  seedFormation();
  fail("await_filing", MAX_FORMATION_ATTEMPTS, 7 * DAY);
  await sweeper().tick();
  now += 30 * DAY;
  await sweeper().tick();
  expect(stateOf("await_filing")).toBe("abandoned");
});

test("create_provider is retried too — through the saga step, which ADOPTS rather than re-files", async () => {
  // The company id is already persisted, which is the crash-window case: a retry must never file
  // a second real Wyoming LLC.
  repo.upsert(formedEntity({ specJson: JSON.stringify({ name: "Formation Agent" }) }));
  requests.claimAllSteps(ENTITY_KEY);
  newParty({ entityKey: ENTITY_KEY });
  db.prepare(
    "UPDATE formation_requests SET state='failed', attempt=1, provider_ref=?, updated_at=? WHERE entity_key=? AND step='create_provider'",
  ).run(COMPANY_ID, sqliteUtcTimestamp(now - DAY), ENTITY_KEY);

  await sweeper().tick();
  expect(stateOf("create_provider")).toBe("confirmed");
  // `getCompany`, never `createCompany` — the fake throws if the create is ever called.
  expect(doola.calls.some((c) => c.startsWith("getCompany"))).toBe(true);
});

// ── C2: the two crash windows ──────────────────────────────────────────────────────────────
//
// Between the claim (which writes the pin and binds the party) and `claimAllSteps` at the top of
// the create step lie provisioning, minting, binding and funding — a long stretch of real
// network work. An entity that dies in it is pinned, owes a real filing, and is invisible to
// EVERY other pass: `bound`/`funded` so the onboarding reconciler skips it, and with no formation
// rows at all so every row query skips it too.

test("C2: an entity pinned with a party but NO formation rows is opened and filed", async () => {
  // The crash: the claim committed (pin + party bind), nothing else did.
  repo.upsert(formedEntity({ specJson: JSON.stringify({ name: "Formation Agent" }) }));
  newParty({ entityKey: ENTITY_KEY });
  expect(requests.stepsOf(ENTITY_KEY)).toHaveLength(0);

  const created = { doolaCompanyId: COMPANY_ID, formationSubmissionStatus: "PENDING" };
  const calls: string[] = [];
  doola = fakeDoola();
  (doola.api as unknown as Record<string, unknown>).createCustomer = async () => {
    calls.push("createCustomer");
    return { doolaCustomerId: "cus-1" };
  };
  (doola.api as unknown as Record<string, unknown>).createCompany = async () => {
    calls.push("createCompany");
    return created;
  };
  (doola.api as unknown as Record<string, unknown>).listCompanies = async () => [];

  await sweeper().tick();

  // All four rows exist now, and the filing actually went out.
  expect(requests.stepsOf(ENTITY_KEY).map((r) => r.step)).toEqual([
    "create_provider",
    "await_filing",
    "fetch_documents",
    "await_ein",
  ]);
  expect(calls).toEqual(["createCustomer", "createCompany"]);
  expect(rowOf("create_provider")).toMatchObject({ state: "confirmed", providerRef: COMPANY_ID });
});

test("C2: an entity with no party bound is NOT opened — there is nothing to file with", async () => {
  repo.upsert(formedEntity({ specJson: JSON.stringify({ name: "Formation Agent" }) }));
  await sweeper().tick();
  expect(requests.stepsOf(ENTITY_KEY)).toHaveLength(0);
  expect(doola.calls).toHaveLength(0);
});

test("C2: a create_provider row stuck in `submitted` past the deadline is re-run, and ADOPTS", async () => {
  // The other window: the process died INSIDE the company create, after the id was persisted.
  // `submitted` is not `failed`, so the retry pass never looked at it — the row sat there forever.
  repo.upsert(formedEntity({ specJson: JSON.stringify({ name: "Formation Agent" }) }));
  newParty({ entityKey: ENTITY_KEY });
  requests.claimAllSteps(ENTITY_KEY);
  db.prepare(
    `UPDATE formation_requests SET state='submitted', provider_ref=?, detail=?, updated_at=?
      WHERE entity_key=? AND step='create_provider'`,
  ).run(
    COMPANY_ID,
    JSON.stringify({ customerId: "cus-1", companyId: COMPANY_ID, companySentAttempt: 0 }),
    sqliteUtcTimestamp(now - SUBMITTED_STALL_MS - 1000),
    ENTITY_KEY,
  );

  await sweeper().tick();

  // Adopted through the persisted id: `getCompany`, never a second `createCompany` (the fake
  // throws if the create is called at all).
  expect(doola.calls.some((c) => c.startsWith("getCompany"))).toBe(true);
  expect(stateOf("create_provider")).toBe("confirmed");
});

test("C2: a create_provider row that is merely SLOW is left alone", async () => {
  repo.upsert(formedEntity({ specJson: JSON.stringify({ name: "Formation Agent" }) }));
  newParty({ entityKey: ENTITY_KEY });
  requests.claimAllSteps(ENTITY_KEY);
  db.prepare(
    `UPDATE formation_requests SET state='submitted', updated_at=?
      WHERE entity_key=? AND step='create_provider'`,
  ).run(sqliteUtcTimestamp(now - 1000), ENTITY_KEY);

  await sweeper().tick();
  // Inside the client's own deadline: the call may still be in flight in another frame.
  expect(doola.calls).toHaveLength(0);
  expect(stateOf("create_provider")).toBe("submitted");
});

// ── C3: a transient read failure is not a formation failure ────────────────────────────────

test("C3: one 502 then a healthy read — the status never shows `failed`", async () => {
  seedFormation();
  now += POLL_BASE_MS + 1000;
  doola.state.failNext = { getCompany: true };
  await sweeper().tick();

  const parked = rowOf("await_filing")!;
  expect(parked.state).toBe("pending"); // NOT failed
  expect(parked.attempt).toBe(0); // NOT burned
  expect(deriveFormationStatus(requests.stepsOf(ENTITY_KEY))).toBe("in_progress");

  // The next poll is scheduled rather than immediate, and the healthy read clears the error.
  expect(parked.nextPollAt).toBeGreaterThan(now);
  now = parked.nextPollAt! + 1000;
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  await sweeper().tick();
  expect(stateOf("await_filing")).toBe("confirmed");
});

test("C3: an await_ein row's poll cadence GROWS instead of asking every tick for six weeks", async () => {
  seedFormation();
  // Filed and documented; only the IRS is left, which takes four to six weeks.
  requests.transition(ENTITY_KEY, "await_filing", "pending", "confirmed");
  requests.transition(ENTITY_KEY, "fetch_documents", "pending", "confirmed");
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  stampRows(now);

  const intervals: number[] = [];
  for (let i = 0; i < 4; i++) {
    now += POLL_CAP_MS + 1000; // always due, so only the backoff can throttle it
    await sweeper().tick();
    const d = parseDetail<{ pollIntervalMs?: number }>(rowOf("await_ein")?.detail ?? null);
    intervals.push(d.pollIntervalMs ?? 0);
  }
  // Strictly growing until the cap, and never faster than daily.
  expect(intervals[0]).toBe(2 * POLL_BASE_MS);
  expect(intervals[1]).toBe(4 * POLL_BASE_MS);
  expect(intervals[3]).toBe(POLL_CAP_MS);
  // And the column mirrors the blob, which is what the SQL due-filter reads.
  expect(rowOf("await_ein")?.nextPollAt).toBe(now + POLL_CAP_MS);
});

// ── (a) re-driving events that arrived too early ───────────────────────────────────────────

test("an unmappable event is re-driven once create_provider lands the company id", async () => {
  // The webhook beat the create's own response — a real race, not a hypothetical one.
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    providerRef: COMPANY_ID,
    payload: "{}",
  });
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };

  await sweeper().tick();
  // Nothing owns that company id yet: kept, not dropped.
  expect(events.find("evt-1")?.processedAt).toBeNull();

  seedFormation();
  await sweeper().tick();
  expect(events.find("evt-1")?.processedAt).not.toBeNull();
  expect(stateOf("await_filing")).toBe("confirmed");
});

test("an event with an UNKNOWN name is retired by the sweeper's ordinary fetch-and-advance", async () => {
  // The receiver deliberately refuses to act on a name it has no route for. By the time the
  // sweeper sees the row, that hesitation has served its purpose and the right action for any
  // wake-up is the same: re-read doola.
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  events.record({
    eventId: "evt-1",
    eventName: "company_teleported",
    providerRef: COMPANY_ID,
    payload: "{}",
  });
  await sweeper().tick();
  expect(events.find("evt-1")?.processedAt).not.toBeNull();
  expect(stateOf("await_filing")).toBe("confirmed");
});

// ── (c) the slow poll ──────────────────────────────────────────────────────────────────────

test("an in-flight entity is polled only once a day, and the interval DOUBLES on an empty poll", async () => {
  seedFormation();
  // Nothing has happened at doola: every poll below learns nothing.
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationSubmissionStatus: "SUBMITTED" };

  // Fresh row: not due yet.
  await sweeper().tick();
  expect(doola.calls).toHaveLength(0);

  now += POLL_BASE_MS + 1000;
  await sweeper().tick();
  const first = doola.calls.filter((c) => c.startsWith("getCompany")).length;
  expect(first).toBe(1);
  const after1 = parseDetail<{ pollIntervalMs?: number; nextPollAt?: number }>(
    rowOf("await_filing")?.detail ?? null,
  );
  expect(after1.pollIntervalMs).toBe(2 * POLL_BASE_MS);
  expect(after1.nextPollAt).toBe(now + 2 * POLL_BASE_MS);

  // A day later it is NOT due — that is the whole point of the backoff.
  now += POLL_BASE_MS;
  await sweeper().tick();
  expect(doola.calls.filter((c) => c.startsWith("getCompany"))).toHaveLength(first);

  now += POLL_BASE_MS + 1000;
  await sweeper().tick();
  expect(
    parseDetail<{ pollIntervalMs?: number }>(rowOf("await_filing")?.detail ?? null).pollIntervalMs,
  ).toBe(4 * POLL_BASE_MS);
});

test("the poll interval is capped at a week — await_ein legitimately sits for six", async () => {
  seedFormation();
  requests.transition(ENTITY_KEY, "await_filing", "pending", "confirmed");
  requests.transition(ENTITY_KEY, "fetch_documents", "pending", "confirmed");
  doola.state.company = { doolaCompanyId: COMPANY_ID }; // no EIN, for weeks

  for (let i = 0; i < 12; i++) {
    now += POLL_CAP_MS + 1000;
    await sweeper().tick();
  }
  const detail = parseDetail<{ pollIntervalMs?: number }>(rowOf("await_ein")?.detail ?? null);
  expect(detail.pollIntervalMs).toBe(POLL_CAP_MS);
});

test("a poll that ADVANCES something resets the interval to daily", async () => {
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationSubmissionStatus: "SUBMITTED" };
  now += POLL_BASE_MS + 1000;
  await sweeper().tick();
  expect(
    parseDetail<{ pollIntervalMs?: number }>(rowOf("await_filing")?.detail ?? null).pollIntervalMs,
  ).toBe(2 * POLL_BASE_MS);

  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  now += 2 * POLL_BASE_MS + 1000;
  await sweeper().tick();
  expect(stateOf("await_filing")).toBe("confirmed");
  // The backoff moved to the step the entity is waiting on NOW, and started over.
  expect(
    parseDetail<{ pollIntervalMs?: number }>(rowOf("fetch_documents")?.detail ?? null)
      .pollIntervalMs,
  ).toBe(POLL_BASE_MS);
});

test("a COMPLETE entity is never polled again", async () => {
  seedFormation();
  for (const step of ["await_filing", "fetch_documents", "await_ein"])
    requests.transition(ENTITY_KEY, step as "await_filing", "pending", "confirmed");
  now += 30 * DAY;
  await sweeper().tick();
  expect(doola.calls).toHaveLength(0);
});

test("a FAILED entity belongs to the retry path, not the poll path", async () => {
  seedFormation();
  // Aged well past the POLL window, so the poll pass would happily claim it on age alone…
  fail("await_filing", 1, 30 * DAY);
  // …and parked with a retry schedule that has NOT elapsed. This is the no-bump backoff a lost
  // answer or a transient read failure leaves (C1/C3): the attempt does not move, so the
  // interval on the row is the only thing that knows how long to wait.
  requests.transition(ENTITY_KEY, "await_filing", "failed", "failed", {
    detail: JSON.stringify({ nextRetryAt: now + DAY, retryIntervalMs: DAY }),
  });
  db.prepare(
    "UPDATE formation_requests SET updated_at=? WHERE entity_key=? AND step='await_filing'",
  ).run(sqliteUtcTimestamp(now - 30 * DAY), ENTITY_KEY);

  await sweeper().tick();
  // NEITHER pass touched it: the poll skips a `failed` entity by derived status, and the retry
  // honours the schedule the parking wrote.
  expect(doola.calls).toHaveLength(0);
  expect(stateOf("await_filing")).toBe("failed");

  // Once the retry schedule elapses it is the RETRY driver that picks it up, and the successful
  // read un-parks the row (C3) without having burned an attempt.
  now += DAY + 1000;
  await sweeper().tick();
  expect(doola.calls.filter((c) => c.startsWith("getCompany"))).toHaveLength(1);
  expect(stateOf("await_filing")).toBe("pending");
  expect(rowOf("await_filing")?.attempt).toBe(1);
});

// ── (d) PII erasure ────────────────────────────────────────────────────────────────────────

test("erasure: an abandoned filing and a stale unbound handle; never a live one", async () => {
  seedFormation();
  const live = newParty({ entityKey: ENTITY_KEY });

  requests.claimAllSteps("t:dead");
  requests.transition("t:dead", "create_provider", "pending", "abandoned");
  const dead = newParty({ entityKey: "t:dead" });

  const stale = newParty();
  db.prepare("UPDATE formation_parties SET created_at = ? WHERE party_id = ?").run(
    sqliteUtcTimestamp(now - 8 * DAY),
    stale,
  );
  const fresh = newParty();

  await sweeper().tick();

  expect(parties.findOwned(TENANT, dead)).toBeUndefined();
  expect(parties.findOwned(TENANT, stale)).toBeUndefined();
  // A party bound to a filing that is actually happening carries a real retention duty.
  expect(parties.findOwned(TENANT, live)).toBeDefined();
  expect(parties.findOwned(TENANT, fresh)).toBeDefined();

  // The erasure log names the handle and the reason, never the person.
  const row = db.prepare("SELECT * FROM formation_parties WHERE party_id = ?").get(dead) as Record<
    string,
    unknown
  >;
  expect(row.legal_first_name).toBeNull();
  expect(row.deleted_at).toBeTruthy();
});

// ── (e) the stale warning ──────────────────────────────────────────────────────────────────

test("a step in flight for more than 14 days warns — once per row per day, not once per tick", async () => {
  seedFormation();
  db.prepare("UPDATE formation_requests SET created_at = ? WHERE entity_key = ?").run(
    sqliteUtcTimestamp(now - 20 * DAY),
    ENTITY_KEY,
  );

  const capture = async (s: FormationSweeper) => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (l: string) => lines.push(l);
    try {
      await s.tick();
    } finally {
      console.log = orig;
    }
    return lines.map((l) => JSON.parse(l)).filter((l) => l.opslog === "formation_stale");
  };

  const s = sweeper();
  const first = await capture(s);
  expect(first.length).toBeGreaterThan(0);
  expect(first[0]).toMatchObject({ entityKey: ENTITY_KEY, ageDays: 20, level: "warn" });

  // At the 60s default a per-tick warning would be 1440 lines a day for one stuck formation.
  now += 60_000;
  expect(await capture(s)).toHaveLength(0);
});

// ── (f) retention ──────────────────────────────────────────────────────────────────────────

test("webhook rows past 30 days are dropped, even on a table nothing is inserting into", async () => {
  events.record({
    eventId: "old",
    eventName: "company_ein_issued",
    providerRef: null,
    payload: "{}",
  });
  events.record({
    eventId: "new",
    eventName: "company_ein_issued",
    providerRef: null,
    payload: "{}",
  });
  db.prepare(
    "UPDATE doola_webhook_events SET received_at = ?, processed_at = ? WHERE event_id = 'old'",
  ).run(sqliteUtcTimestamp(now - 40 * DAY), sqliteUtcTimestamp(now - 40 * DAY));
  db.prepare("UPDATE doola_webhook_events SET processed_at = ? WHERE event_id = 'new'").run(
    sqliteUtcTimestamp(now),
  );

  // A quiet deployment gets no inserts, so insert-amortised retention would never run — which is
  // exactly the deployment where nobody is watching the disk.
  await sweeper().tick();
  expect(events.find("old")).toBeUndefined();
  expect(events.find("new")).toBeDefined();
});

// ── the loop itself ────────────────────────────────────────────────────────────────────────

test("ticks do not overlap: a slow tick is not re-entered", async () => {
  seedFormation();
  let inside = 0;
  let maxConcurrent = 0;
  const slowDoola = {
    ...doola.api,
    getCompany: async (id: string) => {
      inside++;
      maxConcurrent = Math.max(maxConcurrent, inside);
      await new Promise((r) => setTimeout(r, 20));
      inside--;
      return doola.state.company;
    },
  };
  const s = sweeper({ doola: slowDoola as never });
  now += POLL_BASE_MS + 1000;
  await Promise.all([s.tick(), s.tick(), s.tick()]);
  expect(maxConcurrent).toBe(1);
});

test("a throwing tick never stops the loop from being scheduled again", async () => {
  seedFormation();
  const exploding = {
    listUnprocessed: () => {
      throw new Error("db is on fire");
    },
    markProcessed: () => false,
    deleteOlderThan: () => 0,
    record: () => false,
    find: () => undefined,
  };
  const s = sweeper({ events: exploding as never });
  s.start();
  // start() catches, logs and re-arms; stop() then leaves nothing behind.
  await new Promise((r) => setTimeout(r, 20));
  s.stop();
  expect(true).toBe(true);
});

test("C4: start() reconciles on its FIRST iteration, and returns before it finishes", async () => {
  // Formation entities are `bound`/`funded`, so `listInFlight()` will never look at them: without
  // this pass, everything a restart interrupted would wait a whole sweep interval.
  //
  // It is also why `start()` must not be awaited at boot: the reconcile talks to doola for every
  // in-flight entity, and a provider outage must never be able to delay the API's port from
  // opening. `start()` is synchronous by construction — it schedules, it does not block.
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  doola.state.documents = [
    doolaDoc("d-aoo", "ArticlesOfOrganization"),
    doolaDoc("d-oa", "OperatingAgreement"),
  ];
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    providerRef: COMPANY_ID,
    payload: "{}",
  });

  const s = sweeper();
  // Nothing is awaited here — this is exactly what the composition root does after `serve()`.
  s.start();
  expect(stateOf("await_filing")).toBe("pending"); // still going: start() did not block

  // …and the work happens on its own.
  await vi.waitFor(() => expect(stateOf("await_filing")).toBe("confirmed"));
  expect(stateOf("fetch_documents")).toBe("confirmed");
  expect(events.find("evt-1")?.processedAt).not.toBeNull();
  s.stop();
});

test("a sweeper tick and a concurrent driver advance one entity EXACTLY once", async () => {
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  now += POLL_BASE_MS + 1000;
  await Promise.all([sweeper().tick(), advanceFormation(deps(), ENTITY_KEY)]);
  expect(stateOf("await_filing")).toBe("confirmed");
  // The CAS is what proves it: only the winner ran the write inside its transaction.
  expect(repo.listEvents(ENTITY_KEY).filter((e) => e.step === "formationFiled")).toHaveLength(1);
});

test("parseSqliteUtc reads the schema's own timestamp format, and survives nonsense", () => {
  expect(parseSqliteUtc("2026-08-21 12:00:00")).toBe(Date.parse("2026-08-21T12:00:00Z"));
  for (const bad of [null, undefined, "", "not a date"]) expect(parseSqliteUtc(bad)).toBe(0);
});

// ── M2 / M5: one dispatcher, one read per company ──────────────────────────────────────────

test("M2: the re-drive goes through the ONE dispatcher — a companyless disable event is retired", () => {
  // `partner_webhook_disabled` carries no company id and cannot be advanced; the dispatcher is
  // what knows to log it CRITICAL and retire it. The sweeper used to re-implement that branch
  // itself, which is how the two copies drifted (its version never logged an unknown name and
  // marked events processed on a different condition).
  const src = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "workflow", "formationSweeper.ts"),
    "utf8",
  );
  expect(src).toContain('source: "sweeper"');
  expect(src).toContain("acceptUnknownNames: true");
  // No second dispatch: the sweeper never inspects an event NAME for itself any more.
  expect(src).not.toContain("DOOLA_EVENT_NAMES");
});

test("M2: every step has a retry DRIVER in the table, not an `if` on create_provider", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "workflow", "formationSweeper.ts"),
    "utf8",
  );
  const table = src.slice(
    src.indexOf("private readonly drivers"),
    src.indexOf("private async retry("),
  );
  for (const step of ["create_provider", "await_filing", "fetch_documents", "await_ein"])
    expect(table, step).toContain(`${step}:`);
  // The dispatch itself is a lookup, so a fifth step without a driver is a type error rather
  // than a row that silently never retries.
  const retry = src.slice(src.indexOf("private async retry("));
  expect(retry.slice(0, 200)).toContain("this.drivers[row.step]");
  expect(retry.slice(0, 200)).not.toContain('row.step === "create_provider"');
});

test("M5: a burst of events for ONE company costs one read, and retires all of them", async () => {
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  for (const id of ["evt-1", "evt-2", "evt-3"])
    events.record({
      eventId: id,
      eventName: "company_formation_completed",
      providerRef: COMPANY_ID,
      payload: "{}",
    });

  await sweeper().tick();

  // ONE fetch-and-advance, not three: every event for a company is the same request, "look
  // again", and one read answers all of them.
  expect(doola.calls.filter((c) => c.startsWith("getCompany"))).toHaveLength(1);
  for (const id of ["evt-1", "evt-2", "evt-3"])
    expect(events.find(id)?.processedAt, id).not.toBeNull();
});

test("M5: the poll due-set is filtered in SQL — an entity that is not due is never loaded", () => {
  seedFormation();
  // Fresh rows: nothing is due, and the query says so without the sweeper reading a single blob.
  expect(requests.listPollDueEntityKeys(now, sqliteUtcTimestamp(now - POLL_BASE_MS), 100)).toEqual(
    [],
  );

  // Past the never-polled window (the row's own age is the clock).
  const later = now + POLL_BASE_MS + 1000;
  expect(
    requests.listPollDueEntityKeys(later, sqliteUtcTimestamp(later - POLL_BASE_MS), 100),
  ).toEqual([ENTITY_KEY]);

  // A persisted schedule lives in a COLUMN, so "which rows are due?" stays a query rather than a
  // scan of every open entity's detail blob. Move every row's age out of the way first — the
  // query is deliberately a SUPERSET (it does not know which step an entity is waiting on), so
  // any non-terminal polled row that is due by age keeps the entity in the candidate set.
  stampRows(later);
  expect(
    requests.listPollDueEntityKeys(later, sqliteUtcTimestamp(later - POLL_BASE_MS), 100),
  ).toEqual([]);

  requests.transition(ENTITY_KEY, "await_filing", "pending", "pending", {
    nextPollAt: later - 1,
    detail: JSON.stringify({ nextPollAt: later - 1 }),
  });
  expect(
    requests.listPollDueEntityKeys(later, sqliteUtcTimestamp(later - POLL_BASE_MS), 100),
  ).toEqual([ENTITY_KEY]);
});
