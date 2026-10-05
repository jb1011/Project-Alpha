import Database from "better-sqlite3";
import { getAddress } from "viem";
import { beforeEach, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import {
  type Deployment,
  IN_FLIGHT_BINDING_STATES,
  type LapseReason,
  LegalBodyInputError,
  type LegalBodyRecord,
  SqliteLegalBodyRepository,
} from "../../src/persistence/legalBodyRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";

const TENANT = "0x00000000000000000000000000000000000000A1";
const OTHER_TENANT = "0x00000000000000000000000000000000000000A2";
const OWNER = "0x00000000000000000000000000000000000000A3";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const OTHER_FACTORY = "0x00000000000000000000000000000000000000f2";
const CHAIN = 5042002;
const D: Deployment = { chainId: CHAIN, factory: FACTORY };
const D_OTHER: Deployment = { chainId: CHAIN, factory: OTHER_FACTORY };
/** A time in unix MILLISECONDS, the unit of every schedule. */
const T = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
/** A value of the wrong type, as a caller without type checking could pass it. */
const as = <T>(value: unknown) => value as T;

let db: Database.Database;
let repo: SqliteLegalBodyRepository;
let bodies = 0;
let raws = 0;

const company = (companyId: string, tenant = TENANT) =>
  db
    .prepare(
      `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
       VALUES (?, ?, 'ready', 'customer', 'sandbox', '["Example Holdings LLC"]', 'existing', 'existing')`,
    )
    .run(companyId, tenant);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  company("co_1");
  company("co_2", OTHER_TENANT);
  repo = new SqliteLegalBodyRepository(db);
  bodies = 0;
  raws = 0;
});

interface Where {
  tenant?: string;
  company?: string;
  factory?: string;
}
/** A distinct placeholder body address per call: never the zero address or a factory. */
const nextBody = () => `0x${(0x100 + ++bodies).toString(16).padStart(40, "0")}` as `0x${string}`;
const newBody = (w: Where = {}) =>
  repo.create({
    tenantId: (w.tenant ?? TENANT) as `0x${string}`,
    companyId: w.company ?? (w.tenant === OTHER_TENANT ? "co_2" : "co_1"),
    chainId: CHAIN,
    factory: (w.factory ?? FACTORY) as `0x${string}`,
    amendmentDelay: 172800,
  }).legalBodyId;
const frozenDraft = (w: Where = {}) => {
  const id = newBody(w);
  expect(repo.freezeAgreement(id, { hash: H("a"), version: 1 })).toBe(true);
  return id;
};
const link = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  identityOwner: OWNER as `0x${string}`,
  linkDigest: H("b"),
  linkDeadline: 1_900_000_000,
  linkSignature: "0x01" as `0x${string}`,
  bodyAddress: nextBody(),
  observedAtBlock: 100,
  firstCheckAt: T,
  ...over,
});
const reserved = (agentId: string, w: Where = {}, over: Record<string, unknown> = {}) => {
  const id = frozenDraft(w);
  expect(repo.reserve(id, link(agentId, over))).toBe("reserved");
  return id;
};
const deployed = (agentId: string, w: Where = {}, deployedAt = 1_800_000_000) => {
  const id = reserved(agentId, w);
  expect(repo.markDeployed(id, { txHash: H("c"), deployedAt })).toBe(true);
  return id;
};
const linked = (agentId: string, w: Where = {}) => {
  const id = deployed(agentId, w);
  expect(repo.markLinked(id, 1_800_000_100)).toMatchObject({ outcome: "linked" });
  return id;
};
/** A draft written by raw SQL, `ageMs` before `now`: `created_at` is set once, at the insert. */
const backdatedDraft = (ageMs: number, now: number, w: Where = {}) => {
  raws++;
  const id = `lb_${raws.toString(16).padStart(36, "0")}`;
  const tenant = getAddress(w.tenant ?? TENANT);
  db.prepare(
    `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 172800, ?)`,
  ).run(
    id,
    raws.toString(16).padStart(36, "0"),
    tenant,
    w.company ?? (w.tenant === OTHER_TENANT ? "co_2" : "co_1"),
    CHAIN,
    getAddress(w.factory ?? FACTORY),
    tenant,
    sqliteUtcTimestamp(now - ageMs),
  );
  return id;
};
const stateOf = (id: string) => repo.findById(id)?.bindingState;
const kindsOf = (id: string) => repo.listEvents(id).map((e) => e.kind);
const ids = (rows: LegalBodyRecord[]) => rows.map((r) => r.legalBodyId);
const storedDetail = (eventId: number) =>
  (
    db.prepare("SELECT detail FROM legal_body_events WHERE id = ?").get(eventId) as {
      detail: string;
    }
  ).detail;
