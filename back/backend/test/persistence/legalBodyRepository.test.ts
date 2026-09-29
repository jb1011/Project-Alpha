import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import {
  LIVE_BINDING_STATES,
  SqliteLegalBodyRepository,
} from "../../src/persistence/legalBodyRepository";

const TENANT = "0x172B7952b0F711b8B372410E81d51Dcba7D4BB02";
const OTHER_TENANT = "0x26b2f179Db35D912C141A71de547d21bF8665D0E";
const OWNER = "0x48191Ac42649274C4b3cbeBd16a76B8178e6F6e0";
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456";
const BODY_A = "0x079cE31a43867Bcb4DBF80764c1da9c32515BfD4";
const BODY_B = "0x01392702dA9487a1E3B49BeC9c6Fb1DD676fF6F1";
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

let db: Database.Database;
let repo: SqliteLegalBodyRepository;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  for (const [id, t] of [
    ["co_1", TENANT],
    ["co_2", OTHER_TENANT],
  ] as const)
    db.prepare(
      `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
       VALUES (?, ?, 'ready', 'customer', 'sandbox', '["Acme LLC"]', 'existing', 'existing')`,
    ).run(id, t);
  repo = new SqliteLegalBodyRepository(db);
});

const newBody = (tenant = TENANT, company = "co_1") =>
  repo.create({
    tenantId: tenant as `0x${string}`,
    companyId: company,
    chainId: 5042002,
    factory: FACTORY,
    amendmentDelay: 172800,
  });
const link = (agentId = "42", body = BODY_A) => ({
  agentId,
  identityOwner: OWNER as `0x${string}`,
  linkDigest: H("b"),
  linkDeadline: 1_900_000_000,
  linkSignature: "0x01" as `0x${string}`,
  bodyAddress: body as `0x${string}`,
});
const toReserved = (agentId = "42", body = BODY_A) => {
  const r = newBody();
  expect(repo.freezeAgreement(r.legalBodyId, { hash: H("a"), version: 1 })).toBe(true);
  expect(repo.reserve(r.legalBodyId, link(agentId, body))).toBe("reserved");
  return r.legalBodyId;
};
const toDeployed = (agentId = "42", body = BODY_A) => {
  const id = toReserved(agentId, body);
  expect(repo.markDeployed(id, { txHash: H("c"), deployedAt: 1_800_000_000 })).toBe(true);
  return id;
};

test("create: ids, guardian = tenant, draft, and a 'created' event in the same write", () => {
  const r = newBody();
  expect(r.legalBodyId).toMatch(/^lb_[0-9a-f-]{36}$/);
  expect(r.publicId).toMatch(/^[0-9a-f-]{36}$/);
  expect(r.guardian).toBe(TENANT);
  expect(r.bindingState).toBe("draft");
  expect(repo.listEvents(r.legalBodyId).map((e) => e.kind)).toEqual(["created"]);
});

test("create checksums the tenant", () => {
  const r = newBody(TENANT.toLowerCase());
  expect(r.tenantId).toBe(TENANT);
  expect(r.guardian).toBe(TENANT);
});

test("findOwned is tenant-scoped: another tenant sees nothing", () => {
  const r = newBody();
  expect(repo.findOwned(TENANT, r.legalBodyId)?.legalBodyId).toBe(r.legalBodyId);
  expect(repo.findOwned(OTHER_TENANT, r.legalBodyId)).toBeUndefined();
});

test("freezeAgreement only once, only in draft", () => {
  const r = newBody();
  expect(repo.freezeAgreement(r.legalBodyId, { hash: H("a"), version: 1 })).toBe(true);
  expect(repo.freezeAgreement(r.legalBodyId, { hash: H("d"), version: 2 })).toBe(false);
  expect(repo.findById(r.legalBodyId)?.oaManifestHash).toBe(H("a"));
});

test("reserve refuses before the agreement is frozen", () => {
  const r = newBody();
  expect(repo.reserve(r.legalBodyId, link())).toBe("not_frozen");
});

test("test_reserve_secondLiveReservationForSameAgentIsRefused", () => {
  toReserved("42", BODY_A);
  const b = newBody();
  repo.freezeAgreement(b.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.reserve(b.legalBodyId, link("42", BODY_B))).toBe("agent_taken");
  expect(repo.findById(b.legalBodyId)?.bindingState).toBe("draft");
});

test("reserve refuses a body address already recorded", () => {
  const a = toReserved("42", BODY_A);
  repo.lapse(a, "deadline passed");
  const b = newBody();
  repo.freezeAgreement(b.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.reserve(b.legalBodyId, link("43", BODY_A))).toBe("body_taken");
});

