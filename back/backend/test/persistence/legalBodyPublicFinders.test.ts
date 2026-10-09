/**
 * The read-only finders a public answer about a legal body reads, kept apart from the repository's
 * own interface: the public rows of an agent (deployed, linked, broken or superseded: a body exists
 * on chain), the agent ids of an identity owner, the linked rows of a deployment, and a body's
 * first revocation. Every row is brought to its state through the repository's own moves, except
 * one written around it on purpose, to store an owner in another casing. Addresses and hashes are
 * placeholders.
 */
import Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import {
  type BindingState,
  type Deployment,
  LegalBodyInputError,
  type LegalBodyPublicFinders,
  type LegalBodyRecord,
  SqliteLegalBodyRepository,
} from "../../src/persistence/legalBodyRepository";

const TENANT = getAddress("0x00000000000000000000000000000000000000a1");
const OWNER = getAddress("0x00000000000000000000000000000000000abc01");
const OTHER_OWNER = getAddress("0x00000000000000000000000000000000000abc02");
const FACTORY = getAddress("0x00000000000000000000000000000000000fac70");
const OTHER_FACTORY = getAddress("0x00000000000000000000000000000000000fac71");
const CHAIN = 5042002;
const OTHER_CHAIN = 31_337;
const D: Deployment = { chainId: CHAIN, factory: FACTORY };
/** Unix SECONDS: a block time, and the base the tests add to, to order pointer sightings. */
const T = 1_800_000_000;
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
/** A value of the wrong type, as a caller without type checking could pass it. */
const as = <V>(value: unknown) => value as V;
/** An address in three spellings: checksummed, lower case and upper case. */
const spellings = (a: Address) =>
  [a, a.toLowerCase(), `0x${a.slice(2).toUpperCase()}`] as Address[];
const ids = (rows: LegalBodyRecord[]) => rows.map((r) => r.legalBodyId);

let db: Database.Database;
let repo: SqliteLegalBodyRepository;
/** The same repository, seen through the finders' own interface only. */
let finders: LegalBodyPublicFinders;
let serial = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Example Holdings LLC"]', 'existing', 'existing')`,
  ).run(TENANT);
  repo = new SqliteLegalBodyRepository(db);
  finders = repo;
  serial = 0;
});
afterEach(() => db.close());

interface Place {
  agentId?: string;
  owner?: Address;
  /** The pointer sighting of the row's link, in unix seconds. A superseded row without one was
   *  set aside before any link. */
  seenAt?: number;
  chainId?: number;
  factory?: Address;
}

/** A draft of `p`'s deployment (this test's unless told otherwise). */
function draftOf(p: Place): string {
  serial += 1;
  return repo.create({
    tenantId: TENANT,
    companyId: "co_1",
    chainId: p.chainId ?? CHAIN,
    factory: p.factory ?? FACTORY,
    amendmentDelay: 172_800,
  }).legalBodyId;
}

/** A distinct placeholder body per row: never the zero address or a factory. */
const nextBody = () => getAddress(`0x${(0xb0d1e000 + serial).toString(16).padStart(40, "0")}`);

/**
 * A row brought to `state` through the repository's own moves: create, then abandon, or freeze
 * and reserve; from reserved, lapse or deploy; from deployed, link (seen at `seenAt`) and then
 * break, or supersede. Linking a body moves the body linked before it for the same agent to
 * `broken`, as the repository does: tests create rows in the order that leaves each in its state.
 */
function rowIn(state: BindingState, p: Place = {}): LegalBodyRecord {
  const id = draftOf(p);
  if (state === "abandoned") expect(repo.abandon(id, "opened by mistake")).toBe(true);
  if (state !== "draft" && state !== "abandoned") {
    expect(repo.freezeAgreement(id, { hash: H("a"), version: 1 })).toBe(true);
    expect(
      repo.reserve(id, {
        agentId: p.agentId ?? "42",
        identityOwner: p.owner ?? OWNER,
        linkDigest: H("b"),
        linkDeadline: 1_900_000_000,
        linkSignature: "0x01",
        bodyAddress: nextBody(),
        observedAtBlock: 1,
        firstCheckAt: 1_800_000_000_000,
      }),
    ).toBe("reserved");
  }
  if (state === "lapsed")
    expect(repo.lapse(id, { reason: "deadline_passed", blockTime: T })).toBe(true);
  if (state === "deployed" || state === "linked" || state === "broken" || state === "superseded")
    expect(repo.markDeployed(id, { txHash: H("c"), deployedAt: T })).toBe(true);
  const linkedOnce =
    state === "linked" || state === "broken" || (state === "superseded" && p.seenAt !== undefined);
  if (linkedOnce) expect(repo.markLinked(id, p.seenAt ?? T).outcome).toBe("linked");
  if (linkedOnce && state !== "linked")
    expect(repo.markBroken(id, { reason: "not_linked" })).toBe(true);
  if (state === "superseded") expect(repo.supersede(id, "lb_replacement")).toBe(true);
  const row = repo.findById(id);
  expect(row?.bindingState).toBe(state);
  return row as LegalBodyRecord;
}