const snapshot = (id: string) => ({ row: repo.findById(id), events: repo.listEvents(id) });

// ── One agent: one order on its way and one linked body, per deployment ──

test("two rows for one agent, one linked and one reserved, both exist; a second order on its way is agent_in_flight", () => {
  const first = linked("42");
  const second = reserved("42");
  expect(stateOf(first)).toBe("linked");
  expect(stateOf(second)).toBe("reserved");
  const third = frozenDraft();
  expect(repo.reserve(third, link("42"))).toBe("agent_in_flight");
  expect(repo.markDeployed(second, { txHash: H("c"), deployedAt: 1_800_000_000 })).toBe(true);
  expect(repo.reserve(third, link("42"))).toBe("agent_in_flight");
  // A collision on the body address as well still answers for the agent.
  const taken = repo.findById(second)?.bodyAddress;
  expect(repo.reserve(third, link("42", { bodyAddress: taken }))).toBe("agent_in_flight");
  expect(stateOf(third)).toBe("draft");
  expect(kindsOf(third)).toEqual(["created", "agreement_frozen"]);
  expect(IN_FLIGHT_BINDING_STATES).toEqual(["reserved", "deployed"]);
});

test("reserve writes the block it observed as a number in its event, and schedules the first check", () => {
  const id = frozenDraft();
  // Nine digits: as a string, the event writer would redact it.
  expect(
    repo.reserve(id, link("42", { observedAtBlock: 123_456_789, firstCheckAt: T + 5_000 })),
  ).toBe("reserved");
  const accepted = repo.listEvents(id).find((e) => e.kind === "link_accepted");
  expect(accepted?.detail).toEqual({ observedAtBlock: 123_456_789 });
  expect(storedDetail(accepted?.id ?? -1)).toBe('{"observedAtBlock":123456789}');
  const row = repo.findById(id);
  expect([row?.nextBindingCheckAt, row?.bindingCheckIntervalMs]).toEqual([T + 5_000, 30_000]);
  expect(repo.acceptedAtBlock(id)).toBe(123_456_789);
  // Block zero is a block.
  expect(repo.reserve(frozenDraft(), link("43", { observedAtBlock: 0 }))).toBe("reserved");
  expect(repo.acceptedAtBlock(frozenDraft())).toBeUndefined();
  expect(repo.acceptedAtBlock("lb_unknown")).toBeUndefined();
});

test("reserve throws a LegalBodyInputError for an observed block or a first check that is not one, and writes nothing", () => {
  const id = frozenDraft();
  const before = snapshot(id);
  for (const observedAtBlock of [-1, 1.5, Number.NaN, "100", 100n, null, undefined, 2 ** 60])
    expect(
      () => repo.reserve(id, as(link("42", { observedAtBlock }))),
      `observedAtBlock ${String(observedAtBlock)}`,
    ).toThrow(LegalBodyInputError);
  for (const firstCheckAt of [
    1_800_000_000, // a time in seconds
    99_999_999_999,
    0,
    -1,
    T + 0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    String(T),
    BigInt(T),
    null,
    undefined,
  ])
    expect(
      () => repo.reserve(id, as(link("42", { firstCheckAt }))),
      `firstCheckAt ${String(firstCheckAt)}`,
    ).toThrow(LegalBodyInputError);
  expect(snapshot(id)).toEqual(before);
  expect(repo.reserve(id, link("42", { firstCheckAt: 100_000_000_000 }))).toBe("reserved");
});

test("markLinked moves the body linked before it to broken, in the same transaction", () => {
  const first = linked("42");
  const otherDeployment = linked("42", { factory: OTHER_FACTORY });
  const second = deployed("42");
  const before = { first: snapshot(first), second: snapshot(second) };
  // The second write of the unit fails: the first is undone with it.
  db.exec(`CREATE TEMP TRIGGER refuse_link BEFORE UPDATE OF binding_state ON legal_bodies
    WHEN NEW.binding_state = 'linked' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;`);
  expect(() => repo.markLinked(second, 1_800_000_200)).toThrow("refused by the test");
  expect(snapshot(first)).toEqual(before.first);
  expect(snapshot(second)).toEqual(before.second);
  db.exec("DROP TRIGGER temp.refuse_link");

  expect(repo.markLinked(second, 1_800_000_200)).toEqual({ outcome: "linked", replaced: [first] });
  expect(stateOf(first)).toBe("broken");
  expect(stateOf(second)).toBe("linked");
  expect(repo.findById(second)?.pointerSeenAt).toBe(1_800_000_200);
  const replacedEvent = repo.listEvents(first).at(-1);
  expect(replacedEvent?.kind).toBe("broken");
  expect(replacedEvent?.actor).toBe("system");
  expect(replacedEvent?.detail).toEqual({ reason: "replaced", by: second });
  expect(repo.latestBrokenReason(first)).toBe("replaced");
  expect(repo.findLinkedByAgent(D, "42")?.legalBodyId).toBe(second);
  // A body under another factory is another deployment's business.
  expect(stateOf(otherDeployment)).toBe("linked");
  // The chain can name the first body again: it replaces the second in turn.
  expect(repo.markLinked(first, 1_800_000_300)).toEqual({ outcome: "linked", replaced: [second] });
  expect(repo.listEvents(second).at(-1)?.detail).toEqual({ reason: "replaced", by: first });
  // A row that cannot be linked is an answer, and moves nothing.
  const onItsWay = reserved("43");
  for (const id of [first, onItsWay, "lb_unknown"])
    expect(repo.markLinked(id, 1_800_000_400), id).toEqual({ outcome: "not_linkable" });
  expect(stateOf(second)).toBe("broken");
});

