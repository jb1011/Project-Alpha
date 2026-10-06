/**
 * `recordBrokenReason`: what a broken body was found to be since its break, recorded with no state
 * move. It appends a `broken` event on a row that was linked once and is not linked now (`broken`,
 * or `superseded` after a pointer was seen), so `latestBrokenReason` reads the newest, and it leaves
 * the row itself, its `updated_at` included, as it was. Every other row is refused with nothing
 * written. Addresses and hashes are placeholders.
 */
import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import {
  LegalBodyInputError,
  SqliteLegalBodyRepository,
} from "../../src/persistence/legalBodyRepository";

const TENANT = "0x00000000000000000000000000000000000000A1";
const OWNER = "0x00000000000000000000000000000000000000A3";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const CHAIN = 5042002;
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
/** A value of the wrong type, as a caller without type checking could pass it. */
const as = <T>(value: unknown) => value as T;
/** A stored time well before any write of these tests. */
const OLD = "2026-01-02 03:04:05";

let db: Database.Database;
let repo: SqliteLegalBodyRepository;
let bodies = 0;
let agents = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Example Holdings LLC"]', 'existing', 'existing')`,
  ).run(TENANT);
  repo = new SqliteLegalBodyRepository(db);
});

const draft = () => {
  const id = repo.create({
    tenantId: TENANT,
    companyId: "co_1",
    chainId: CHAIN,
    factory: FACTORY,
    amendmentDelay: 172800,
  }).legalBodyId;
  expect(repo.freezeAgreement(id, { hash: H("a"), version: 1 })).toBe(true);
  return id;
};
const reserved = () => {
  const id = draft();
  expect(
    repo.reserve(id, {
      agentId: String(++agents),
      identityOwner: OWNER,
      linkDigest: H("b"),
      linkDeadline: 1_900_000_000,
      linkSignature: "0x01",
      bodyAddress: `0x${(0x100 + ++bodies).toString(16).padStart(40, "0")}`,
      observedAtBlock: 100,
      firstCheckAt: 1_800_000_000_000,
    }),
  ).toBe("reserved");
  return id;
};
const deployed = () => {
  const id = reserved();
  expect(repo.markDeployed(id, { txHash: H("c"), deployedAt: 1_800_000_000 })).toBe(true);
  return id;
};
const linked = () => {
  const id = deployed();
  expect(repo.markLinked(id, 1_800_000_100).outcome).toBe("linked");
  return id;
};
const broken = () => {
  const id = linked();
  expect(repo.markBroken(id, { reason: "winding_down", observedAtBlock: 200 })).toBe(true);
  return id;
};
/** Backdates the row's last state move, so a write that moved it would show. */
const backdate = (id: string) =>
  db.prepare("UPDATE legal_bodies SET updated_at = ? WHERE legal_body_id = ?").run(OLD, id);

const brokenDetails = (id: string) =>
  repo
    .listEvents(id)
    .filter((e) => e.kind === "broken")
    .map((e) => e.detail);

test("a broken row takes a new broken event, read as its latest reason, and the row does not move", () => {
  const id = broken();
  backdate(id);
  const before = repo.findById(id);

  expect(repo.recordBrokenReason(id, { reason: "dissolved", observedAtBlock: 300 })).toBe(true);

  expect(repo.findById(id)).toEqual(before);
  expect(repo.findById(id)?.updatedAt).toBe(OLD);
  expect(repo.latestBrokenReason(id)).toBe("dissolved");
  expect(brokenDetails(id)).toEqual([
    { reason: "winding_down", observedAtBlock: 200 },
    { reason: "dissolved", observedAtBlock: 300 },
  ]);
  expect(repo.listEvents(id).at(-1)).toMatchObject({
    kind: "broken",
    actor: "system",
    txHash: null,
  });
});

test("a superseded row that was linked once takes it too", () => {
  const id = broken();
  expect(repo.supersede(id, "lb_replacement_order_placeholder_0001")).toBe(true);
  backdate(id);
  const before = repo.findById(id);

  expect(repo.recordBrokenReason(id, { reason: "not_linked", observedAtBlock: 300 })).toBe(true);

  expect(repo.findById(id)).toEqual(before);
  expect(repo.latestBrokenReason(id)).toBe("not_linked");
});

test("a block number of nine digits or more is kept as the number it is", () => {
  const id = broken();
  expect(repo.recordBrokenReason(id, { reason: "dissolved", observedAtBlock: 123_456_789 })).toBe(
    true,
  );
  expect(brokenDetails(id).at(-1)).toEqual({ reason: "dissolved", observedAtBlock: 123_456_789 });
});

test("every other row is refused, with nothing written: a superseded row never linked, a linked one, and every state without a break", () => {
  const neverLinked = deployed();
  expect(repo.supersede(neverLinked, "lb_replacement_order_placeholder_0001")).toBe(true);
  const lapsed = reserved();
  expect(repo.lapse(lapsed, { reason: "deadline_passed", blockTime: 1_800_000_000 })).toBe(true);
  const abandoned = draft();
  expect(repo.abandon(abandoned, "test")).toBe(true);
  const rows = [neverLinked, linked(), deployed(), reserved(), draft(), lapsed, abandoned];

  for (const id of rows) {
    const before = { row: repo.findById(id), events: repo.listEvents(id) };
    expect(repo.recordBrokenReason(id, { reason: "dissolved", observedAtBlock: 300 }), id).toBe(
      false,
    );
    expect({ row: repo.findById(id), events: repo.listEvents(id) }, id).toEqual(before);
  }
  expect(repo.recordBrokenReason("lb_unknown", { reason: "dissolved", observedAtBlock: 300 })).toBe(
    false,
  );
});

test("a reason that is not a non-empty string is refused before anything is written", () => {
  const id = broken();
  const events = repo.listEvents(id).length;
  for (const reason of ["", 7, null, undefined])
    expect(
      () => repo.recordBrokenReason(id, as({ reason, observedAtBlock: 300 })),
      String(reason),
    ).toThrow(LegalBodyInputError);
  expect(repo.listEvents(id)).toHaveLength(events);
  expect(repo.latestBrokenReason(id)).toBe("winding_down");
});