test("reserve twice is not_draft; the first link stands", () => {
  const id = toReserved("42", BODY_A);
  expect(repo.reserve(id, link("43", BODY_B))).toBe("not_draft");
  expect(repo.findById(id)?.agentId).toBe("42");
});

test("findLiveByAgentId sees only live states, per chain", () => {
  const id = toReserved("42");
  expect(repo.findLiveByAgentId(5042002, "42")?.legalBodyId).toBe(id);
  expect(repo.findLiveByAgentId(1, "42")).toBeUndefined();
  repo.lapse(id, "deadline passed");
  expect(repo.findLiveByAgentId(5042002, "42")).toBeUndefined();
  expect(LIVE_BINDING_STATES).toEqual(["reserved", "deployed", "linked"]);
});

test("deploy submission is recorded with its raw transaction while reserved only", () => {
  const id = toReserved();
  expect(repo.recordDeploySubmission(id, { txHash: H("c"), rawTx: "0x02", nonce: 7 })).toBe(true);
  const ev = repo.listEvents(id).find((e) => e.kind === "deploy_submitted");
  expect(ev?.txHash).toBe(H("c"));
  expect(ev?.detail).toEqual({ rawTx: "0x02", nonce: 7 });
  repo.markDeployed(id, { txHash: H("c"), deployedAt: 1_800_000_000 });
  expect(repo.recordDeploySubmission(id, { txHash: H("e"), rawTx: "0x03", nonce: 8 })).toBe(false);
});

test("the binding transitions are compare-and-set", () => {
  const id = toDeployed();
  expect(repo.markBroken(id, { why: "never linked" })).toBe(false); // deployed -> broken is not legal
  expect(repo.markLinked(id, 1_800_000_100)).toBe(true);
  expect(repo.markLinked(id, 1_800_000_200)).toBe(false); // already linked
  expect(repo.markBroken(id, { why: "pointer cleared" })).toBe(true);
  expect(repo.markLinked(id, 1_800_000_300)).toBe(true); // re-pointed
  expect(repo.findById(id)?.pointerSeenAt).toBe(1_800_000_300);
  expect(repo.listEvents(id).map((e) => e.kind)).toEqual([
    "created",
    "agreement_frozen",
    "link_accepted",
    "deployed",
    "linked",
    "broken",
    "linked",
  ]);
});

test("supersede frees the agentId for a new link, only from deployed or broken", () => {
  const first = toDeployed("42", BODY_A);
  const second = newBody();
  repo.freezeAgreement(second.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.reserve(second.legalBodyId, link("42", BODY_B))).toBe("agent_taken");
  expect(repo.supersede(first, second.legalBodyId)).toBe(true);
  expect(repo.reserve(second.legalBodyId, link("42", BODY_B))).toBe("reserved");
  const reservedOnly = toReserved("44", "0x000000000000000000000000000000000000dEaD");
  expect(repo.supersede(reservedOnly, second.legalBodyId)).toBe(false);
});

test("lapse only from reserved", () => {
  const id = toReserved();
  expect(repo.lapse(id, "deadline passed")).toBe(true);
  expect(repo.lapse(id, "again")).toBe(false);
  expect(repo.findById(id)?.bindingState).toBe("lapsed");
});

test("binding checks: schedule and due listing", () => {
  const a = toDeployed("42", BODY_A);
  const b = toDeployed("43", BODY_B);
  repo.scheduleBindingCheck(a, 1_000, 60_000);
  repo.scheduleBindingCheck(b, 5_000, 60_000);
  expect(repo.listBindingDue(2_000, 10).map((r) => r.legalBodyId)).toEqual([a]);
  expect(repo.listBindingDue(9_000, 10).map((r) => r.legalBodyId)).toEqual([a, b]);
  expect(repo.listBindingDue(9_000, 1)).toHaveLength(1);
  repo.scheduleBindingCheck(a, null, null);
  expect(repo.listBindingDue(9_000, 10).map((r) => r.legalBodyId)).toEqual([b]);
});

test("test_recordEvent_redactsPii", () => {
  const r = newBody();
  repo.recordEvent(r.legalBodyId, "note", "operator:martin", null, { text: "SSN 123-45-6789" });
  const ev = repo.listEvents(r.legalBodyId).at(-1);
  expect(JSON.stringify(ev?.detail)).not.toContain("123-45-6789");
});

test("lookups by address are case-insensitive through checksumming", () => {
  const id = toReserved("42", BODY_A);
  expect(repo.findByBodyAddress(5042002, BODY_A.toLowerCase() as `0x${string}`)?.legalBodyId).toBe(
    id,
  );
});