test("a row reserved with an empty signature reads it back; half a byte is still refused", () => {
  const id = frozenDraft();
  expect(repo.reserve(id, link("42", { linkSignature: "0x" }))).toBe("reserved");
  expect(repo.findById(id)?.linkSignature).toBe("0x");
  const other = frozenDraft();
  expect(() => repo.reserve(other, link("43", { linkSignature: "0x1" }))).toThrow(
    LegalBodyInputError,
  );
  expect(stateOf(other)).toBe("draft");
});

test("lapse records its reason and the block time as a number; any other reason is refused", () => {
  const reasons: readonly LapseReason[] = [
    "deadline_passed",
    "foreign_body",
    "owner_changed",
    "refused_before_send",
  ];
  for (const [i, reason] of reasons.entries()) {
    const id = reserved(String(50 + i));
    expect(repo.lapse(id, { reason, blockTime: 1_800_000_000 + i })).toBe(true);
    expect(stateOf(id)).toBe("lapsed");
    const event = repo.listEvents(id).at(-1);
    expect(event?.kind).toBe("lapsed");
    expect(event?.detail).toEqual({ reason, blockTime: 1_800_000_000 + i });
    expect(storedDetail(event?.id ?? -1)).toBe(
      `{"reason":"${reason}","blockTime":${1_800_000_000 + i}}`,
    );
  }
  const id = reserved("60");
  const before = snapshot(id);
  for (const reason of ["deadline passed", "expired", "", null, undefined, 5])
    expect(
      () => repo.lapse(id, as({ reason, blockTime: 1_800_000_000 })),
      `reason ${String(reason)}`,
    ).toThrow(LegalBodyInputError);
  for (const blockTime of [
    0,
    -1,
    1.5,
    Number.NaN,
    1_800_000_000_000, // a time in milliseconds
    "1800000000",
    1_800_000_000n,
    undefined,
  ])
    expect(
      () => repo.lapse(id, as({ reason: "deadline_passed", blockTime })),
      `blockTime ${String(blockTime)}`,
    ).toThrow(LegalBodyInputError);
  expect(snapshot(id)).toEqual(before);
  expect(repo.lapse(id, { reason: "deadline_passed", blockTime: 1_800_000_000 })).toBe(true);
  // Compare-and-set: the second lapse made no move, and records nothing.
  const events = repo.listEvents(id);
  expect(repo.lapse(id, { reason: "deadline_passed", blockTime: 1_800_000_001 })).toBe(false);
  expect(repo.listEvents(id)).toEqual(events);
});

test("abandon and supersede record the actor they are given, and the system by default", () => {
  const byTenant = newBody();
  expect(repo.abandon(byTenant, "closed by its owner", "tenant")).toBe(true);
  expect(repo.listEvents(byTenant).at(-1)).toMatchObject({
    kind: "abandoned",
    actor: "tenant",
    detail: { reason: "closed by its owner" },
  });
  const bySystem = newBody();
  expect(repo.abandon(bySystem, "expired")).toBe(true);
  expect(repo.listEvents(bySystem).at(-1)?.actor).toBe("system");
  const set = deployed("42");
  expect(repo.supersede(set, "lb_other", "operator:ops")).toBe(true);
  expect(repo.listEvents(set).at(-1)).toMatchObject({
    kind: "superseded",
    actor: "operator:ops",
    detail: { by: "lb_other" },
  });
  const setBySystem = deployed("43");
  expect(repo.supersede(setBySystem, "lb_other")).toBe(true);
  expect(repo.listEvents(setBySystem).at(-1)?.actor).toBe("system");
});

