/**
 * The inbound-webhook ledger (design §3/§6) and the document index (§3/§8).
 *
 * Both exist to make an at-least-once delivery channel behave exactly-once, so the properties
 * under test are the idempotence ones: a redelivered event is one row, a re-fetched document is
 * one row and one file, and "still owed to the sweeper" is a question the schema can answer.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../../src/persistence/documentIndexRepository";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";

let db: DatabaseType.Database;
let events: SqliteDoolaEventRepository;
let docs: SqliteDocumentIndexRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  events = new SqliteDoolaEventRepository(db);
  docs = new SqliteDocumentIndexRepository(db);
});
afterEach(() => db.close());

const evt = (over: Partial<Parameters<SqliteDoolaEventRepository["record"]>[0]> = {}) => ({
  eventId: "evt-1",
  eventName: "company_formation_completed",
  providerRef: "cmp-1",
  payload: '{"eventId":"evt-1"}',
  ...over,
});

test("a redelivered event id is persisted ONCE and reports the duplicate to its caller", () => {
  expect(events.record(evt())).toBe(true);
  // doola's retry ladder redelivers the same event id up to five times.
  expect(events.record(evt())).toBe(false);
  expect(events.record(evt({ payload: '{"mutated":true}' }))).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS n FROM doola_webhook_events").get()).toEqual({ n: 1 });
  // The FIRST copy survives — it is the one any processing acted on.
  expect(events.find("evt-1")?.payload).toBe('{"eventId":"evt-1"}');
});

test("unprocessed rows are the sweeper's queue, and markProcessed is a compare-and-set", () => {
  events.record(evt());
  events.record(evt({ eventId: "evt-2", providerRef: null }));
  expect(events.listUnprocessed().map((e) => e.eventId)).toEqual(["evt-1", "evt-2"]);

  expect(events.markProcessed("evt-1")).toBe(true);
  // A second driver holding the same event loses: exactly one of them may say it finished it.
  expect(events.markProcessed("evt-1")).toBe(false);
  expect(events.listUnprocessed().map((e) => e.eventId)).toEqual(["evt-2"]);
  expect(events.find("evt-1")?.processedAt).not.toBeNull();
});

test("retention: rows older than the cutoff are deleted, newer ones are kept", () => {
  events.record(evt());
  events.record(evt({ eventId: "evt-old" }));
  db.prepare("UPDATE doola_webhook_events SET received_at = ? WHERE event_id = 'evt-old'").run(
    "2026-01-01 00:00:00",
  );
  expect(events.deleteOlderThan("2026-06-01 00:00:00")).toBe(1);
  expect(events.find("evt-old")).toBeUndefined();
  expect(events.find("evt-1")).toBeDefined();
});

// ── the document index ─────────────────────────────────────────────────────────────────────

test("the document id is DERIVED, so re-indexing the same doola document is a no-op", () => {
  const entityKey = "t:agent-1";
  const id = documentIndexId(entityKey, "doc-aoo");
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  // Deterministic across calls, and scoped to the entity.
  expect(documentIndexId(entityKey, "doc-aoo")).toBe(id);
  expect(documentIndexId("t:agent-2", "doc-aoo")).not.toBe(id);

  const rec = {
    id,
    entityKey,
    docType: "ArticlesOfOrganization",
    sha256: "a".repeat(64),
    contentType: "application/pdf",
    size: 1234,
    providerDocId: "doc-aoo",
    path: documentStoreName(entityKey, "ArticlesOfOrganization", "doc-aoo"),
  };
  expect(docs.insert(rec)).toBe(true);
  expect(docs.insert(rec)).toBe(false);
  expect(docs.listByEntity(entityKey)).toHaveLength(1);
  expect(docs.storedTypes(entityKey)).toEqual(["ArticlesOfOrganization"]);
  expect(docs.findByProviderDocId(entityKey, "doc-aoo")?.id).toBe(id);
});

test("findOwned re-asserts the entity, so one entity's document id cannot read another's", () => {
  const mine = { entityKey: "t:mine", providerDocId: "d1" };
  const theirs = { entityKey: "t:theirs", providerDocId: "d2" };
  for (const e of [mine, theirs])
    docs.insert({
      id: documentIndexId(e.entityKey, e.providerDocId),
      entityKey: e.entityKey,
      docType: "OperatingAgreement",
      sha256: "b".repeat(64),
      contentType: "application/pdf",
      size: 10,
      providerDocId: e.providerDocId,
      path: documentStoreName(e.entityKey, "OperatingAgreement", e.providerDocId),
    });

  const theirId = documentIndexId(theirs.entityKey, theirs.providerDocId);
  expect(docs.findOwned(theirs.entityKey, theirId)).toBeDefined();
  expect(docs.findOwned(mine.entityKey, theirId)).toBeUndefined();
});

test("a provider-controlled documentType can never become a path", () => {
  // doola supplies `documentType`. A traversal attempt is reduced to inert characters BEFORE it
  // is a filename — the doc store's containment guard is the backstop, not the plan.
  const name = documentStoreName("t:agent-1", "../../etc/passwd", "../d1");
  expect(name).not.toContain("/");
  expect(name).not.toContain("..");
  expect(name).toMatch(/^doc-t-agent-1-[A-Za-z0-9._-]+-[A-Za-z0-9._-]+\.pdf$/);
});
