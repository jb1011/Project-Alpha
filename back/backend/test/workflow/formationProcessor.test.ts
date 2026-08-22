/**
 * Fetch-and-advance (design §5, audit H2/M5).
 *
 * The first test is the important one and the rest support it: the webhook payload LIES — it
 * carries an EIN, a filing number and a filing date that doola's API does not — and every fact
 * that reaches the database comes from the API instead. That is what "a webhook is a wake-up
 * signal, never a source of facts" means operationally, and it is why a leaked webhook secret
 * cannot forge a legal fact.
 */
import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { DOOLA_SIGNATURE_HEADER, type DoolaWakeUp } from "../../src/api/routes/doolaWebhook";
import { deriveFormationStatus } from "../../src/formation/status";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { TaskTracker } from "../../src/util/taskTracker";
import {
  type FormationEventDeps,
  advanceFormation,
  currentPolledStep,
  eventSuggestsRequiredActions,
  filingDateToUnix,
  isFormationFailed,
  isFormationFiled,
  isKnownDoolaEvent,
  processDoolaEvent,
} from "../../src/workflow/formationProcessor";
import {
  COMPANY_ID,
  ENTITY_KEY,
  type FakeDoola,
  MemoryDocumentStore,
  doolaDoc,
  fakeDoola,
  formedEntity,
} from "../helpers/formationFakes";

const SECRET = "whsec_current";
const NOW = Date.parse("2026-08-21T12:00:00Z");

let db: Database.Database;
let repo: SqliteEntityRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let events: SqliteDoolaEventRepository;
let docStore: MemoryDocumentStore;
let doola: FakeDoola;

function deps(over: Partial<FormationEventDeps> = {}): FormationEventDeps {
  return {
    repo,
    requests,
    documents,
    docStore,
    events,
    doola: doola.api,
    environment: "sandbox",
    fetchImpl: doola.fetchImpl,
    lookupImpl: doola.lookupImpl,
    now: () => NOW,
    ...over,
  };
}

/** Seed a pinned entity whose `create_provider` has confirmed — part A's handoff state. */
function seedFormation(over: Parameters<typeof formedEntity>[0] = {}) {
  repo.upsert(formedEntity(over));
  requests.claimAllSteps(ENTITY_KEY);
  requests.transition(ENTITY_KEY, "create_provider", "pending", "confirmed", {
    providerRef: COMPANY_ID,
    detail: JSON.stringify({ companyId: COMPANY_ID }),
  });
}

const stateOf = (step: string) =>
  requests.stepsOf(ENTITY_KEY).find((s) => s.step === step)?.state ?? "(missing)";
const entity = () => repo.findByIdempotencyKey(ENTITY_KEY);
const detailOf = (step: string) =>
  JSON.parse(requests.stepsOf(ENTITY_KEY).find((s) => s.step === step)?.detail ?? "{}");

const wake = (over: Partial<DoolaWakeUp> = {}): DoolaWakeUp => ({
  eventId: "evt-1",
  eventName: "company_formation_completed",
  providerRef: COMPANY_ID,
  ...over,
});

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  events = new SqliteDoolaEventRepository(db);
  docStore = new MemoryDocumentStore();
  doola = fakeDoola();
});
afterEach(() => db.close());

// ── the wake-up-only rule, proven end to end ───────────────────────────────────────────────

test("the payload LIES and every fact still comes from the API (audit H2)", async () => {
  seedFormation();
  // What doola's API actually says.
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationSubmissionStatus: "SUBMITTED",
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-REAL-0001",
    ein: "88-1111111",
    services: [{ name: "Formation", status: "Completed" }],
  };

  const d = deps();
  const tasks = new TaskTracker("doola_webhook_task");
  const app = buildApiApp({
    webOrigin: "https://app.example.com",
    repo,
    now: () => NOW,
    doola: {
      environment: "sandbox",
      webhookSecret: SECRET,
      events,
      tasks,
      process: (w: DoolaWakeUp) => processDoolaEvent(d, w),
    },
  } as never);

  // …and what the WIRE claims. Every one of these is a legal fact, and every one is different.
  const body = JSON.stringify({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    timestamp: NOW - 1000,
    eventPayload: {
      doolaCompanyId: COMPANY_ID,
      ein: "99-9999999",
      formationFilingNumber: "WY-FORGED-6666",
      formationFilingDate: "1999-01-01",
      services: [{ name: "Formation", status: "Completed" }],
    },
  });
  const res = await app.request("/webhooks/doola/sandbox", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DOOLA_SIGNATURE_HEADER]: createHmac("sha256", SECRET).update(body).digest("hex"),
    },
    body,
  });
  expect(res.status).toBe(200);
  await tasks.settled();

  const e = entity();
  expect(e?.formationFilingNumber).toBe("WY-REAL-0001");
  expect(e?.einReal).toBe("88-1111111");
  expect(e?.formationFiledAt).toBe(filingDateToUnix("2026-08-19"));
  // Not one of the forged values reached the database.
  expect(JSON.stringify(e)).not.toContain("99-9999999");
  expect(JSON.stringify(e)).not.toContain("WY-FORGED-6666");
  // The wake-up cost exactly one authoritative read of each kind.
  expect(doola.calls.filter((c) => c.startsWith("getCompany"))).toHaveLength(1);
});