/**
 * A deployed row whose identity owner is stored in `spelling`. Written around the repository on
 * purpose: the repository always stores the checksummed form, and the column's CHECK takes an
 * address in any casing.
 */
function deployedWithStoredOwner(agentId: string, spelling: string): LegalBodyRecord {
  const id = draftOf({});
  expect(repo.freezeAgreement(id, { hash: H("a"), version: 1 })).toBe(true);
  const { changes } = db
    .prepare(
      `UPDATE legal_bodies
          SET agent_id = ?, identity_owner = ?, link_digest = ?, link_deadline = 1900000000,
              link_signature = '0x01', body_address = ?, binding_state = 'reserved'
        WHERE legal_body_id = ?`,
    )
    .run(agentId, spelling, H("b"), nextBody(), id);
  expect(changes).toBe(1);
  expect(repo.markDeployed(id, { txHash: H("c"), deployedAt: T })).toBe(true);
  const row = repo.findById(id);
  expect(row?.identityOwner).toBe(spelling);
  return row as LegalBodyRecord;
}

describe("listPublicByAgent", () => {
  test("lists deployed, linked, broken and superseded rows; never draft, reserved, lapsed or abandoned", () => {
    rowIn("draft");
    rowIn("abandoned");
    rowIn("lapsed");
    const broken = rowIn("broken", { seenAt: T + 100 });
    const superseded = rowIn("superseded", { seenAt: T + 200 });
    const linked = rowIn("linked", { seenAt: T + 300 });
    const onItsWay = rowIn("reserved");
    expect(ids(finders.listPublicByAgent(D, "42", 100))).toEqual(ids([linked, superseded, broken]));
    // Left out for its state alone: once deployed, the same row is listed, first.
    expect(repo.markDeployed(onItsWay.legalBodyId, { txHash: H("c"), deployedAt: T })).toBe(true);
    expect(ids(finders.listPublicByAgent(D, "42", 100))).toEqual(
      ids([onItsWay, linked, superseded, broken]),
    );
    // An agent whose every row is on its way or closed has nothing to list.
    rowIn("lapsed", { agentId: "43" });
    rowIn("reserved", { agentId: "43" });
    expect(finders.listPublicByAgent(D, "43", 100)).toEqual([]);
  });

  test("orders the deployed row first, then the most recent linked stretch, and rows never linked last, the newer first", () => {
    const neverLinkedOlder = rowIn("superseded");
    const old = rowIn("broken", { seenAt: T + 100 });
    const recent = rowIn("broken", { seenAt: T + 500 });
    const neverLinkedNewer = rowIn("superseded");
    const middle = rowIn("superseded", { seenAt: T + 300 });
    const deployed = rowIn("deployed");
    expect(neverLinkedOlder.pointerSeenAt).toBeNull();
    expect(deployed.pointerSeenAt).toBeNull();
    expect(ids(finders.listPublicByAgent(D, "42", 100))).toEqual(
      ids([deployed, recent, middle, old, neverLinkedNewer, neverLinkedOlder]),
    );
  });

  test("five previously linked rows and a deployed one, with a limit of 4, keep the deployed row and the three most recent", () => {
    // Each link moves the body linked before it to broken: four broken rows and one linked.
    const inTurn = [1, 2, 3, 4, 5].map((i) => rowIn("linked", { seenAt: T + i * 100 }));
    const deployed = rowIn("deployed");
    const listed = finders.listPublicByAgent(D, "42", 4);
    expect(ids(listed)).toEqual([deployed.legalBodyId, ...ids(inTurn).reverse().slice(0, 3)]);
    expect(listed.map((r) => r.bindingState)).toEqual(["deployed", "linked", "broken", "broken"]);
  });

  test("a body linked again comes back to the front, so a limit of 4 keeps it even as the oldest row", () => {
    const inTurn = [1, 2, 3, 4, 5].map((i) => rowIn("linked", { seenAt: T + i * 100 }));
    const deployed = rowIn("deployed");
    const [oldest] = inTurn;
    if (!oldest) throw new Error("no rows");
    expect(repo.markLinked(oldest.legalBodyId, T + 600).outcome).toBe("linked");
    const listed = finders.listPublicByAgent(D, "42", 4);
    expect(ids(listed)).toEqual([
      deployed.legalBodyId,
      oldest.legalBodyId,
      ...ids(inTurn).reverse().slice(0, 2),
    ]);
    expect(listed.map((r) => r.bindingState)).toEqual(["deployed", "linked", "broken", "broken"]);
  });

  test("is scoped to the deployment: another factory or another chain is not this agent; the factory in any casing", () => {
    const here = rowIn("linked");
    const otherFactory = rowIn("linked", { factory: OTHER_FACTORY });
    const otherChain = rowIn("linked", { chainId: OTHER_CHAIN });
    expect(new Set(spellings(FACTORY)).size).toBe(3);
    for (const factory of spellings(FACTORY))
      expect(ids(finders.listPublicByAgent({ chainId: CHAIN, factory }, "42", 4)), factory).toEqual(
        [here.legalBodyId],
      );
    expect(
      ids(finders.listPublicByAgent({ chainId: CHAIN, factory: OTHER_FACTORY }, "42", 4)),
    ).toEqual([otherFactory.legalBodyId]);
    expect(
      ids(finders.listPublicByAgent({ chainId: OTHER_CHAIN, factory: FACTORY }, "42", 4)),
    ).toEqual([otherChain.legalBodyId]);
  });

  test('"042" is agent 42, as findLinkedByAgent reads it; a value that is not a uint256 in decimal finds nothing', () => {
    const row = rowIn("linked");
    const largestId = (2n ** 256n - 1n).toString();
    const largest = rowIn("linked", { agentId: largestId });
    expect(repo.findLinkedByAgent(D, "042")?.legalBodyId).toBe(row.legalBodyId);
    for (const agentId of ["42", "042", "0042"])
      expect(ids(finders.listPublicByAgent(D, agentId, 4)), agentId).toEqual([row.legalBodyId]);
    expect(ids(finders.listPublicByAgent(D, largestId, 4))).toEqual([largest.legalBodyId]);
    const bad = [
      "",
      "4a",
      "-42",
      " 42",
      "42 ",
      "4.2",
      (2n ** 256n).toString(),
      42,
      null,
      undefined,
    ];
    for (const agentId of bad)
      expect(finders.listPublicByAgent(D, as<string>(agentId), 4), String(agentId)).toEqual([]);
  });

  test("the limit is a whole number from 1 to 100, and a malformed deployment throws, whatever the agent id", () => {
    rowIn("linked");
    expect(finders.listPublicByAgent(D, "42", 1)).toHaveLength(1);
    expect(finders.listPublicByAgent(D, "42", 100)).toHaveLength(1);
    for (const bad of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, as("4"), as(4n)])
      for (const agentId of ["42", "4a"])
        expect(
          () => finders.listPublicByAgent(D, agentId, as<number>(bad)),
          `${String(bad)} for ${agentId}`,
        ).toThrow(LegalBodyInputError);
    const malformed = [
      { chainId: 0, factory: FACTORY },
      { chainId: 1.5, factory: FACTORY },
      { chainId: CHAIN, factory: "0x12" },
      undefined,
    ];
    for (const d of malformed)
      for (const agentId of ["42", "4a"])
        expect(() => finders.listPublicByAgent(as<Deployment>(d), agentId, 4)).toThrow(
          LegalBodyInputError,
        );
  });
});