// ── Finders scoped to one deployment ──

test("listInFlightByAgent returns the reserved or deployed row and not a linked one; findLinkedByAgent the linked one", () => {
  const linkedId = linked("42");
  const onItsWay = reserved("42");
  expect(ids(repo.listInFlightByAgent(D, "42"))).toEqual([onItsWay]);
  expect(repo.findLinkedByAgent(D, "42")?.legalBodyId).toBe(linkedId);
  expect(repo.markDeployed(onItsWay, { txHash: H("c"), deployedAt: 1_800_000_000 })).toBe(true);
  expect(ids(repo.listInFlightByAgent(D, "42"))).toEqual([onItsWay]);
  // One spelling of an agentId: leading zeros are normalized away.
  expect(ids(repo.listInFlightByAgent(D, "0042"))).toEqual([onItsWay]);
  expect(repo.findLinkedByAgent(D, "042")?.legalBodyId).toBe(linkedId);
  // The factory in any casing is the same deployment.
  const shouted = { chainId: CHAIN, factory: `0x${FACTORY.slice(2).toUpperCase()}` as const };
  expect(ids(repo.listInFlightByAgent(shouted, "42"))).toEqual([onItsWay]);
  // Another factory, another chain or another agent holds nothing here.
  for (const d of [D_OTHER, { chainId: 1, factory: FACTORY } as Deployment]) {
    expect(repo.listInFlightByAgent(d, "42")).toEqual([]);
    expect(repo.findLinkedByAgent(d, "42")).toBeUndefined();
  }
  expect(repo.listInFlightByAgent(D, "43")).toEqual([]);
  expect(repo.findLinkedByAgent(D, "43")).toBeUndefined();
  // A value that is not a uint256 in decimal holds nothing.
  for (const bad of ["0x2a", "", "-42", " 42", (2n ** 256n).toString(), 42, null]) {
    expect(repo.listInFlightByAgent(D, as(bad)), String(bad)).toEqual([]);
    expect(repo.findLinkedByAgent(D, as(bad)), String(bad)).toBeUndefined();
  }
  // Once nothing is on its way or linked, nothing is found.
  expect(repo.markBroken(linkedId, { reason: "pointer_cleared" })).toBe(true);
  expect(repo.findLinkedByAgent(D, "42")).toBeUndefined();
});

test("a deployment that no row may hold is refused with a LegalBodyInputError", () => {
  for (const d of [
    { chainId: 0, factory: FACTORY },
    { chainId: -1, factory: FACTORY },
    { chainId: 1.5, factory: FACTORY },
    { chainId: "5042002", factory: FACTORY },
    { chainId: CHAIN, factory: "nope" },
    { chainId: CHAIN, factory: undefined },
    null,
    undefined,
  ]) {
    const label = JSON.stringify(d);
    expect(() => repo.listInFlightByAgent(as(d), "42"), label).toThrow(LegalBodyInputError);
    expect(() => repo.findLinkedByAgent(as(d), "42"), label).toThrow(LegalBodyInputError);
    expect(() => repo.listReserved(as(d), T, 10), label).toThrow(LegalBodyInputError);
    expect(() => repo.listBindingDue(as(d), T, 10), label).toThrow(LegalBodyInputError);
    expect(() => repo.deploySubmissionAtNonce(as(d), 5), label).toThrow(LegalBodyInputError);
    expect(() => repo.countCreatesSince(as(d), 0), label).toThrow(LegalBodyInputError);
  }
});

// ── The two schedules ──

test("a reserved row is never in listBindingDue, and a row of another factory is in neither listing and does not block the agent", () => {
  const foreign = reserved("42", { factory: OTHER_FACTORY });
  const mine = reserved("42"); // not blocked by the order under the other factory
  const foreignDeployed = deployed("43", { factory: OTHER_FACTORY });
  const mineDeployed = deployed("44");
  // Every row above is due at T, the first check its reserve scheduled.
  expect(ids(repo.listReserved(D, T + 1_000, 10))).toEqual([mine]);
  expect(ids(repo.listBindingDue(D, T + 1_000, 10))).toEqual([mineDeployed]);
  expect(ids(repo.listReserved(D_OTHER, T + 1_000, 10))).toEqual([foreign]);
  expect(ids(repo.listBindingDue(D_OTHER, T + 1_000, 10))).toEqual([foreignDeployed]);
  // Whatever its schedule says, a reserved row is resolved, not checked.
  expect(repo.scheduleBindingCheck(mine, 100_000_000_000, 60_000)).toBe(true);
  expect(ids(repo.listBindingDue(D, T + 1_000, 10))).toEqual([mineDeployed]);
  expect(ids(repo.listReserved(D, T + 1_000, 10))).toEqual([mine]);
});

