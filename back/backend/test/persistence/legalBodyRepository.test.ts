import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  LIVE_BINDING_STATES,
  LegalBodyInputError,
  SqliteLegalBodyRepository,
} from "../../src/persistence/legalBodyRepository";

const TENANT = "0x00000000000000000000000000000000000000A1";
const OTHER_TENANT = "0x00000000000000000000000000000000000000A2";
const OWNER = "0x00000000000000000000000000000000000000A3";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const BODY_A = "0x00000000000000000000000000000000000000B1";
const BODY_B = "0x00000000000000000000000000000000000000b2";
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
  const reservedOnly = toReserved("44", "0x00000000000000000000000000000000000000C1");
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

test("recordEvent redacts an SSN-shaped number out of the detail", () => {
  const r = newBody();
  repo.recordEvent(r.legalBodyId, "note", "operator:alice", null, { text: "SSN 123-45-6789" });
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

// ── Malformed input is refused before anything is written ──

/** A value of the wrong type, as a caller without type checking could pass it. */
const as = <T>(value: unknown) => value as T;

test("freezeAgreement answers false for a missing or malformed hash or version: nothing is frozen, nothing logged", () => {
  const r = newBody();
  for (const hash of [
    undefined,
    null,
    "",
    "not hex",
    `0x${"a".repeat(63)}`,
    `0x${"a".repeat(65)}`,
    "a".repeat(66),
    `0X${"a".repeat(64)}`,
    `0x${"a".repeat(63)}g`,
    5,
  ])
    expect(
      repo.freezeAgreement(r.legalBodyId, { hash: as(hash), version: 1 }),
      `hash ${JSON.stringify(hash)}`,
    ).toBe(false);
  for (const version of [0, -1, 1.5, Number.NaN, 2 ** 60, "1", "v1", null, undefined])
    expect(
      repo.freezeAgreement(r.legalBodyId, { hash: H("a"), version: as(version) }),
      `version ${String(version)}`,
    ).toBe(false);
  const row = repo.findById(r.legalBodyId);
  expect(row?.oaManifestHash).toBeNull();
  expect(row?.oaManifestVersion).toBeNull();
  expect(repo.listEvents(r.legalBodyId).map((e) => e.kind)).toEqual(["created"]);
  // The draft is still unfrozen, to every reader.
  expect(repo.reserve(r.legalBodyId, link())).toBe("not_frozen");
});

test("a valid hash in any casing is stored lower-case: the agreement, the link digest, the deploy hash", () => {
  const r = newBody();
  const upper = (c: string) => `0x${c.toUpperCase().repeat(64)}` as `0x${string}`;
  expect(repo.freezeAgreement(r.legalBodyId, { hash: upper("a"), version: 1 })).toBe(true);
  expect(
    repo.reserve(r.legalBodyId, { ...link(), linkDigest: upper("b"), linkSignature: "0xAB01" }),
  ).toBe("reserved");
  expect(
    repo.recordDeploySubmission(r.legalBodyId, { txHash: upper("c"), rawTx: "0x02", nonce: 0 }),
  ).toBe(true);
  expect(repo.findById(r.legalBodyId)?.createTxHash).toBe(H("c"));
  expect(repo.markDeployed(r.legalBodyId, { txHash: upper("d"), deployedAt: 1_800_000_000 })).toBe(
    true,
  );
  const row = repo.findById(r.legalBodyId);
  expect(row?.oaManifestHash).toBe(H("a"));
  expect(row?.linkDigest).toBe(H("b"));
  expect(row?.linkSignature).toBe("0xab01");
  expect(row?.createTxHash).toBe(H("d"));
  expect(
    repo
      .listEvents(r.legalBodyId)
      .filter((e) => e.txHash !== null)
      .map((e) => [e.kind, e.txHash]),
  ).toEqual([
    ["deploy_submitted", H("c")],
    ["deployed", H("d")],
  ]);
});

test("reserve throws a LegalBodyInputError for a malformed link, and writes nothing", () => {
  const r = newBody();
  repo.freezeAgreement(r.legalBodyId, { hash: H("a"), version: 1 });
  const before = { row: repo.findById(r.legalBodyId), events: repo.listEvents(r.legalBodyId) };
  for (const [label, over] of [
    ["digest missing", { linkDigest: undefined }],
    ["digest null", { linkDigest: null }],
    ["digest empty", { linkDigest: "" }],
    ["digest not hex", { linkDigest: "zz" }],
    ["digest 31 bytes", { linkDigest: `0x${"b".repeat(62)}` }],
    ["signature missing", { linkSignature: undefined }],
    ["signature null", { linkSignature: null }],
    ["signature empty", { linkSignature: "" }],
    ["signature 0x and no byte", { linkSignature: "0x" }],
    ["signature half a byte", { linkSignature: "0x1" }],
    ["signature not hex", { linkSignature: "0xzz" }],
    ["deadline 0", { linkDeadline: 0 }],
    ["deadline negative", { linkDeadline: -5 }],
    ["deadline fractional", { linkDeadline: 1.5 }],
    ["deadline NaN", { linkDeadline: Number.NaN }],
    ["deadline as text", { linkDeadline: "1900000000" }],
    ["deadline as a bigint", { linkDeadline: 1_900_000_000n }],
    ["deadline in milliseconds", { linkDeadline: 1_900_000_000_000 }],
    ["deadline 1e20", { linkDeadline: 1e20 }],
    ["agentId not decimal", { agentId: "0x2a" }],
    ["identity owner not an address", { identityOwner: "0x123" }],
    ["body not an address", { bodyAddress: "nope" }],
  ] as const)
    expect(() => repo.reserve(r.legalBodyId, as({ ...link(), ...over })), label).toThrow(
      LegalBodyInputError,
    );
  expect(repo.findById(r.legalBodyId)).toEqual(before.row);
  expect(repo.listEvents(r.legalBodyId)).toEqual(before.events);
  // A caller bug is reported even when the row could not have moved anyway.
  expect(() => repo.reserve("lb_unknown", as({ ...link(), linkDigest: "zz" }))).toThrow(
    LegalBodyInputError,
  );
  // The boundaries of a deadline in seconds are accepted.
  expect(repo.reserve(r.legalBodyId, { ...link(), linkDeadline: 99_999_999_999 })).toBe("reserved");
});

test("a deploy submission and a deploy throw a LegalBodyInputError for malformed facts, and write nothing", () => {
  const id = toReserved();
  const before = { row: repo.findById(id), events: repo.listEvents(id) };
  const submission = { txHash: H("c"), rawTx: "0x02" as `0x${string}`, nonce: 7 };
  for (const [label, over] of [
    ["hash missing", { txHash: undefined }],
    ["hash empty", { txHash: "" }],
    ["hash not hex", { txHash: "0xzz" }],
    ["hash 31 bytes", { txHash: `0x${"c".repeat(62)}` }],
    ["raw transaction missing", { rawTx: undefined }],
    ["raw transaction empty", { rawTx: "" }],
    ["raw transaction 0x and no byte", { rawTx: "0x" }],
    ["raw transaction half a byte", { rawTx: "0x1" }],
    ["raw transaction not hex", { rawTx: "0xzz" }],
    ["nonce negative", { nonce: -1 }],
    ["nonce fractional", { nonce: 1.5 }],
    ["nonce NaN", { nonce: Number.NaN }],
    ["nonce as text", { nonce: "7" }],
    ["nonce as a bigint", { nonce: 7n }],
  ] as const)
    expect(
      () => repo.recordDeploySubmission(id, as({ ...submission, ...over })),
      `submission: ${label}`,
    ).toThrow(LegalBodyInputError);
  for (const [label, d] of [
    ["hash missing", { txHash: undefined, deployedAt: 1_800_000_000 }],
    ["hash not hex", { txHash: "0xzz", deployedAt: 1_800_000_000 }],
    ["time 0", { txHash: H("c"), deployedAt: 0 }],
    ["time negative", { txHash: H("c"), deployedAt: -1 }],
    ["time fractional", { txHash: H("c"), deployedAt: 1_800_000_000.5 }],
    ["time NaN", { txHash: H("c"), deployedAt: Number.NaN }],
    ["time missing", { txHash: H("c"), deployedAt: undefined }],
    ["time in milliseconds", { txHash: H("c"), deployedAt: 1_800_000_000_000 }],
  ] as const)
    expect(() => repo.markDeployed(id, as(d)), `deploy: ${label}`).toThrow(LegalBodyInputError);
  expect(repo.findById(id)).toEqual(before.row);
  expect(repo.listEvents(id)).toEqual(before.events);
  // Nonce 0 is a first transaction, and it is accepted.
  expect(repo.recordDeploySubmission(id, { ...submission, nonce: 0 })).toBe(true);
});

test("create throws a LegalBodyInputError for a chain id or an address no row may hold, and writes nothing", () => {
  const valid = {
    tenantId: TENANT as `0x${string}`,
    companyId: "co_1",
    chainId: 5042002,
    factory: FACTORY as `0x${string}`,
    amendmentDelay: 172800,
  };
  for (const [label, over] of [
    ["chain id 0", { chainId: 0 }],
    ["chain id negative", { chainId: -1 }],
    ["chain id fractional", { chainId: 1.5 }],
    ["chain id NaN", { chainId: Number.NaN }],
    ["chain id as text", { chainId: "5042002" }],
    ["chain id missing", { chainId: undefined }],
    ["tenant not an address", { tenantId: "0x123" }],
    ["tenant missing", { tenantId: undefined }],
    ["factory not an address", { factory: "nope" }],
    ["factory missing", { factory: undefined }],
    ["amendment delay as text", { amendmentDelay: "172800" }],
  ] as const)
    expect(() => repo.create(as({ ...valid, ...over })), label).toThrow(LegalBodyInputError);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_body_events").get()).toEqual({ n: 0 });
  expect(repo.create({ ...valid, chainId: 1 }).chainId).toBe(1);
});

test("reserve answers body_taken when the recorded address differs only in casing", () => {
  // The repository writes the checksummed form, so another casing can only come from raw SQL.
  const raw = newBody();
  repo.freezeAgreement(raw.legalBodyId, { hash: H("a"), version: 1 });
  db.prepare(
    `UPDATE legal_bodies SET agent_id = '43', identity_owner = ?, link_digest = ?,
       link_deadline = 1900000000, link_signature = '0x01', body_address = ?,
       binding_state = 'reserved' WHERE legal_body_id = ?`,
  ).run(OWNER, H("b"), BODY_A.toLowerCase(), raw.legalBodyId);
  const b = newBody();
  repo.freezeAgreement(b.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.reserve(b.legalBodyId, link("44", BODY_A))).toBe("body_taken");
  expect(repo.findById(b.legalBodyId)?.bindingState).toBe("draft");
});

test("abandon closes a draft, frozen or not, with its reason in the log; and only a draft", () => {
  for (const frozen of [false, true]) {
    const r = newBody();
    if (frozen) repo.freezeAgreement(r.legalBodyId, { hash: H("a"), version: 1 });
    expect(repo.abandon(r.legalBodyId, "ordered under the wrong company")).toBe(true);
    expect(repo.findById(r.legalBodyId)?.bindingState).toBe("abandoned");
    const last = repo.listEvents(r.legalBodyId).at(-1);
    expect(last?.kind).toBe("abandoned");
    expect(last?.actor).toBe("system");
    expect(last?.detail).toEqual({ reason: "ordered under the wrong company" });
    // Compare-and-set: a second call made no move, and records nothing.
    const events = repo.listEvents(r.legalBodyId);
    expect(repo.abandon(r.legalBodyId, "again")).toBe(false);
    expect(repo.listEvents(r.legalBodyId)).toEqual(events);
  }
  const reserved = toReserved("42", BODY_A);
  expect(repo.abandon(reserved, "too late")).toBe(false);
  expect(repo.findById(reserved)?.bindingState).toBe("reserved");
  expect(repo.abandon("lb_unknown", "no such body")).toBe(false);
});

test("abandoned is terminal: no method moves the row again, and it holds nothing", () => {
  const r = newBody();
  repo.freezeAgreement(r.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.abandon(r.legalBodyId, "never signed")).toBe(true);
  const events = repo.listEvents(r.legalBodyId);
  expect(repo.freezeAgreement(r.legalBodyId, { hash: H("d"), version: 2 })).toBe(false);
  expect(repo.reserve(r.legalBodyId, link("42", BODY_A))).toBe("not_draft");
  expect(
    repo.recordDeploySubmission(r.legalBodyId, { txHash: H("c"), rawTx: "0x02", nonce: 1 }),
  ).toBe(false);
  expect(repo.markDeployed(r.legalBodyId, { txHash: H("c"), deployedAt: 1_800_000_000 })).toBe(
    false,
  );
  expect(repo.lapse(r.legalBodyId, "x")).toBe(false);
  expect(repo.markLinked(r.legalBodyId, 1_800_000_100)).toBe(false);
  expect(repo.markBroken(r.legalBodyId, {})).toBe(false);
  expect(repo.supersede(r.legalBodyId, "lb_other")).toBe(false);
  expect(repo.findById(r.legalBodyId)?.bindingState).toBe("abandoned");
  expect(repo.listEvents(r.legalBodyId)).toEqual(events);
  // The agentId and the body address it never held are free for a real order.
  expect(toReserved("42", BODY_A)).toMatch(/^lb_/);
});

test("a superseded body can be linked again: the chain, not this table, decides which body is named", () => {
  // The old body is set aside for a newer one; its owner then names the old one again on chain.
  const old = toDeployed("42", BODY_A);
  expect(repo.markLinked(old, 1_800_000_100)).toBe(true);
  expect(repo.markBroken(old, { why: "pointer cleared" })).toBe(true);
  const newer = toDeployed("43", BODY_B);
  expect(repo.supersede(old, newer)).toBe(true);
  expect(repo.findLiveByAgentId(5042002, "42")).toBeUndefined();
  // The agentId is free, so the cached state follows the chain.
  expect(repo.markLinked(old, 1_800_000_200)).toBe(true);
  const row = repo.findById(old);
  expect(row?.bindingState).toBe("linked");
  expect(row?.pointerSeenAt).toBe(1_800_000_200);
  expect(repo.findLiveByAgentId(5042002, "42")?.legalBodyId).toBe(old);
  expect(repo.listEvents(old).map((e) => e.kind)).toEqual([
    "created",
    "agreement_frozen",
    "link_accepted",
    "deployed",
    "linked",
    "broken",
    "superseded",
    "linked",
  ]);
  expect(repo.listEvents(old).at(-1)?.detail).toEqual({ seenAt: 1_800_000_200 });
});

test("a superseded body is not linked again while another body holds its agentId live", () => {
  const old = toDeployed("42", BODY_A);
  const replacement = newBody();
  repo.freezeAgreement(replacement.legalBodyId, { hash: H("a"), version: 1 });
  expect(repo.supersede(old, replacement.legalBodyId)).toBe(true);
  expect(repo.reserve(replacement.legalBodyId, link("42", BODY_B))).toBe("reserved");
  const before = { row: repo.findById(old), events: repo.listEvents(old) };
  expect(repo.markLinked(old, 1_800_000_200)).toBe(false);
  expect(repo.findById(old)).toEqual(before.row);
  expect(repo.listEvents(old)).toEqual(before.events);
  // Once the replacement gives the agentId up, the old body can follow the chain again.
  expect(repo.lapse(replacement.legalBodyId, "deadline passed")).toBe(true);
  expect(repo.markLinked(old, 1_800_000_300)).toBe(true);
});

// ── The check schedule ──

const scheduleOf = (id: string) => {
  const r = repo.findById(id);
  return [r?.nextBindingCheckAt, r?.bindingCheckIntervalMs];
};

test("scheduleBindingCheck takes a time and an interval together, or null and null, and nothing else", () => {
  const id = toDeployed();
  expect(repo.scheduleBindingCheck(id, 1_000, 60_000)).toBe(true);
  for (const [nextAt, intervalMs] of [
    [1_000, null],
    [null, 60_000],
    [-1, 60_000],
    [1_000, 0],
    [1_000, -1],
    [1.5, 1],
    [1, 1.5],
    // A NaN out of a caller's arithmetic must not quietly take the row off the schedule.
    [Number.NaN, 60_000],
    [60_000, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
    [1e20, 1],
    ["1000", "5"],
    [1_000n, 5n],
    [undefined, undefined],
    [undefined, 60_000],
  ])
    expect(
      () => repo.scheduleBindingCheck(id, as(nextAt), as(intervalMs)),
      `${String(nextAt)}, ${String(intervalMs)}`,
    ).toThrow(LegalBodyInputError);
  expect(scheduleOf(id)).toEqual([1_000, 60_000]);
  // Time zero and the shortest interval are the boundaries, and null with null clears.
  expect(repo.scheduleBindingCheck(id, 0, 1)).toBe(true);
  expect(scheduleOf(id)).toEqual([0, 1]);
  expect(repo.scheduleBindingCheck(id, null, null)).toBe(true);
  expect(scheduleOf(id)).toEqual([null, null]);
});

test("scheduleBindingCheck says whether it scheduled a row: never a draft, an abandoned or a lapsed one", () => {
  expect(repo.scheduleBindingCheck("lb_unknown", 1_000, 60_000)).toBe(false);
  const draft = newBody().legalBodyId;
  const abandoned = newBody().legalBodyId;
  repo.abandon(abandoned, "never signed");
  const lapsed = toReserved("41", "0x00000000000000000000000000000000000000C1");
  repo.lapse(lapsed, "deadline passed");
  for (const id of [draft, abandoned, lapsed]) {
    expect(repo.scheduleBindingCheck(id, 1_000, 60_000), repo.findById(id)?.bindingState).toBe(
      false,
    );
    expect(scheduleOf(id)).toEqual([null, null]);
  }
  expect(repo.listBindingDue(9_000, 10)).toEqual([]);
  // Every state a body can still be checked in takes a schedule.
  const id = toReserved("42", BODY_A);
  const states: string[] = [];
  const scheduled = () => {
    states.push(repo.findById(id)?.bindingState ?? "?");
    return repo.scheduleBindingCheck(id, 1_000 + states.length, 60_000);
  };
  expect(scheduled()).toBe(true);
  repo.markDeployed(id, { txHash: H("c"), deployedAt: 1_800_000_000 });
  expect(scheduled()).toBe(true);
  repo.markLinked(id, 1_800_000_100);
  expect(scheduled()).toBe(true);
  repo.markBroken(id, { why: "pointer cleared" });
  expect(scheduled()).toBe(true);
  repo.supersede(id, "lb_other");
  expect(scheduled()).toBe(true);
  expect(states).toEqual(["reserved", "deployed", "linked", "broken", "superseded"]);
  expect(repo.listBindingDue(9_000, 10).map((r) => r.legalBodyId)).toEqual([id]);
  // Scheduling is not a state change: it leaves no event.
  expect(repo.listEvents(id).map((e) => e.kind)).toEqual([
    "created",
    "agreement_frozen",
    "link_accepted",
    "deployed",
    "linked",
    "broken",
    "superseded",
  ]);
});

test("listBindingDue takes a time of zero or more and a limit of one or more, and nothing else", () => {
  const a = toDeployed("42", BODY_A);
  const b = toDeployed("43", BODY_B);
  repo.scheduleBindingCheck(a, 1_000, 60_000);
  repo.scheduleBindingCheck(b, 1_000, 60_000);
  // A negative limit would otherwise mean "no limit" to SQLite.
  for (const limit of [
    0,
    -1,
    -5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
    "2",
    2n,
  ])
    expect(() => repo.listBindingDue(9_000, as(limit)), `limit ${String(limit)}`).toThrow(
      LegalBodyInputError,
    );
  for (const now of [
    -1,
    9_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
    "9000",
    9_000n,
  ])
    expect(() => repo.listBindingDue(as(now), 10), `now ${String(now)}`).toThrow(
      LegalBodyInputError,
    );
  expect(repo.listBindingDue(0, 10)).toEqual([]);
  // Due at exactly `now` counts; ties are broken by id; the limit cuts.
  expect(repo.listBindingDue(1_000, 10).map((r) => r.legalBodyId)).toEqual([a, b].sort());
  expect(repo.listBindingDue(999, 10)).toEqual([]);
  expect(repo.listBindingDue(1_000, 1).map((r) => r.legalBodyId)).toEqual([[a, b].sort()[0]]);
});

// ── Event detail written by chain code ──

test("a bigint in event detail is stored as a number when it is exact, and refused when it is not", () => {
  // Chain libraries return block numbers as bigint.
  const r = newBody();
  repo.recordEvent(r.legalBodyId, "note", "system", null, {
    observedAtBlock: 123_456_789n,
    nested: { list: [1n, -2n, 0n] },
    largest: BigInt(Number.MAX_SAFE_INTEGER),
  });
  expect(storedDetail(r.legalBodyId)).toBe(
    `{"observedAtBlock":123456789,"nested":{"list":[1,-2,0]},"largest":${Number.MAX_SAFE_INTEGER}}`,
  );
  expect(repo.listEvents(r.legalBodyId).at(-1)?.detail).toEqual({
    observedAtBlock: 123456789,
    nested: { list: [1, -2, 0] },
    largest: Number.MAX_SAFE_INTEGER,
  });
  const events = repo.listEvents(r.legalBodyId);
  for (const unsafe of [2n ** 53n, -(2n ** 53n), 2n ** 256n - 1n])
    expect(
      () => repo.recordEvent(r.legalBodyId, "note", "system", null, { nested: [{ wei: unsafe }] }),
      String(unsafe),
    ).toThrow(LegalBodyInputError);
  expect(repo.listEvents(r.legalBodyId)).toEqual(events);
});

test("a move whose detail cannot be stored is rolled back together with its event", () => {
  const id = toDeployed();
  expect(repo.markLinked(id, 1_800_000_100)).toBe(true);
  const before = { row: repo.findById(id), events: repo.listEvents(id) };
  expect(() => repo.markBroken(id, { observedAtBlock: 2n ** 60n })).toThrow(LegalBodyInputError);
  expect(repo.findById(id)).toEqual(before.row);
  expect(repo.listEvents(id)).toEqual(before.events);
  // The same move with a block number that is exact goes through.
  expect(repo.markBroken(id, { observedAtBlock: 100_000_001n })).toBe(true);
  expect(repo.listEvents(id).at(-1)?.detail).toEqual({ observedAtBlock: 100000001 });
});

test("the redactor reads 0x and exactly nine decimal digits as SSN-shaped; longer hex is untouched", () => {
  const r = newBody();
  repo.recordEvent(r.legalBodyId, "note", "system", null, {
    shortHex: "0x123456789",
    hash: H("1"),
    address: BODY_A,
    asNumber: 0x123456789,
  });
  expect(repo.listEvents(r.legalBodyId).at(-1)?.detail).toEqual({
    shortHex: "0x[redacted]",
    hash: H("1"),
    address: BODY_A,
    asNumber: 0x123456789,
  });
});

test("findByBodyAddress finds a row whatever the casing it was stored in, as the unique index sees it", () => {
  // The repository writes the checksummed form; another casing can only come from raw SQL. The
  // index that makes the address unique compares its lower-case form, and so must the lookup:
  // otherwise reserve would answer body_taken for an address the lookup says nobody holds.
  const raw = newBody();
  repo.freezeAgreement(raw.legalBodyId, { hash: H("a"), version: 1 });
  db.prepare(
    `UPDATE legal_bodies SET agent_id = '43', identity_owner = ?, link_digest = ?,
       link_deadline = 1900000000, link_signature = '0x01', body_address = ?,
       binding_state = 'reserved' WHERE legal_body_id = ?`,
  ).run(OWNER, H("b"), BODY_A.toLowerCase(), raw.legalBodyId);
  for (const spelling of [BODY_A, BODY_A.toLowerCase(), `0x${BODY_A.slice(2).toUpperCase()}`])
    expect(repo.findByBodyAddress(5042002, spelling as `0x${string}`)?.legalBodyId, spelling).toBe(
      raw.legalBodyId,
    );
  // Still per chain, and still nothing for another address or for a value that is not one.
  expect(repo.findByBodyAddress(1, BODY_A)).toBeUndefined();
  expect(repo.findByBodyAddress(5042002, BODY_B)).toBeUndefined();
  expect(repo.findByBodyAddress(5042002, "nope" as `0x${string}`)).toBeUndefined();
});

// ── transaction(): a unit of several reads and writes ──

test("transaction() holds the write lock from its first statement: a unit that reads, then moves, is not overtaken", () => {
  // Two connections to one database file stand for two processes. With a lock taken only at the
  // first WRITE, another writer could commit between this unit's read and its move, and the move
  // would then fail at once: its snapshot is stale, and no wait can make it current again.
  const dir = mkdtempSync(join(tmpdir(), "legal-body-tx-"));
  const path = join(dir, "bodies.db");
  const connections: Database.Database[] = [];
  try {
    const first = openDatabase(path);
    connections.push(first);
    migrate(first);
    first
      .prepare(
        `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
         VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Acme LLC"]', 'existing', 'existing')`,
      )
      .run(TENANT);
    // The other writer does not wait for a lock: in one thread, nobody could release it meanwhile.
    const second = new Database(path, { timeout: 0 });
    connections.push(second);
    const unit = new SqliteLegalBodyRepository(first);
    const other = new SqliteLegalBodyRepository(second);
    const deployed = (agentId: string, body: string) => {
      const r = unit.create({
        tenantId: TENANT,
        companyId: "co_1",
        chainId: 5042002,
        factory: FACTORY,
        amendmentDelay: 172800,
      });
      unit.freezeAgreement(r.legalBodyId, { hash: H("a"), version: 1 });
      unit.reserve(r.legalBodyId, link(agentId, body));
      unit.markDeployed(r.legalBodyId, { txHash: H("c"), deployedAt: 1_800_000_000 });
      return r.legalBodyId;
    };
    const x = deployed("42", BODY_A);
    const y = deployed("43", BODY_B);

    let otherWriter = "did not run";
    const result = unit.transaction(() => {
      const seen = unit.findById(x)?.bindingState; // the unit reads first, to decide what to do
      try {
        other.scheduleBindingCheck(y, 1_000, 60_000); // another writer, in the middle of the unit
        otherWriter = "committed";
      } catch (e) {
        otherWriter = (e as { code?: string }).code ?? String(e);
      }
      return [seen, unit.markLinked(x, 1_800_000_100)]; // then the unit moves
    });
    expect(result).toEqual(["deployed", true]);
    // The other writer had to wait its turn, and takes it once the unit is done.
    expect(otherWriter).toBe("SQLITE_BUSY");
    expect(other.scheduleBindingCheck(y, 1_000, 60_000)).toBe(true);
    expect(other.findById(x)?.bindingState).toBe("linked");
  } finally {
    for (const c of connections) c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nested transaction() calls are savepoints: an inner failure undoes the inner unit only", () => {
  const id = toDeployed();
  repo.transaction(() => {
    expect(repo.markLinked(id, 1_800_000_100)).toBe(true);
    expect(() =>
      repo.transaction(() => {
        repo.markBroken(id, { why: "undone below" });
        throw new Error("inner unit failed");
      }),
    ).toThrow("inner unit failed");
    expect(repo.findById(id)?.bindingState).toBe("linked");
  });
  expect(repo.findById(id)?.bindingState).toBe("linked");
  expect(repo.listEvents(id).map((e) => e.kind)).toEqual([
    "created",
    "agreement_frozen",
    "link_accepted",
    "deployed",
    "linked",
  ]);
  // An outer failure undoes everything inside it, nested units included.
  expect(() =>
    repo.transaction(() => {
      repo.markBroken(id, { why: "undone below" });
      repo.transaction(() => repo.scheduleBindingCheck(id, 1_000, 60_000));
      throw new Error("outer unit failed");
    }),
  ).toThrow("outer unit failed");
  expect(repo.findById(id)?.bindingState).toBe("linked");
  expect(repo.findById(id)?.nextBindingCheckAt).toBeNull();
  expect(db.inTransaction).toBe(false);
});