test("listByTenant is newest first and tenant-scoped", () => {
  const a = newBody();
  const b = newBody();
  newBody(OTHER_TENANT, "co_2");
  // The exact order. Both rows almost always share a created_at second, so this also pins the
  // rowid DESC tie-break (and listByCompany keeps the same order).
  expect(repo.listByTenant(TENANT).map((r) => r.legalBodyId)).toEqual([
    b.legalBodyId,
    a.legalBodyId,
  ]);
  expect(repo.listByCompany("co_1").map((r) => r.legalBodyId)).toEqual([
    b.legalBodyId,
    a.legalBodyId,
  ]);
});

test("a second order whose link collides on BOTH the agentId and the body address is agent_taken", () => {
  // The body address is derived from the link digest, and one tenant ordering twice with the same
  // agreement and deadline signs the same digest: the write then breaks both unique indexes, and
  // SQLite names only one of them. A live holder of the agentId is the answer that matters.
  toReserved("42", BODY_A);
  const b = newBody();
  repo.freezeAgreement(b.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.reserve(b.legalBodyId, link("42", BODY_A))).toBe("agent_taken");
  expect(repo.findById(b.legalBodyId)?.bindingState).toBe("draft");
  expect(repo.listEvents(b.legalBodyId).map((e) => e.kind)).toEqual([
    "created",
    "agreement_frozen",
  ]);
});

test("an agentId has one spelling: leading zeros are normalized, anything else is refused", () => {
  const id = toReserved("007");
  expect(repo.findById(id)?.agentId).toBe("7");
  expect(repo.findLiveByAgentId(5042002, "0007")?.legalBodyId).toBe(id);
  const b = newBody();
  repo.freezeAgreement(b.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.reserve(b.legalBodyId, link("07", BODY_B))).toBe("agent_taken");
  for (const bad of ["", " 7", "0x07", "-7", "7.0", "7e0", (2n ** 256n).toString()])
    expect(() => repo.reserve(b.legalBodyId, link(bad, BODY_B)), JSON.stringify(bad)).toThrow(
      /agentId/,
    );
  expect(repo.findLiveByAgentId(5042002, "0x07")).toBeUndefined();
  expect(repo.findById(b.legalBodyId)?.bindingState).toBe("draft");
});

test("a detail written by raw SQL that is not JSON reads back as text instead of throwing", () => {
  // recordEvent always writes valid JSON; this is the defence against a row written around it.
  const r = newBody();
  db.prepare(
    "INSERT INTO legal_body_events (legal_body_id, kind, actor, detail) VALUES (?, 'note', 'system', ?)",
  ).run(r.legalBodyId, '{"block":[redacted]}');
  expect(repo.listEvents(r.legalBodyId).at(-1)?.detail).toBe('{"block":[redacted]}');
});

const storedDetail = (legalBodyId: string) =>
  (
    db
      .prepare("SELECT detail FROM legal_body_events WHERE legal_body_id = ? ORDER BY id DESC")
      .get(legalBodyId) as { detail: string }
  ).detail;

test("event detail keeps every number exactly: redaction touches strings only", () => {
  // A nine-digit NUMBER is SSN-shaped to the redactor, and Arc block numbers pass 100,000,000:
  // redacting the serialized blob would destroy them, and leave text that is no longer JSON.
  const r = newBody();
  const detail = { nonce: 123456789, observedAtBlock: 100000001, amount: 150000000 };
  repo.recordEvent(r.legalBodyId, "note", "system", null, detail);
  expect(repo.listEvents(r.legalBodyId).at(-1)?.detail).toEqual(detail);
  expect(JSON.parse(storedDetail(r.legalBodyId))).toEqual(detail);
});

test("event detail redacts every string, however deeply nested, and keys too", () => {
  const r = newBody();
  repo.recordEvent(r.legalBodyId, "note", "operator:x", null, { text: "SSN 123-45-6789" });
  expect(repo.listEvents(r.legalBodyId).at(-1)?.detail).toEqual({ text: "SSN [redacted]" });
  repo.recordEvent(r.legalBodyId, "note", "operator:x", null, {
    a: { b: ["123-45-6789", 123456789, true, null] },
  });
  expect(repo.listEvents(r.legalBodyId).at(-1)?.detail).toEqual({
    a: { b: ["[redacted]", 123456789, true, null] },
  });
  // A key is text the redactor must see as well: the whole-blob redaction this replaces did.
  repo.recordEvent(r.legalBodyId, "note", "operator:x", null, { "123-45-6789": "on file" });
  expect(repo.listEvents(r.legalBodyId).at(-1)?.detail).toEqual({ "[redacted]": "on file" });
  expect(storedDetail(r.legalBodyId)).not.toContain("6789");
  // Every stored detail parses: nothing recordEvent writes needs the text fallback.
  const raw = db.prepare("SELECT detail FROM legal_body_events WHERE detail IS NOT NULL").all() as {
    detail: string;
  }[];
  for (const { detail } of raw) expect(() => JSON.parse(detail), detail).not.toThrow();
});