test("listBindingDue lists the checkable states only: deployed, linked, broken and superseded", () => {
  const draft = newBody();
  const abandoned = newBody();
  repo.abandon(abandoned, "never signed");
  const onItsWay = reserved("101");
  const lapsed = reserved("102");
  repo.lapse(lapsed, { reason: "deadline_passed", blockTime: 1_800_000_000 });
  const dep = deployed("103");
  const lnk = linked("104");
  const brk = linked("105");
  repo.markBroken(brk, { reason: "pointer_cleared" });
  const sup = deployed("106");
  repo.supersede(sup, "lb_other");
  for (const id of [draft, abandoned, onItsWay, lapsed, dep, lnk, brk, sup])
    db.prepare(
      "UPDATE legal_bodies SET next_binding_check_at = ?, binding_check_interval_ms = 60000 WHERE legal_body_id = ?",
    ).run(T, id);
  expect(new Set(ids(repo.listBindingDue(D, T, 10)))).toEqual(new Set([dep, lnk, brk, sup]));
  expect(ids(repo.listReserved(D, T, 10))).toEqual([onItsWay]);
});

test("listReserved is soonest first and returns only due rows", () => {
  const a = reserved("81", {}, { firstCheckAt: T + 3_000 });
  const b = reserved("82", {}, { firstCheckAt: T + 1_000 });
  const c = reserved("83", {}, { firstCheckAt: T + 2_000 });
  reserved("84", {}, { firstCheckAt: T + 9_000 });
  deployed("85"); // due at T, but not reserved
  expect(ids(repo.listReserved(D, T + 5_000, 10))).toEqual([b, c, a]);
  expect(ids(repo.listReserved(D, T + 5_000, 2))).toEqual([b, c]);
  // Due at exactly `now` counts.
  expect(ids(repo.listReserved(D, T + 2_000, 10))).toEqual([b, c]);
  expect(repo.listReserved(D, T + 999, 10)).toEqual([]);
  // A row taken off the schedule is not listed.
  expect(repo.scheduleBindingCheck(b, null, null)).toBe(true);
  expect(ids(repo.listReserved(D, T + 5_000, 10))).toEqual([c, a]);
  // Ties are broken by id.
  const d1 = reserved("86", {}, { firstCheckAt: T + 4_000 });
  const d2 = reserved("87", {}, { firstCheckAt: T + 4_000 });
  expect(ids(repo.listReserved(D, T + 4_000, 10))).toEqual([c, a, ...[d1, d2].sort()]);
  for (const limit of [0, -1, 1.5, Number.NaN, "2", 2n, null])
    expect(() => repo.listReserved(D, T, as(limit)), `limit ${String(limit)}`).toThrow(
      LegalBodyInputError,
    );
  for (const now of [-1, T + 0.5, Number.NaN, Number.POSITIVE_INFINITY, String(T), null])
    expect(() => repo.listReserved(D, as(now), 10), `now ${String(now)}`).toThrow(
      LegalBodyInputError,
    );
});

test("scheduleBindingCheck refuses a time in seconds", () => {
  const id = deployed("42");
  const before = repo.findById(id);
  for (const nextAt of [1_800_000_000, 99_999_999_999, 1_000, 0])
    expect(() => repo.scheduleBindingCheck(id, nextAt, 60_000), String(nextAt)).toThrow(
      LegalBodyInputError,
    );
  expect(repo.findById(id)).toEqual(before);
  expect(repo.scheduleBindingCheck(id, 100_000_000_000, 60_000)).toBe(true);
  expect(repo.findById(id)?.nextBindingCheckAt).toBe(100_000_000_000);
});

test("listExpiredDrafts returns a draft older than 24 hours, oldest first, and not a younger one", () => {
  const now = Date.now();
  const old = backdatedDraft(25 * HOUR, now);
  backdatedDraft(23 * HOUR, now);
  const oldest = backdatedDraft(30 * HOUR, now);
  newBody();
  const closed = backdatedDraft(26 * HOUR, now);
  expect(repo.abandon(closed, "never signed")).toBe(true);
  expect(ids(repo.listExpiredDrafts(now, 10))).toEqual([oldest, old]);
  expect(ids(repo.listExpiredDrafts(now, 1))).toEqual([oldest]);
  expect(repo.listExpiredDrafts(now - 7 * HOUR, 10)).toEqual([]);
  for (const limit of [0, -1, 1.5, "1"])
    expect(() => repo.listExpiredDrafts(now, as(limit)), `limit ${String(limit)}`).toThrow(
      LegalBodyInputError,
    );
  for (const at of [-1, 0.5, Number.NaN, String(now)])
    expect(() => repo.listExpiredDrafts(as(at), 10), `now ${String(at)}`).toThrow(
      LegalBodyInputError,
    );
});