// ── advancing each step ────────────────────────────────────────────────────────────────────

test("await_filing confirms on the filing date and writes the two legal facts onto the entity", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-2026-1234",
  };
  const out = await advanceFormation(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ fetched: true, advanced: true });
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(entity()).toMatchObject({
    formationFiledAt: Date.parse("2026-08-19T00:00:00Z") / 1000,
    formationFilingNumber: "WY-2026-1234",
  });
  // The on-chain-frozen placeholder is untouched: overwriting it would make the row disagree
  // with the chain.
  expect(entity()?.ein).toBe("STUB-NOT-FILED");
  // The audit trail records the filing.
  expect(repo.listEvents(ENTITY_KEY).map((e) => e.step)).toContain("formationFiled");
});

test("a Completed formation SERVICE also confirms the filing", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    services: [{ name: "Formation", status: "Completed" }],
  };
  await advanceFormation(deps(), ENTITY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");
  // No filing date to parse — the fact we do not have is not invented.
  expect(entity()?.formationFiledAt).toBeNull();
});

test("nothing filed yet: the step stays where it is and no entity fact is written", async () => {
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationSubmissionStatus: "PENDING" };
  const out = await advanceFormation(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ fetched: true, advanced: false });
  expect(stateOf("await_filing")).toBe("pending");
  expect(entity()?.formationFiledAt).toBeFalsy();
  // The intake status is still recorded, so an operator can see what doola thinks.
  expect(detailOf("await_filing").submissionStatus).toBe("PENDING");
});

test("documents are stored, hashed, and fetch_documents confirms only when BOTH required types are in", async () => {
  seedFormation();
  doola.state.documents = [doolaDoc("d-aoo", "ArticlesOfOrganization")];
  await advanceFormation(deps(), ENTITY_KEY);

  // One of two: stored, but the step cannot confirm.
  expect(documents.listByEntity(ENTITY_KEY)).toHaveLength(1);
  expect(stateOf("fetch_documents")).toBe("pending");
  expect(detailOf("fetch_documents").missing).toEqual(["OperatingAgreement"]);

  const stored = documents.listByEntity(ENTITY_KEY)[0]!;
  const bytes = docStore.getBytes(stored.path);
  const { createHash } = await import("node:crypto");
  // The indexed hash is the hash of the bytes on disk — the property PR 3 anchors on-chain.
  expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(stored.size).toBe(bytes.length);
  expect(stored.contentType).toBe("application/pdf");

  doola.state.documents.push(doolaDoc("d-oa", "OperatingAgreement"));
  await advanceFormation(deps(), ENTITY_KEY);
  expect(stateOf("fetch_documents")).toBe("confirmed");
  expect(documents.storedTypes(ENTITY_KEY).sort()).toEqual([
    "ArticlesOfOrganization",
    "OperatingAgreement",
  ]);
});

test("an already-stored document is never re-downloaded", async () => {
  seedFormation();
  doola.state.documents = [doolaDoc("d-aoo", "ArticlesOfOrganization")];
  await advanceFormation(deps(), ENTITY_KEY);
  const first = doola.calls.filter((c) => c.startsWith("getDocumentDownloadUrl")).length;
  expect(first).toBe(1);

  await advanceFormation(deps(), ENTITY_KEY);
  expect(doola.calls.filter((c) => c.startsWith("getDocumentDownloadUrl"))).toHaveLength(first);
});