test("markLinked answers false, and records nothing, when another body holds the agentId live", () => {
  // `broken` is not a live state, so a new body can reserve the agentId in the meantime; when the
  // pointer then comes back to the old body, re-linking it would break the one-live-body index.
  const old = toDeployed("42", BODY_A);
  expect(repo.markLinked(old, 1_800_000_100)).toBe(true);
  expect(repo.markBroken(old, { why: "pointer cleared" })).toBe(true);
  const fresh = newBody();
  repo.freezeAgreement(fresh.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.reserve(fresh.legalBodyId, link("42", BODY_B))).toBe("reserved");
  const eventsBefore = repo.listEvents(old);
  expect(repo.markLinked(old, 1_800_000_200)).toBe(false);
  expect(repo.findById(old)?.bindingState).toBe("broken");
  expect(repo.findById(old)?.pointerSeenAt).toBe(1_800_000_100);
  expect(repo.listEvents(old)).toEqual(eventsBefore);
  // Only that collision is an answer: any other refusal still throws.
  expect(() => repo.markLinked(old, 1.5)).toThrow(/CHECK/);
});

test("a deploy re-sent while reserved keeps every submission; the landed hash is then locked", () => {
  const id = toReserved();
  expect(repo.recordDeploySubmission(id, { txHash: H("1"), rawTx: "0x01", nonce: 7 })).toBe(true);
  expect(repo.recordDeploySubmission(id, { txHash: H("2"), rawTx: "0x02", nonce: 8 })).toBe(true);
  expect(repo.findById(id)?.createTxHash).toBe(H("2"));
  expect(
    repo
      .listEvents(id)
      .filter((e) => e.kind === "deploy_submitted")
      .map((e) => e.txHash),
  ).toEqual([H("1"), H("2")]);
  expect(repo.markDeployed(id, { txHash: H("2"), deployedAt: 1_800_000_000 })).toBe(true);
  expect(() =>
    db
      .prepare("UPDATE legal_bodies SET create_tx_hash = ? WHERE legal_body_id = ?")
      .run(H("9"), id),
  ).toThrow(/write-once/);
});

test("create refuses a fractional amendment delay before writing anything", () => {
  for (const amendmentDelay of [172800.5, Number.NaN])
    expect(
      () =>
        repo.create({
          tenantId: TENANT,
          companyId: "co_1",
          chainId: 5042002,
          factory: FACTORY,
          amendmentDelay,
        }),
      String(amendmentDelay),
    ).toThrow(/amendmentDelay/);
  expect(repo.listByTenant(TENANT)).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_body_events").get()).toEqual({ n: 0 });
});

test("create refuses a company that belongs to another tenant, and writes nothing", () => {
  expect(() => newBody(TENANT, "co_2")).toThrow(/another tenant/);
  expect(repo.listByCompany("co_2")).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_body_events").get()).toEqual({ n: 0 });
});

test("a raw event with a non-positive id is refused, and every later write still appends", () => {
  const r = newBody();
  expect(() =>
    db
      .prepare(
        "INSERT INTO legal_body_events (id, legal_body_id, kind, actor) VALUES (-1, ?, 'note', 'operator:x')",
      )
      .run(r.legalBodyId),
  ).toThrow(/CHECK/);
  expect(repo.freezeAgreement(r.legalBodyId, { hash: H("a"), version: 1 })).toBe(true);
  repo.recordEvent(r.legalBodyId, "note", "system", null, null);
  expect(newBody().bindingState).toBe("draft");
  expect(repo.listEvents(r.legalBodyId).map((e) => e.kind)).toEqual([
    "created",
    "agreement_frozen",
    "note",
  ]);
});

test("freezeAgreement refuses a version that is not a whole number, before writing", () => {
  const r = newBody();
  for (const version of [1.5, "v1" as unknown as number])
    expect(
      () => repo.freezeAgreement(r.legalBodyId, { hash: H("a"), version }),
      String(version),
    ).toThrow(/version/);
  expect(repo.findById(r.legalBodyId)?.oaManifestHash).toBeNull();
  expect(repo.listEvents(r.legalBodyId).map((e) => e.kind)).toEqual(["created"]);
});