// ── The event log, read back ──

test("isRevoked is true after a revoked event; latestBrokenReason reads the newest broken event's reason", () => {
  const id = linked("42");
  const other = linked("43");
  expect(repo.isRevoked(id)).toBe(false);
  expect(repo.latestBrokenReason(id)).toBeUndefined();
  expect(repo.markBroken(id, { reason: "pointer_cleared" })).toBe(true);
  expect(repo.latestBrokenReason(id)).toBe("pointer_cleared");
  expect(repo.markLinked(id, 1_800_000_200)).toEqual({ outcome: "linked", replaced: [] });
  expect(repo.markBroken(id, { reason: "dissolved" })).toBe(true);
  expect(repo.latestBrokenReason(id)).toBe("dissolved");
  // A broken event without a reason has none to read.
  expect(repo.markBroken(other, { observedAtBlock: 7 })).toBe(true);
  expect(repo.latestBrokenReason(other)).toBeUndefined();
  repo.recordEvent(id, "revoked", "operator:ops", null, { reason: "revoked by the operator" });
  expect(repo.isRevoked(id)).toBe(true);
  expect(repo.isRevoked(other)).toBe(false);
  expect(repo.isRevoked("lb_unknown")).toBe(false);
  expect(repo.latestBrokenReason("lb_unknown")).toBeUndefined();
});

test("listDeploySubmissions is newest first; deploySubmissionAtNonce finds a lapsed row's submission and ignores another factory's", () => {
  const id = reserved("42");
  expect(repo.recordDeploySubmission(id, { txHash: H("1"), rawTx: "0x01", nonce: 5 })).toBe(true);
  expect(repo.recordDeploySubmission(id, { txHash: H("2"), rawTx: "0x02", nonce: 6 })).toBe(true);
  // The same nonce, sent again.
  expect(repo.recordDeploySubmission(id, { txHash: H("3"), rawTx: "0x03", nonce: 5 })).toBe(true);
  const eventIds = repo
    .listEvents(id)
    .filter((e) => e.kind === "deploy_submitted")
    .map((e) => e.id);
  const submissions = repo.listDeploySubmissions(id);
  expect(submissions).toEqual([
    { legalBodyId: id, txHash: H("3"), rawTx: "0x03", nonce: 5, eventId: eventIds[2] },
    { legalBodyId: id, txHash: H("2"), rawTx: "0x02", nonce: 6, eventId: eventIds[1] },
    { legalBodyId: id, txHash: H("1"), rawTx: "0x01", nonce: 5, eventId: eventIds[0] },
  ]);
  expect(repo.listDeploySubmissions(reserved("43"))).toEqual([]);
  expect(repo.listDeploySubmissions("lb_unknown")).toEqual([]);

  expect(repo.lapse(id, { reason: "deadline_passed", blockTime: 1_800_000_000 })).toBe(true);
  const foreign = reserved("42", { factory: OTHER_FACTORY });
  expect(repo.recordDeploySubmission(foreign, { txHash: H("4"), rawTx: "0x04", nonce: 5 })).toBe(
    true,
  );
  expect(repo.deploySubmissionAtNonce(D, 5)).toEqual(submissions[0]);
  expect(repo.deploySubmissionAtNonce(D, 6)).toEqual(submissions[1]);
  expect(repo.deploySubmissionAtNonce(D_OTHER, 5)?.legalBodyId).toBe(foreign);
  expect(repo.deploySubmissionAtNonce(D, 7)).toBeUndefined();
  expect(repo.deploySubmissionAtNonce({ chainId: 1, factory: FACTORY }, 5)).toBeUndefined();
  // A detail written around the repository is not a submission, and hides none.
  db.prepare(
    "INSERT INTO legal_body_events (legal_body_id, kind, actor, tx_hash, detail) VALUES (?, 'deploy_submitted', 'system', ?, 'not json')",
  ).run(id, H("5"));
  expect(repo.deploySubmissionAtNonce(D, 5)).toEqual(submissions[0]);
  expect(repo.listDeploySubmissions(id)).toEqual(submissions);
  for (const nonce of [-1, 1.5, Number.NaN, "5", 5n, null])
    expect(() => repo.deploySubmissionAtNonce(D, as(nonce)), String(nonce)).toThrow(
      LegalBodyInputError,
    );
});

// ── What the caps count ──