test("one unreadable document does not stop the others from being stored", async () => {
  seedFormation();
  doola.state.documents = [
    doolaDoc("d-broken", "EinLetter"),
    doolaDoc("d-aoo", "ArticlesOfOrganization"),
  ];
  doola.state.failNext = { getDocumentDownloadUrl: true };
  await advanceFormation(deps(), ENTITY_KEY);
  // The Articles of Organization are far too important to be blocked by a bad EIN letter.
  expect(documents.storedTypes(ENTITY_KEY)).toEqual(["ArticlesOfOrganization"]);
  // The step is not failed — a document that did not arrive is a reason to poll again.
  expect(stateOf("fetch_documents")).toBe("pending");
});

test("await_ein confirms on the EIN and writes ein_real, never `ein`", async () => {
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, ein: "12-3456789" };
  await advanceFormation(deps(), ENTITY_KEY);
  expect(stateOf("await_ein")).toBe("confirmed");
  expect(entity()?.einReal).toBe("12-3456789");
  expect(entity()?.ein).toBe("STUB-NOT-FILED");
  // The EIN is a tax identifier: the audit event records THAT one was issued, not what it is.
  const ev = repo.listEvents(ENTITY_KEY).find((e) => e.step === "formationEin");
  expect(ev?.detail).not.toContain("12-3456789");
});

// ── failure ────────────────────────────────────────────────────────────────────────────────

test("a FAILED formation parks every step that has not already succeeded", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    services: [{ name: "Formation", status: "Failed" }],
  };
  const out = await advanceFormation(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ fetched: true, advanced: true });
  for (const step of ["await_filing", "fetch_documents", "await_ein"])
    expect(stateOf(step), step).toBe("failed");
  // `create_provider` succeeded — a company WAS created — and a later failure does not unmake it.
  expect(stateOf("create_provider")).toBe("confirmed");
  // Attempts were burned, which is what walks the sweeper toward the abandon verdict.
  expect(requests.find(ENTITY_KEY, "await_filing")?.attempt).toBe(1);
});

test("FAILED never overrules a step that already confirmed", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-1",
  };
  await advanceFormation(deps(), ENTITY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");

  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationSubmissionStatus: "FAILED",
  };
  await advanceFormation(deps(), ENTITY_KEY);
  // Wyoming filed it. Nothing doola says later un-files it.
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(stateOf("await_ein")).toBe("failed");
});

test("C3: a doola read failure records itself and backs off — it does NOT burn an attempt", async () => {
  // A GET that 502s is not a formation going badly. Nothing was attempted, nothing committed,
  // and nothing about the entity changed. Parking it `failed` (and burning an attempt) meant
  // eight bad minutes at doola could `abandon` a company Wyoming had already filed — and
  // `abandoned` is what erases the responsible party's personal data.
  seedFormation();
  const before = requests.find(ENTITY_KEY, "await_filing")!;
  doola.state.failNext = { getCompany: true };
  const out = await advanceFormation(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ fetched: false, advanced: false });

  const after = requests.find(ENTITY_KEY, "await_filing")!;
  // The state is unchanged, so no tenant surface renders this as a failed formation…
  expect(after.state).toBe(before.state);
  expect(after.attempt).toBe(before.attempt);
  // …but the reason is on the row, and the next read is scheduled rather than immediate.
  expect(after.error).toMatch(/doola read failed/);
  expect(after.nextPollAt).toBeGreaterThan(0);
  // The steps behind it are untouched — one outage is one event, not three.
  expect(stateOf("fetch_documents")).toBe("pending");
  expect(stateOf("await_ein")).toBe("pending");
});

test("C3: one 502 then a healthy read — the status never shows `failed`, and the row un-parks", async () => {
  seedFormation();
  // Whatever put the row in `failed` (an older build, a doola-reported failure since resolved),
  // a successful read proves the reason no longer holds.
  requests.transition(ENTITY_KEY, "await_filing", "pending", "failed", { error: "boom" });

  doola.state.failNext = { getCompany: true };
  await advanceFormation(deps(), ENTITY_KEY);
  // The transient failure did not burn an attempt on the way through.
  expect(requests.find(ENTITY_KEY, "await_filing")?.attempt).toBe(0);

  await advanceFormation(deps(), ENTITY_KEY);
  const row = requests.find(ENTITY_KEY, "await_filing")!;
  expect(row.state).toBe("pending");
  expect(row.error).toBeNull();
  expect(deriveFormationStatus(requests.stepsOf(ENTITY_KEY))).toBe("in_progress");
});