describe("listAgentIdsByIdentityOwner", () => {
  test("lists each agent once, newest first by the agent's newest row", () => {
    rowIn("broken", { agentId: "7", seenAt: T + 100 });
    rowIn("linked", { agentId: "8", seenAt: T + 200 });
    rowIn("linked", { agentId: "7", seenAt: T + 300 });
    rowIn("deployed", { agentId: "9" });
    expect(finders.listAgentIdsByIdentityOwner(D, OWNER, 5)).toEqual(["9", "7", "8"]);
    expect(finders.listAgentIdsByIdentityOwner(D, OWNER, 2)).toEqual(["9", "7"]);
  });

  test("reads rows in the four public states only: an order on its way or closed neither lists an agent nor makes it newer", () => {
    rowIn("draft");
    rowIn("abandoned");
    rowIn("linked", { agentId: "20" });
    rowIn("superseded", { agentId: "21" });
    rowIn("lapsed", { agentId: "20" });
    rowIn("reserved", { agentId: "20" });
    rowIn("lapsed", { agentId: "22" });
    rowIn("reserved", { agentId: "23" });
    expect(finders.listAgentIdsByIdentityOwner(D, OWNER, 100)).toEqual(["21", "20"]);
  });

  test("matches the owner in any casing, as given and as stored; another owner's agents are not listed", () => {
    expect(new Set(spellings(OWNER)).size).toBe(3);
    rowIn("linked", { agentId: "30" });
    rowIn("linked", { agentId: "31", owner: OTHER_OWNER });
    deployedWithStoredOwner("32", OWNER.toLowerCase());
    for (const owner of spellings(OWNER))
      expect(finders.listAgentIdsByIdentityOwner(D, owner, 5), owner).toEqual(["32", "30"]);
    expect(finders.listAgentIdsByIdentityOwner(D, OTHER_OWNER, 5)).toEqual(["31"]);
  });

  test("an owner that is not an address finds nothing", () => {
    rowIn("linked");
    for (const bad of ["", "0x12", `${OWNER}00`, OWNER.slice(2), 42, null, undefined, {}])
      expect(finders.listAgentIdsByIdentityOwner(D, as<Address>(bad), 5), String(bad)).toEqual([]);
  });

  test("is scoped to the deployment, the factory in any casing; the limit is a whole number from 1 to 100; a malformed deployment throws", () => {
    rowIn("linked", { agentId: "40", factory: OTHER_FACTORY });
    rowIn("linked", { agentId: "41", chainId: OTHER_CHAIN });
    rowIn("linked", { agentId: "42" });
    for (const factory of spellings(FACTORY))
      expect(
        finders.listAgentIdsByIdentityOwner({ chainId: CHAIN, factory }, OWNER, 5),
        factory,
      ).toEqual(["42"]);
    expect(
      finders.listAgentIdsByIdentityOwner({ chainId: CHAIN, factory: OTHER_FACTORY }, OWNER, 5),
    ).toEqual(["40"]);
    expect(
      finders.listAgentIdsByIdentityOwner({ chainId: OTHER_CHAIN, factory: FACTORY }, OWNER, 5),
    ).toEqual(["41"]);
    expect(finders.listAgentIdsByIdentityOwner(D, OWNER, 1)).toEqual(["42"]);
    expect(finders.listAgentIdsByIdentityOwner(D, OWNER, 100)).toEqual(["42"]);
    for (const bad of [0, -1, 101, 2.5, Number.NaN, as("5")])
      for (const owner of [OWNER, as<Address>("not an address")])
        expect(
          () => finders.listAgentIdsByIdentityOwner(D, owner, as<number>(bad)),
          `${String(bad)} for ${owner}`,
        ).toThrow(LegalBodyInputError);
    for (const d of [
      { chainId: 0, factory: FACTORY },
      { chainId: CHAIN, factory: "0x12" },
    ])
      expect(() => finders.listAgentIdsByIdentityOwner(as<Deployment>(d), OWNER, 5)).toThrow(
        LegalBodyInputError,
      );
  });
});