test("hasOpenForCompany: a fresh draft, a reserved, a deployed or a linked row; hasLinkedForCompany: a linked row only", () => {
  const now = Date.now();
  for (const c of ["co_fresh", "co_young", "co_old", "co_res", "co_dep", "co_lnk", "co_lap"])
    company(c);
  newBody({ company: "co_fresh" });
  backdatedDraft(23 * HOUR, now, { company: "co_young" });
  backdatedDraft(25 * HOUR, now, { company: "co_old" });
  reserved("71", { company: "co_res" });
  deployed("72", { company: "co_dep" });
  const lnk = linked("73", { company: "co_lnk" });
  const lap = reserved("74", { company: "co_lap" });
  expect(repo.lapse(lap, { reason: "deadline_passed", blockTime: 1_800_000_000 })).toBe(true);
  const open = ["co_fresh", "co_young", "co_res", "co_dep", "co_lnk"];
  for (const c of open) expect(repo.hasOpenForCompany(c, now), c).toBe(true);
  for (const c of ["co_old", "co_lap", "co_unknown"])
    expect(repo.hasOpenForCompany(c, now), c).toBe(false);
  for (const c of [...open, "co_old", "co_lap"])
    expect(repo.hasLinkedForCompany(c), c).toBe(c === "co_lnk");
  // The young draft ages out like any other.
  expect(repo.hasOpenForCompany("co_young", now + 2 * HOUR)).toBe(false);
  // A broken body is neither.
  expect(repo.markBroken(lnk, { reason: "pointer_cleared" })).toBe(true);
  expect(repo.hasLinkedForCompany("co_lnk")).toBe(false);
  expect(repo.hasOpenForCompany("co_lnk", now)).toBe(false);
});

test("countOpenByTenant counts a draft under 24 hours, a reserved row, and a deployed row for 7 days after deployedAt", () => {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  backdatedDraft(23 * HOUR, now);
  backdatedDraft(25 * HOUR, now);
  reserved("91");
  deployed("92", {}, nowSeconds - 60);
  linked("93");
  repo.lapse(reserved("94"), { reason: "deadline_passed", blockTime: 1_800_000_000 });
  repo.abandon(newBody(), "never signed");
  const brk = linked("95");
  repo.markBroken(brk, { reason: "pointer_cleared" });
  repo.supersede(deployed("96"), "lb_other");
  newBody({ tenant: OTHER_TENANT });
  // The young draft, the reserved row and the deployed row.
  expect(repo.countOpenByTenant(TENANT, now)).toBe(3);
  expect(repo.countOpenByTenant(TENANT.toLowerCase(), now)).toBe(3);
  // Two hours on, the young draft is past its 24 hours.
  expect(repo.countOpenByTenant(TENANT, now + 2 * HOUR)).toBe(2);
  expect(repo.countOpenByTenant(OTHER_TENANT, now)).toBe(1);
  expect(repo.countOpenByTenant("not an address", now)).toBe(0);
});

test("countOpenByTenant: a deployed row counts for 7 days after deployedAt and not after", () => {
  const deployedAt = 1_800_000_000;
  deployed("42", { tenant: OTHER_TENANT }, deployedAt);
  const sevenDaysOn = (deployedAt + 7 * 24 * 60 * 60) * 1000;
  expect(repo.countOpenByTenant(OTHER_TENANT, deployedAt * 1000)).toBe(1);
  expect(repo.countOpenByTenant(OTHER_TENANT, sevenDaysOn - 1)).toBe(1);
  expect(repo.countOpenByTenant(OTHER_TENANT, sevenDaysOn)).toBe(0);
  expect(repo.countOpenByTenant(OTHER_TENANT, sevenDaysOn + DAY)).toBe(0);
});

test("countOrdersCreatedByTenant counts every row created in the window, abandoned ones included, and not another tenant's", () => {
  const now = Date.now();
  newBody();
  repo.abandon(newBody(), "never signed");
  reserved("42");
  newBody({ tenant: OTHER_TENANT });
  backdatedDraft(25 * HOUR, now);
  expect(repo.countOrdersCreatedByTenant(TENANT, now - DAY)).toBe(3);
  expect(repo.countOrdersCreatedByTenant(TENANT.toLowerCase(), now - DAY)).toBe(3);
  expect(repo.countOrdersCreatedByTenant(TENANT, now - 2 * DAY)).toBe(4);
  expect(repo.countOrdersCreatedByTenant(TENANT, now + HOUR)).toBe(0);
  expect(repo.countOrdersCreatedByTenant(OTHER_TENANT, now - DAY)).toBe(1);
  expect(repo.countOrdersCreatedByTenant("not an address", now - DAY)).toBe(0);
});

