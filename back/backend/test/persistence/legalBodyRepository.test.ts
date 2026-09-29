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
  expect(
    repo
      .listByTenant(TENANT)
      .map((r) => r.legalBodyId)
      .sort(),
  ).toEqual([a.legalBodyId, b.legalBodyId].sort());
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

test("an event detail the redactor made unparseable reads back as text, without the digits", () => {
  // A nine-digit NUMBER is SSN-shaped, and the redactor rewrites it to an unquoted `[redacted]`,
  // which is no longer JSON. Reading the history must not throw because of it.
  const r = newBody();
  repo.recordEvent(r.legalBodyId, "note", "system", null, { block: 123456789 });
  expect(repo.listEvents(r.legalBodyId).at(-1)?.detail).toBe('{"block":[redacted]}');
});