describe("listLinked", () => {
  test("lists this deployment's linked rows only, the newest sighting first, the newer row first on a tie", () => {
    rowIn("draft");
    rowIn("abandoned");
    const a = rowIn("linked", { agentId: "1", seenAt: T + 100 });
    const b = rowIn("linked", { agentId: "2", seenAt: T + 300 });
    const c = rowIn("linked", { agentId: "3", seenAt: T + 200 });
    const d = rowIn("linked", { agentId: "4", seenAt: T + 200 });
    rowIn("broken", { agentId: "5", seenAt: T + 400 });
    rowIn("superseded", { agentId: "6", seenAt: T + 400 });
    rowIn("superseded", { agentId: "7" });
    rowIn("deployed", { agentId: "8" });
    rowIn("reserved", { agentId: "9" });
    rowIn("lapsed", { agentId: "10" });
    const otherFactory = rowIn("linked", { agentId: "1", factory: OTHER_FACTORY, seenAt: T + 900 });
    const otherChain = rowIn("linked", { agentId: "1", chainId: OTHER_CHAIN, seenAt: T + 900 });
    for (const factory of spellings(FACTORY))
      expect(ids(finders.listLinked({ chainId: CHAIN, factory }, 100)), factory).toEqual(
        ids([b, d, c, a]),
      );
    expect(ids(finders.listLinked(D, 2))).toEqual(ids([b, d]));
    expect(ids(finders.listLinked({ chainId: CHAIN, factory: OTHER_FACTORY }, 100))).toEqual([
      otherFactory.legalBodyId,
    ]);
    expect(ids(finders.listLinked({ chainId: OTHER_CHAIN, factory: FACTORY }, 100))).toEqual([
      otherChain.legalBodyId,
    ]);
  });

  test("the limit is a whole number from 1 to 100, and a malformed deployment throws", () => {
    rowIn("linked");
    expect(finders.listLinked(D, 1)).toHaveLength(1);
    expect(finders.listLinked(D, 100)).toHaveLength(1);
    for (const bad of [0, -1, 101, 1.5, Number.NaN, as("4")])
      expect(() => finders.listLinked(D, as<number>(bad)), String(bad)).toThrow(
        LegalBodyInputError,
      );
    for (const d of [
      { chainId: 0, factory: FACTORY },
      { chainId: CHAIN, factory: "0x12" },
    ])
      expect(() => finders.listLinked(as<Deployment>(d), 4)).toThrow(LegalBodyInputError);
  });
});