// ── the guards ─────────────────────────────────────────────────────────────────────────────

test("an entity pinned to another environment is refused WITHOUT a provider call (audit M5)", async () => {
  seedFormation({ formationEnvironment: "production" });
  const out = await advanceFormation(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ fetched: false, skipped: "environment_pin" });
  // Nothing was called. A config flip cannot route a pinned entity at the other host.
  expect(doola.calls).toHaveLength(0);
  // And nothing was failed: this is our misconfiguration, not the entity's problem.
  expect(stateOf("await_filing")).toBe("pending");
});

test("an entity with no company id yet is skipped — create_provider is the sweeper's job", async () => {
  repo.upsert(formedEntity());
  requests.claimAllSteps(ENTITY_KEY);
  const out = await advanceFormation(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ fetched: false, skipped: "no_provider_ref" });
  expect(doola.calls).toHaveLength(0);
});

// ── idempotence + concurrency ──────────────────────────────────────────────────────────────

test("re-processing an already-processed event changes nothing (every transition is a CAS)", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-1",
    ein: "12-3456789",
  };
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    providerRef: COMPANY_ID,
    payload: "{}",
  });

  await processDoolaEvent(deps(), wake());
  const after = entity();
  const filedEvents = () => repo.listEvents(ENTITY_KEY).filter((e) => e.step === "formationFiled");
  expect(filedEvents()).toHaveLength(1);

  await processDoolaEvent(deps(), wake());
  await processDoolaEvent(deps(), wake());
  expect(entity()).toEqual(after);
  // The audit trail did not grow: the CAS lost, so the write inside it never ran.
  expect(filedEvents()).toHaveLength(1);
});

test("a webhook task and a sweeper tick racing one entity advance it EXACTLY once", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-1",
  };
  // Both drivers, started together, with the keyed lock bypassed on one of them: correctness is
  // DB-level (audit M13/20), and this is the assertion that says so.
  const [a, b] = await Promise.all([
    processDoolaEvent(deps(), wake()).then(() => "event"),
    advanceFormation(deps(), ENTITY_KEY).then((o) => o.advanced),
  ]);
  expect(a).toBe("event");
  expect(typeof b).toBe("boolean");
  expect(stateOf("await_filing")).toBe("confirmed");
  // Exactly one of the two won the compare-and-set, so exactly one audit event exists.
  expect(repo.listEvents(ENTITY_KEY).filter((e) => e.step === "formationFiled")).toHaveLength(1);
});

// ── the event routing rules ────────────────────────────────────────────────────────────────

test("an event whose company id maps to nothing stays UNPROCESSED for the sweeper", async () => {
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    providerRef: "cmp-unknown",
    payload: "{}",
  });
  await processDoolaEvent(deps(), wake({ providerRef: "cmp-unknown" }));
  expect(events.find("evt-1")?.processedAt).toBeNull();
  expect(doola.calls).toHaveLength(0);
});

test("an event with NO company id stays unprocessed too", async () => {
  events.record({
    eventId: "evt-1",
    eventName: "company_ein_issued",
    providerRef: null,
    payload: "{}",
  });
  await processDoolaEvent(deps(), wake({ providerRef: null, eventName: "company_ein_issued" }));
  expect(events.find("evt-1")?.processedAt).toBeNull();
});

test("an UNKNOWN event name is left for the sweeper rather than acted on blind", async () => {
  seedFormation();
  events.record({
    eventId: "evt-1",
    eventName: "company_teleported",
    providerRef: COMPANY_ID,
    payload: "{}",
  });
  await processDoolaEvent(deps(), wake({ eventName: "company_teleported" }));
  expect(events.find("evt-1")?.processedAt).toBeNull();
  expect(doola.calls).toHaveLength(0);
});