test("countCreatesByTenant and countCreatesSince count deploy submissions in their window; countCreatesSince ignores another factory", () => {
  const now = Date.now();
  const mine = reserved("42");
  repo.recordDeploySubmission(mine, { txHash: H("1"), rawTx: "0x01", nonce: 1 });
  repo.recordDeploySubmission(mine, { txHash: H("2"), rawTx: "0x02", nonce: 2 });
  const theirs = reserved("43", { tenant: OTHER_TENANT });
  repo.recordDeploySubmission(theirs, { txHash: H("3"), rawTx: "0x03", nonce: 3 });
  const mineElsewhere = reserved("44", { factory: OTHER_FACTORY });
  repo.recordDeploySubmission(mineElsewhere, { txHash: H("4"), rawTx: "0x04", nonce: 1 });
  // A submission recorded 25 hours ago, written by raw SQL: an event's time is set at its insert.
  db.prepare(
    `INSERT INTO legal_body_events (legal_body_id, kind, actor, tx_hash, detail, created_at)
     VALUES (?, 'deploy_submitted', 'system', ?, '{"rawTx":"0x05","nonce":0}', ?)`,
  ).run(mine, H("5"), sqliteUtcTimestamp(now - 25 * HOUR));
  // Other events are not creates.
  repo.recordEvent(mine, "note", "system", null, null);

  expect(repo.countCreatesByTenant(TENANT, now - DAY)).toBe(3);
  expect(repo.countCreatesByTenant(TENANT.toLowerCase(), now - DAY)).toBe(3);
  expect(repo.countCreatesByTenant(TENANT, now - 2 * DAY)).toBe(4);
  expect(repo.countCreatesByTenant(TENANT, now + HOUR)).toBe(0);
  expect(repo.countCreatesByTenant(OTHER_TENANT, now - DAY)).toBe(1);
  expect(repo.countCreatesByTenant("not an address", now - DAY)).toBe(0);

  expect(repo.countCreatesSince(D, now - DAY)).toBe(3);
  expect(repo.countCreatesSince(D, now - 2 * DAY)).toBe(4);
  expect(repo.countCreatesSince(D, now + HOUR)).toBe(0);
  expect(repo.countCreatesSince(D_OTHER, now - DAY)).toBe(1);
  expect(repo.countCreatesSince({ chainId: 1, factory: FACTORY }, 0)).toBe(0);
  for (const since of [-1, 0.5, Number.NaN, String(now), null])
    expect(() => repo.countCreatesByTenant(TENANT, as(since)), String(since)).toThrow(
      LegalBodyInputError,
    );
});

test("countEventsByTenant counts one kind of event across the tenant's rows, ever", () => {
  const a = newBody();
  const b = newBody();
  const theirs = newBody({ tenant: OTHER_TENANT });
  repo.recordEvent(a, "gas_seed_requested", "system", null, { amount: "0.05" });
  repo.recordEvent(b, "gas_seed_requested", "system", null, { amount: "0.05" });
  repo.recordEvent(b, "gas_seeded", "system", H("9"), null);
  repo.recordEvent(theirs, "gas_seed_requested", "system", null, null);
  expect(repo.countEventsByTenant(TENANT, "gas_seed_requested")).toBe(2);
  expect(repo.countEventsByTenant(TENANT, "gas_seeded")).toBe(1);
  expect(repo.countEventsByTenant(TENANT, "created")).toBe(2);
  expect(repo.countEventsByTenant(OTHER_TENANT, "gas_seed_requested")).toBe(1);
  expect(repo.countEventsByTenant(OTHER_TENANT, "gas_seeded")).toBe(0);
  expect(repo.countEventsByTenant("not an address", "created")).toBe(0);
});

test("a second tenant cannot record a World nullifier another tenant holds: one human is one tenant", () => {
  const world = new SqliteWorldStore(db);
  const verification = {
    nullifier: "1234",
    action: "guardian-verification",
    issuerSchemaId: 1,
    credential: "proof_of_human",
    environment: "staging",
    verifiedAt: 1_700_000_000,
    expiresAtMin: null,
  };
  expect(world.recordVerification({ ...verification, tenantId: TENANT })).toBe(true);
  expect(world.recordVerification({ ...verification, tenantId: OTHER_TENANT })).toBe(false);
  expect(world.findByNullifier("1234", "guardian-verification")?.tenantId).toBe(TENANT);
  // The table's key holds it, whatever writes the row.
  expect(() =>
    db
      .prepare(
        "INSERT INTO guardian_verifications (nullifier, action, tenant_id, verified_at) VALUES (?, ?, ?, ?)",
      )
      .run("1234", "guardian-verification", OTHER_TENANT, 1_700_000_100),
  ).toThrow(/UNIQUE/);
});