describe("firstRevocationEventId", () => {
  /** Records a revocation of the body, as an operator's revoke does. */
  const revoke = (legalBodyId: string) =>
    repo.recordEvent(legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
  /** The ids of the body's `revoked` events, oldest first. */
  const revocations = (legalBodyId: string) =>
    repo
      .listEvents(legalBodyId)
      .filter((e) => e.kind === "revoked")
      .map((e) => e.id);

  test("a body never revoked: null, whatever other events it has", () => {
    const row = rowIn("broken");
    expect(repo.listEvents(row.legalBodyId).length).toBeGreaterThan(0);
    expect(finders.firstRevocationEventId(row.legalBodyId)).toBeNull();
  });

  test("one revocation: its event's id", () => {
    const row = rowIn("linked");
    revoke(row.legalBodyId);
    const [only] = revocations(row.legalBodyId);
    expect(only).toBeDefined();
    expect(finders.firstRevocationEventId(row.legalBodyId)).toBe(only);
  });

  test("two revocations, with other events around them: the first one's id", () => {
    const row = rowIn("linked");
    revoke(row.legalBodyId);
    repo.recordEvent(row.legalBodyId, "note", "system", null, { note: "between the two" });
    revoke(row.legalBodyId);
    repo.recordEvent(row.legalBodyId, "note", "system", null, { note: "after them" });
    const [first, second] = revocations(row.legalBodyId);
    expect(second).toBeGreaterThan(first as number);
    expect(finders.firstRevocationEventId(row.legalBodyId)).toBe(first);
  });

  test("another body's revocation is not this body's; a body that does not exist has none", () => {
    const revoked = rowIn("linked", { agentId: "7" });
    const other = rowIn("linked", { agentId: "8" });
    revoke(revoked.legalBodyId);
    expect(finders.firstRevocationEventId(other.legalBodyId)).toBeNull();
    revoke(other.legalBodyId);
    expect(finders.firstRevocationEventId(other.legalBodyId)).toBe(
      revocations(other.legalBodyId)[0],
    );
    expect(finders.firstRevocationEventId(revoked.legalBodyId)).toBe(
      revocations(revoked.legalBodyId)[0],
    );
    expect(finders.firstRevocationEventId("lb_no_such_body")).toBeNull();
  });
});

test("the finders only read: no row of the database changes", () => {
  rowIn("linked");
  const revoked = rowIn("deployed", { agentId: "43" });
  repo.recordEvent(revoked.legalBodyId, "revoked", "operator:ops.example", null, {
    reason: "Recorded for a test.",
  });
  const totalChanges = () => db.prepare("SELECT total_changes()").pluck().get();
  const rows = () => db.prepare("SELECT * FROM legal_bodies ORDER BY rowid").all();
  const events = () => db.prepare("SELECT * FROM legal_body_events ORDER BY id").all();
  const before = { changes: totalChanges(), rows: rows(), events: events() };
  finders.listPublicByAgent(D, "42", 4);
  finders.listAgentIdsByIdentityOwner(D, OWNER, 5);
  finders.listLinked(D, 100);
  finders.firstRevocationEventId(revoked.legalBodyId);
  expect({ changes: totalChanges(), rows: rows(), events: events() }).toEqual(before);
});