test("partner_webhook_disabled is CRITICAL, companyless, and retires itself", async () => {
  events.record({
    eventId: "evt-1",
    eventName: "partner_webhook_disabled",
    providerRef: null,
    payload: "{}",
  });
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    await processDoolaEvent(
      deps(),
      wake({ eventName: "partner_webhook_disabled", providerRef: null }),
    );
  } finally {
    console.log = orig;
  }
  const critical = lines
    .map((l) => JSON.parse(l))
    .find((l) => l.opslog === "doola_webhook_disabled");
  expect(critical).toMatchObject({ severity: "CRITICAL" });
  // Nothing to re-drive: there is no company, and the recovery is a human in the portal.
  expect(events.find("evt-1")?.processedAt).not.toBeNull();
});

test("a required-actions-shaped event also reads required-actions, and stores codes only", async () => {
  seedFormation();
  doola.state.requiredActions = [
    {
      requiredActionId: "ra-1",
      actionCode: "FORMATION_NAME_OPTIONS_EXHAUSTED",
      status: "OPEN",
      open: true,
      // doola prose that could name a person: never stored, never served.
      reason: "All name options for Ada Lovelace were rejected",
    },
  ];
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_required_action",
    providerRef: COMPANY_ID,
    payload: "{}",
  });
  // Unknown NAME, so the webhook path leaves it — the sweeper drives it. Drive the advance
  // directly with the flag the sweeper sets.
  await advanceFormation(deps(), ENTITY_KEY, { requiredActions: true });
  expect(detailOf("await_filing").requiredActions).toEqual([
    { id: "ra-1", code: "FORMATION_NAME_OPTIONS_EXHAUSTED", status: "OPEN" },
  ]);
  expect(JSON.stringify(detailOf("await_filing"))).not.toContain("Ada Lovelace");
});

// ── the pure helpers ───────────────────────────────────────────────────────────────────────

test("event-name classification", () => {
  for (const n of [
    "company_formation_completed",
    "company_formation_failed",
    "company_ein_issued",
    "partner_webhook_disabled",
    "document_aoo_uploaded",
    "document_operatingagreement_uploaded",
    // The signed SS-4 arrives as a DOCUMENT event, not a signature_* one (fact-checked).
    "document_ss4_uploaded",
  ])
    expect(isKnownDoolaEvent(n), n).toBe(true);
  for (const n of ["company_teleported", "signature_ss4_completed", ""])
    expect(isKnownDoolaEvent(n), n).toBe(false);

  expect(eventSuggestsRequiredActions("company_formation_required_action")).toBe(true);
  expect(eventSuggestsRequiredActions("signature_ss4_reset")).toBe(true);
  expect(eventSuggestsRequiredActions("company_ein_issued")).toBe(false);
});

test("reading doola's company state", () => {
  expect(isFormationFiled({ doolaCompanyId: "c", formationFilingDate: "2026-01-01" })).toBe(true);
  expect(
    isFormationFiled({
      doolaCompanyId: "c",
      services: [{ name: "Formation", status: "Completed" }],
    }),
  ).toBe(true);
  expect(isFormationFiled({ doolaCompanyId: "c", formationSubmissionStatus: "SUBMITTED" })).toBe(
    false,
  );
  expect(
    isFormationFailed({ doolaCompanyId: "c", services: [{ name: "Formation", status: "Failed" }] }),
  ).toBe(true);
  expect(isFormationFailed({ doolaCompanyId: "c", formationSubmissionStatus: "FAILED" })).toBe(
    true,
  );
  expect(isFormationFailed({ doolaCompanyId: "c", formationSubmissionStatus: "PENDING" })).toBe(
    false,
  );

  expect(filingDateToUnix("2026-08-19")).toBe(Date.parse("2026-08-19T00:00:00Z") / 1000);
  for (const bad of [null, undefined, "", "19/08/2026", "2026-08"])
    expect(filingDateToUnix(bad)).toBeNull();
});

test("currentPolledStep names the step an entity is actually waiting on", () => {
  seedFormation();
  expect(currentPolledStep(requests.stepsOf(ENTITY_KEY))).toBe("await_filing");
  requests.transition(ENTITY_KEY, "await_filing", "pending", "confirmed");
  expect(currentPolledStep(requests.stepsOf(ENTITY_KEY))).toBe("fetch_documents");
  requests.transition(ENTITY_KEY, "fetch_documents", "pending", "confirmed");
  expect(currentPolledStep(requests.stepsOf(ENTITY_KEY))).toBe("await_ein");
  requests.transition(ENTITY_KEY, "await_ein", "pending", "confirmed");
  expect(currentPolledStep(requests.stepsOf(ENTITY_KEY))).toBeUndefined();
});
