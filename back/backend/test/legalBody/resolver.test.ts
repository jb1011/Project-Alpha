/**
 * The resolver: one reserved order settled from the chain, by a fixed table of rules. A body the
 * row's owner created is adopted with the hash the chain names; a body made for another owner, or
 * a head past the link's deadline, lapses the order; dead bytes are submitted again; bytes the
 * node's pool holds are waited for; bytes the node lost are sent again; and a nonce of the
 * platform key that nothing holds is filled before anything above it can be mined.
 *
 * The database is real (in memory). The chain is a fake whose answers each test steers; any member
 * it does not fake throws when read. The process clock is injected and starts at the fake head's
 * time, so chain time and process time agree unless a test moves one of them. Every name, company
 * and filing number is an invention, and every key is one of anvil's published test accounts.
 */
import type Database from "better-sqlite3";
import { type Hex, getAddress, keccak256, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type LegalBodyChainPort,
  type LegalBodyCreated,
  LegalBodyGasTooHighError,
} from "../../src/adapters/arc/legalBodyChain";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import { linkOfRow } from "../../src/legalBody/create";
import { offChainLinkDigest } from "../../src/legalBody/link";
import { submitLinkAndCreate } from "../../src/legalBody/linkDoor";
import {
  type LegalBodyOrderDeps,
  createOrder,
  orderLockKey,
  toOrderView,
} from "../../src/legalBody/orders";
import {
  RESOLVE_FIRST_INTERVAL_MS,
  RESOLVE_MAX_INTERVAL_MS,
  resolveOrder,
} from "../../src/legalBody/resolver";
import { withKeyedLock } from "../../src/payments/keyedMutex";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { DeploySubmission, LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  IDENTITY_OWNER,
  LINK_HEAD,
  type LegalBodyStores,
  TransportFailure,
  appendCheck,
  asChainPort,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  linkFor,
  openLegalBodyStores,
  signedLink,
} from "../helpers/legalBodyFixtures";

const tenant = ANVIL_ACCOUNT_2.address;
/** The identity's owner after a transfer, in the tests that need one. */
const LATER_OWNER = ANVIL_ACCOUNT_3.address;
/** The deployment every order of these tests is made under. */
const DEPLOYMENT = { chainId: CHAIN_ID, factory: FACTORY };
/** The block the reserve observed each link at. */
const ACCEPTED_AT_BLOCK = 7_000;
/** The link deadline of every order unless a test sets its own: an hour after the fake head. */
const DEADLINE = Number(LINK_HEAD.timestamp) + 3_600;
/** The time of the block that created a body in these tests, in unix seconds. */
const DEPLOYED_AT = Number(LINK_HEAD.timestamp) - 5;

let db: Database.Database;
let s: LegalBodyStores;
let chain: ReturnType<typeof fakeChain>;
let lines: string[];
/** The process clock the deps read, in unix milliseconds. */
let clock: number;
/** The nonce the fake signer gives the next create it signs. */
let signedNonce: number;
let signed = 0;
let recorded = 0;
let filings = 0;
let agents = 500;

/** A signed create as the fake signer hands it back: a fresh hash and bytes, at `signedNonce`. */
function nextSigned(): { txHash: Hex; rawTx: Hex; nonce: number } {
  signed++;
  return {
    txHash: keccak256(toHex(`signed-create-${signed}`)),
    rawTx: `0x02${signed.toString(16).padStart(6, "0")}` as Hex,
    nonce: signedNonce,
  };
}

/**
 * The link check's reads (the link is valid and the registry names the row's owner), and every
 * call the resolver makes, each a mock a test can steer. By default: no body at the address, no
 * receipt for any hash, nothing in the factory's logs, both nonce counts at 0, and a create that
 * is recorded (through the caller's `record`) and sent.
 */
function fakeChain() {
  return {
    ...fakeLinkChainMembers(),
    createdState: vi.fn<LegalBodyChainPort["createdState"]>(async () => "absent"),
    createOutcome: vi.fn<LegalBodyChainPort["createOutcome"]>(async () => ({ status: "absent" })),
    findCreation: vi.fn<LegalBodyChainPort["findCreation"]>(async () => undefined),
    rebroadcastCreate: vi.fn<LegalBodyChainPort["rebroadcastCreate"]>(async () => {}),
    executorNonce: vi.fn<LegalBodyChainPort["executorNonce"]>(async () => 0),
    executorPendingNonce: vi.fn<LegalBodyChainPort["executorPendingNonce"]>(async () => 0),
    submitCreate: vi.fn<LegalBodyChainPort["submitCreate"]>(async (p) => {
      const create = nextSigned();
      return p.record({ ...create }) ? { status: "sent", ...create } : { status: "not_recorded" };
    }),
  };
}
type FakeChain = ReturnType<typeof fakeChain>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, tenant, "4001", Date.now());
  chain = fakeChain();
  clock = Number(LINK_HEAD.timestamp) * 1_000;
  signedNonce = 0;
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function deps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, { chain: asChainPort(chain), now: () => clock, ...over });
}

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A draft of the tenant, placed through the order door for a company of its own. */
function draft(): LegalBodyRecord {
  const companyId = customerCompany(s, tenant, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const view = createOrder(deps({ maxOpenPerTenant: 50, maxOrdersPerTenantPerDay: 50 }), tenant, {
    companyId,
  });
  return rowOf(view.id);
}

/**
 * An order moved to `reserved` through the repository, as the link door reserves one: for an
 * identity of its own, owned by `IDENTITY_OWNER`, with the owner's real signature of the link, the
 * link's digest, and the body address the fake factory predicts from that digest.
 */
async function reservedOrder(p: { deadline?: number } = {}): Promise<LegalBodyRecord> {
  const row = draft();
  const link = linkFor(row, {
    agentId: BigInt(++agents),
    deadline: BigInt(p.deadline ?? DEADLINE),
  });
  const { signature } = await signedLink(link);
  const linkDigest = offChainLinkDigest({ chainId: CHAIN_ID, factory: FACTORY, link });
  expect(
    s.repo.reserve(row.legalBodyId, {
      agentId: link.agentId.toString(),
      identityOwner: IDENTITY_OWNER.address,
      linkDigest,
      linkDeadline: Number(link.deadline),
      linkSignature: signature,
      bodyAddress: getAddress(`0x${linkDigest.slice(-40)}`),
      observedAtBlock: ACCEPTED_AT_BLOCK,
      firstCheckAt: clock,
    }),
  ).toBe("reserved");
  return rowOf(row.legalBodyId);
}

/** Records one create submission at `nonce` on a reserved order, as an earlier send did, and
 *  returns it as the repository reads it back. */
function recordSubmission(id: string, nonce: number): DeploySubmission {
  recorded++;
  expect(
    s.repo.recordDeploySubmission(id, {
      txHash: keccak256(toHex(`recorded-create-${recorded}`)),
      rawTx: `0x02ab${recorded.toString(16).padStart(6, "0")}` as Hex,
      nonce,
    }),
  ).toBe(true);
  const newest = s.repo.listDeploySubmissions(id)[0];
  if (!newest) throw new Error(`no submission recorded for ${id}`);
  return newest;
}

/** The factory's record of the row's body, created by `txHash`. */
function creation(row: LegalBodyRecord, txHash: Hex): LegalBodyCreated {
  if (!row.bodyAddress || !row.agentId || !row.identityOwner || !row.linkDigest)
    throw new Error(`order ${row.legalBodyId} holds no link`);
  return {
    legalBody: row.bodyAddress,
    agentId: BigInt(row.agentId),
    identityOwner: row.identityOwner,
    guardian: row.guardian,
    linkDigest: row.linkDigest,
    txHash,
    blockNumber: Number(LINK_HEAD.number) - 1,
    deployedAt: DEPLOYED_AT,
  };
}

/** The notes the system wrote on an order (the order door writes the tenant's own). */
const systemNotes = (id: string) =>
  s.repo.listEvents(id).filter((e) => e.kind === "note" && e.actor === "system");

/** The names of the fake chain's members that were called, sorted. */
function calledMembers(c: FakeChain = chain): string[] {
  return Object.entries(c)
    .filter(([, member]) => vi.isMockFunction(member) && member.mock.calls.length > 0)
    .map(([name]) => name)
    .sort();
}

const opsLines = () =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return "opslog" in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });

/** The factory's refusal of a create, as the relayed create's simulation reports it. */
const revert = (errorName: string) =>
  new ContractRevertError(`createLegalBody reverted: ${errorName}`, errorName);

// ── A row that is not reserved ──────────────────────────────────────────────────────────────

describe("a row that is not reserved", () => {
  test("a draft, a lapsed order and an unknown id answer not_reserved, with no chain call and no change", async () => {
    const aDraft = draft();
    const aLapsed = await reservedOrder();
    expect(
      s.repo.lapse(aLapsed.legalBodyId, {
        reason: "owner_changed",
        blockTime: Number(LINK_HEAD.timestamp),
      }),
    ).toBe(true);

    for (const id of [aDraft.legalBodyId, aLapsed.legalBodyId, "lb_unknown"]) {
      const before = s.repo.findById(id);
      const events = before ? s.repo.listEvents(id).length : 0;

      expect(await resolveOrder(deps(), id), id).toBe("not_reserved");

      expect(s.repo.findById(id), id).toEqual(before);
      if (before) expect(s.repo.listEvents(id), id).toHaveLength(events);
    }
    expect(calledMembers()).toEqual([]);
    expect(opsLines()).toEqual([]);
  });
});

// ── The schedule ────────────────────────────────────────────────────────────────────────────

describe("the resolve schedule", () => {
  test("a row past its deadline that answers unknown three times is scheduled later each time, and is not due in between", async () => {
    const row = await reservedOrder();
    chain.head.mockRejectedValue(new TransportFailure());
    clock = (DEADLINE + 100) * 1_000;

    const gaps: number[] = [];
    for (let pass = 1; pass <= 3; pass++) {
      expect(await resolveOrder(deps(), row.legalBodyId), `pass ${pass}`).toBe("unknown");
      const next = rowOf(row.legalBodyId).nextBindingCheckAt;
      if (next === null) throw new Error("the row left the schedule");
      expect(next, `pass ${pass}`).toBeGreaterThan(clock);
      expect(s.repo.listReserved(DEPLOYMENT, clock, 5), `pass ${pass}`).toEqual([]);
      gaps.push(next - clock);
      clock = next;
    }
    expect(gaps).toEqual([30_000, 60_000, 120_000]);
    expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
  });

  test("a row whose deadline is 40 seconds ahead is scheduled no later than one second after it; once it has passed, the row keeps backing off", async () => {
    const row = await reservedOrder();
    chain.head.mockRejectedValue(new TransportFailure());
    const cap = (DEADLINE + 1) * 1_000;
    clock = (DEADLINE - 40) * 1_000;

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("unknown");
    const first = rowOf(row.legalBodyId).nextBindingCheckAt ?? 0;
    expect(first).toBe(clock + 30_000);
    expect(first).toBeLessThanOrEqual(cap);

    // The next interval is a minute, which would end 50 seconds after the deadline.
    clock = first;
    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("unknown");
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(cap);

    // The deadline has passed: the cap no longer applies, and the doubling goes on.
    clock = cap;
    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("unknown");
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(cap + 120_000);
  });

  test("the interval doubles to ten minutes and stays there", async () => {
    const row = await reservedOrder({ deadline: Number(LINK_HEAD.timestamp) + 86_000 });
    chain.head.mockRejectedValue(new TransportFailure());

    const gaps: number[] = [];
    for (let pass = 1; pass <= 7; pass++) {
      expect(await resolveOrder(deps(), row.legalBodyId)).toBe("unknown");
      const next = rowOf(row.legalBodyId).nextBindingCheckAt ?? 0;
      gaps.push(next - clock);
      clock = next;
    }
    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    expect(RESOLVE_FIRST_INTERVAL_MS).toBe(30_000);
    expect(RESOLVE_MAX_INTERVAL_MS).toBe(600_000);
  });

  test("after resubmitted the next check is 30 seconds away, and the doubling starts again from there", async () => {
    const row = await reservedOrder();
    // As if the row had backed off to the longest interval.
    s.repo.scheduleBindingCheck(row.legalBodyId, clock, RESOLVE_MAX_INTERVAL_MS);

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("resubmitted");
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 30_000);

    // The create is in the node's pool: the next pass waits, a minute this time.
    clock += 30_000;
    chain.executorPendingNonce.mockResolvedValue(1);
    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("waiting");
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 60_000);
  });
});

// ── Rule 1: the body exists, created by the row's owner ─────────────────────────────────────

describe("rule 1: the body exists, created by the row's owner", () => {
  test("the recorded hashes are read newest first, and the first that reads created is adopted", async () => {
    const row = await reservedOrder();
    const older = recordSubmission(row.legalBodyId, 0);
    const newer = recordSubmission(row.legalBodyId, 1);
    chain.createdState.mockResolvedValue("created");
    chain.createOutcome.mockImplementation(async (txHash) =>
      txHash === older.txHash
        ? { status: "created", created: creation(row, older.txHash) }
        : { status: "absent" },
    );

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("deployed");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("deployed");
    expect(after.createTxHash).toBe(older.txHash);
    expect(after.deployedAt).toBe(DEPLOYED_AT);
    expect(after.nextBindingCheckAt).toBe(clock);
    expect(after.bindingCheckIntervalMs).toBe(60_000);
    expect(chain.createOutcome.mock.calls.map(([txHash]) => txHash)).toEqual([
      newer.txHash,
      older.txHash,
    ]);
    expect(chain.findCreation).not.toHaveBeenCalled();
    expect(chain.submitCreate).not.toHaveBeenCalled();
  });

  test("with no recorded hash that reads created, the factory's logs supply the hash, searched from the accepted block to this pass's head", async () => {
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 0);
    const found = keccak256(toHex("a create this process did not record"));
    chain.createdState.mockResolvedValue("created");
    chain.createOutcome.mockResolvedValue({ status: "reverted" });
    chain.findCreation.mockResolvedValue(creation(row, found));

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("deployed");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("deployed");
    expect(after.createTxHash).toBe(found);
    expect(after.deployedAt).toBe(DEPLOYED_AT);
    expect(chain.findCreation.mock.calls).toEqual([
      [
        {
          bodyAddress: row.bodyAddress,
          fromBlock: BigInt(ACCEPTED_AT_BLOCK),
          toBlock: LINK_HEAD.number,
        },
      ],
    ]);
  });

  test("a search that finds nothing is unknown and leaves the row as it was; the next pass searches to the same block, kept as a number", async () => {
    const row = await reservedOrder();
    // A nine-digit block: kept as a string, the event writer would redact it.
    const firstHead = { number: 123_456_789n, timestamp: LINK_HEAD.timestamp };
    chain.head.mockResolvedValue(firstHead);
    chain.createdState.mockResolvedValue("created");

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("unknown");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("reserved");
    expect(after.createTxHash).toBeNull();
    expect(after.nextBindingCheckAt).toBe(clock + 30_000);
    // The order's own events, then the kept block: nothing else was written.
    expect(s.repo.listEvents(row.legalBodyId).map((e) => e.kind)).toEqual([
      "created",
      "agreement_frozen",
      "note",
      "link_accepted",
      "note",
    ]);
    expect(systemNotes(row.legalBodyId)).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ toBlock: 123_456_789 }) }),
    ]);

    // A later pass, at a later head, searches the same range, and this time finds the creation.
    clock += 30_000;
    chain.head.mockResolvedValue({ number: 123_456_999n, timestamp: LINK_HEAD.timestamp + 30n });
    const found = keccak256(toHex("found in the factory's logs"));
    chain.findCreation.mockResolvedValue(creation(row, found));

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("deployed");

    expect(chain.findCreation.mock.calls).toEqual([
      [
        {
          bodyAddress: row.bodyAddress,
          fromBlock: BigInt(ACCEPTED_AT_BLOCK),
          toBlock: 123_456_789n,
        },
      ],
      [
        {
          bodyAddress: row.bodyAddress,
          fromBlock: BigInt(ACCEPTED_AT_BLOCK),
          toBlock: 123_456_789n,
        },
      ],
    ]);
    expect(rowOf(row.legalBodyId).createTxHash).toBe(found);
    // The kept block is written once.
    expect(systemNotes(row.legalBodyId)).toHaveLength(1);
  });

  test("a creation no search can locate writes one error line over repeated passes, past the deadline too: the row stays reserved, and no hash is written", async () => {
    const row = await reservedOrder();
    const sub = recordSubmission(row.legalBodyId, 0);
    chain.createdState.mockResolvedValue("created");
    // The first search throws, as a node that cannot answer does; every later one finds nothing.
    chain.findCreation.mockRejectedValueOnce(new TransportFailure());
    const before = rowOf(row.legalBodyId);
    const events = s.repo.listEvents(row.legalBodyId).length;

    for (let pass = 1; pass <= 4; pass++) {
      if (pass === 4) {
        // Past the link's deadline: rule 1 comes first, so the row does not lapse.
        clock = (DEADLINE + 100) * 1_000;
        chain.head.mockResolvedValue({
          number: LINK_HEAD.number + 50n,
          timestamp: BigInt(DEADLINE + 100),
        });
      }
      expect(await resolveOrder(deps(), row.legalBodyId), `pass ${pass}`).toBe("unknown");
      const after = rowOf(row.legalBodyId);
      expect(after.bindingState, `pass ${pass}`).toBe("reserved");
      expect(after.createTxHash, `pass ${pass}`).toBe(before.createTxHash);
      expect(after.deployedAt, `pass ${pass}`).toBeNull();
      clock += 60_000;
    }

    // Only the search's kept block was written; nothing was sent.
    expect(
      s.repo
        .listEvents(row.legalBodyId)
        .slice(events)
        .map((e) => e.kind),
    ).toEqual(["note"]);
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toEqual([sub]);
    expect(chain.submitCreate).not.toHaveBeenCalled();
    expect(chain.rebroadcastCreate).not.toHaveBeenCalled();
    expect(opsLines()).toEqual([
      expect.objectContaining({
        opslog: "legal_body_resolve",
        level: "warn",
        orderId: row.legalBodyId,
        outcome: "unknown",
        stage: "find_creation",
        errorName: "HttpRequestError",
      }),
      {
        opslog: "legal_body_creation_unlocatable",
        at: expect.any(String),
        level: "error",
        orderId: row.legalBodyId,
        stage: "find_creation",
      },
    ]);
  });
});

// ── Rules 2 and 3: the order lapses ─────────────────────────────────────────────────────────

describe("rule 2: a body created for another owner", () => {
  test("lapses the order with foreign_body, at the head's time, and sends nothing", async () => {
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 0);
    chain.createdState.mockResolvedValue("foreign");

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("lapsed");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("lapsed");
    expect(after.nextBindingCheckAt).toBeNull();
    expect(s.repo.listEvents(row.legalBodyId).at(-1)).toEqual(
      expect.objectContaining({
        kind: "lapsed",
        detail: { reason: "foreign_body", blockTime: Number(LINK_HEAD.timestamp) },
      }),
    );
    expect(calledMembers()).toEqual(["createdState", "head"]);
  });
});

describe("rule 3: the head's time is past the deadline", () => {
  test("lapses the order with deadline_passed, at the head's time, even with a create recorded", async () => {
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 0);
    chain.head.mockResolvedValue({ number: LINK_HEAD.number, timestamp: BigInt(DEADLINE + 1) });

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("lapsed");

    expect(rowOf(row.legalBodyId).bindingState).toBe("lapsed");
    expect(s.repo.listEvents(row.legalBodyId).at(-1)).toEqual(
      expect.objectContaining({
        kind: "lapsed",
        detail: { reason: "deadline_passed", blockTime: DEADLINE + 1 },
      }),
    );
    expect(calledMembers()).toEqual(["createdState", "head"]);
  });

  test("one second before the deadline, and at the deadline itself, the order does not lapse", async () => {
    for (const at of [DEADLINE - 1, DEADLINE]) {
      const row = await reservedOrder();
      recordSubmission(row.legalBodyId, 4);
      chain.head.mockResolvedValue({ number: LINK_HEAD.number, timestamp: BigInt(at) });
      chain.executorNonce.mockResolvedValue(4);
      chain.executorPendingNonce.mockResolvedValue(5);

      expect(await resolveOrder(deps(), row.legalBodyId), String(at)).toBe("waiting");
      expect(rowOf(row.legalBodyId).bindingState, String(at)).toBe("reserved");
    }
  });
});

// ── Rule 4: nothing was submitted ───────────────────────────────────────────────────────────

describe("rule 4: no submission recorded", () => {
  test("the link is checked again and the create submitted with the row's own link and signature, recorded at the nonce it was signed with", async () => {
    const row = await reservedOrder();
    signedNonce = 9;

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("resubmitted");

    expect(chain.estimateCreate.mock.calls).toEqual([[linkOfRow(row), row.linkSignature]]);
    expect(chain.submitCreate).toHaveBeenCalledOnce();
    expect(chain.submitCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ link: linkOfRow(row), signature: row.linkSignature }),
    );
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toEqual([
      expect.objectContaining({ nonce: 9 }),
    ]);
    expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
  });
});

// ── Rule 5: the newest submission's receipt ─────────────────────────────────────────────────

describe("rule 5: the newest submission's receipt", () => {
  test("it reads created while the body read absent: deployed from that receipt", async () => {
    const row = await reservedOrder();
    const sub = recordSubmission(row.legalBodyId, 0);
    chain.createOutcome.mockResolvedValue({
      status: "created",
      created: creation(row, sub.txHash),
    });

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("deployed");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("deployed");
    expect(after.createTxHash).toBe(sub.txHash);
    expect(after.deployedAt).toBe(DEPLOYED_AT);
    expect(after.nextBindingCheckAt).toBe(clock);
    expect(after.bindingCheckIntervalMs).toBe(60_000);
    expect(calledMembers()).toEqual(["createOutcome", "createdState", "head"]);
  });

  test("it reverted: the create is submitted again in the same pass", async () => {
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 0);
    chain.createOutcome.mockResolvedValue({ status: "reverted" });
    signedNonce = 1;

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("resubmitted");

    expect(s.repo.listDeploySubmissions(row.legalBodyId).map((sub) => sub.nonce)).toEqual([1, 0]);
    expect(chain.executorNonce).not.toHaveBeenCalled();
  });
});

// ── Rule 6: the submission's nonce is mined ─────────────────────────────────────────────────

describe("rule 6: the executor's mined count is above the submission's nonce", () => {
  test("the second read comes back created: deployed", async () => {
    const row = await reservedOrder();
    const sub = recordSubmission(row.legalBodyId, 3);
    chain.createOutcome
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "created", created: creation(row, sub.txHash) });
    chain.executorNonce.mockResolvedValue(4);

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("deployed");

    expect(rowOf(row.legalBodyId).createTxHash).toBe(sub.txHash);
    expect(chain.createOutcome).toHaveBeenCalledTimes(2);
    expect(chain.executorPendingNonce).not.toHaveBeenCalled();
    expect(chain.submitCreate).not.toHaveBeenCalled();
  });

  test("the second read comes back reverted, or absent: the bytes are dead, and the create is submitted again in the same pass", async () => {
    for (const second of ["reverted", "absent"] as const) {
      chain = fakeChain();
      const row = await reservedOrder();
      recordSubmission(row.legalBodyId, 3);
      chain.createOutcome
        .mockResolvedValueOnce({ status: "absent" })
        .mockResolvedValueOnce({ status: second });
      chain.executorNonce.mockResolvedValue(4);
      signedNonce = 4;

      expect(await resolveOrder(deps(), row.legalBodyId), second).toBe("resubmitted");

      expect(
        s.repo.listDeploySubmissions(row.legalBodyId).map((sub) => sub.nonce),
        second,
      ).toEqual([4, 3]);
      expect(chain.createOutcome, second).toHaveBeenCalledTimes(2);
      expect(chain.executorPendingNonce, second).not.toHaveBeenCalled();
    }
  });
});

// ── Rules 7 and 8: the node's pending count ─────────────────────────────────────────────────

describe("rule 7: the node's pending count is above the submission's nonce", () => {
  test("waiting: the pool holds that nonce, and nothing is called after the two nonce reads", async () => {
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 3);
    chain.executorNonce.mockResolvedValue(3);
    chain.executorPendingNonce.mockResolvedValue(4);

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("waiting");

    expect(calledMembers()).toEqual([
      "createOutcome",
      "createdState",
      "executorNonce",
      "executorPendingNonce",
      "head",
    ]);
    expect(chain.createOutcome).toHaveBeenCalledOnce();
    expect(chain.executorNonce).toHaveBeenCalledOnce();
    expect(chain.executorPendingNonce).toHaveBeenCalledOnce();
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 30_000);
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toHaveLength(1);
  });
});

describe("rule 8: the pending count equals the submission's nonce", () => {
  test("the node lost these bytes: they are sent again, and a fresh create never is", async () => {
    const row = await reservedOrder();
    const sub = recordSubmission(row.legalBodyId, 3);
    chain.executorNonce.mockResolvedValue(3);
    chain.executorPendingNonce.mockResolvedValue(3);

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("rebroadcast");

    expect(chain.rebroadcastCreate.mock.calls).toEqual([[sub.rawTx]]);
    expect(chain.submitCreate).not.toHaveBeenCalled();
    expect(chain.estimateCreate).not.toHaveBeenCalled();
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toHaveLength(1);
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 30_000);
  });

  test("a re-send that throws is waiting, changes nothing, and still never submits a fresh create", async () => {
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 3);
    chain.executorNonce.mockResolvedValue(3);
    chain.executorPendingNonce.mockResolvedValue(3);
    chain.rebroadcastCreate.mockRejectedValue(new TransportFailure());
    const events = s.repo.listEvents(row.legalBodyId).length;

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("waiting");

    expect(chain.submitCreate).not.toHaveBeenCalled();
    expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
    expect(s.repo.listEvents(row.legalBodyId)).toHaveLength(events);
    expect(lines.join("\n")).not.toContain("http");
  });
});

// ── Rule 9: a gap below the submission's nonce ──────────────────────────────────────────────

describe("rule 9: the pending count is below the submission's nonce", () => {
  test("9a: the gap's nonce is filled with the bytes recorded at it, here those of another order that has lapsed", async () => {
    const other = await reservedOrder();
    const filler = recordSubmission(other.legalBodyId, 3);
    expect(
      s.repo.lapse(other.legalBodyId, {
        reason: "owner_changed",
        blockTime: Number(LINK_HEAD.timestamp),
      }),
    ).toBe(true);
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 5);
    chain.executorNonce.mockResolvedValue(3);
    chain.executorPendingNonce.mockResolvedValue(3);

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("rebroadcast");

    expect(chain.rebroadcastCreate.mock.calls).toEqual([[filler.rawTx]]);
    expect(chain.submitCreate).not.toHaveBeenCalled();
    expect(rowOf(other.legalBodyId).bindingState).toBe("lapsed");
    expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
  });

  test("9a: a re-send of the gap's bytes that throws is waiting", async () => {
    const other = await reservedOrder();
    recordSubmission(other.legalBodyId, 3);
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 5);
    chain.executorNonce.mockResolvedValue(3);
    chain.executorPendingNonce.mockResolvedValue(3);
    chain.rebroadcastCreate.mockRejectedValue(new TransportFailure());

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("waiting");

    expect(chain.submitCreate).not.toHaveBeenCalled();
  });

  test("9b: with no bytes recorded at the gap's nonce, a create signed at that nonce is recorded and sent", async () => {
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 5);
    chain.executorNonce.mockResolvedValue(3);
    chain.executorPendingNonce.mockResolvedValue(3);
    signedNonce = 3;

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("resubmitted");

    expect(s.repo.listDeploySubmissions(row.legalBodyId).map((sub) => sub.nonce)).toEqual([3, 5]);
    expect(chain.rebroadcastCreate).not.toHaveBeenCalled();
    expect(opsLines().some((l) => l.opslog === "legal_body_executor_nonce_gap")).toBe(false);
  });

  test("9b: a create signed at any other nonce is neither recorded nor sent: waiting, with one error line naming both nonces", async () => {
    const row = await reservedOrder();
    recordSubmission(row.legalBodyId, 5);
    chain.executorNonce.mockResolvedValue(3);
    chain.executorPendingNonce.mockResolvedValue(3);
    signedNonce = 6;

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("waiting");
    clock += 30_000;
    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("waiting");

    expect(chain.submitCreate).toHaveBeenCalledTimes(2);
    expect(s.repo.listDeploySubmissions(row.legalBodyId).map((sub) => sub.nonce)).toEqual([5]);
    expect(opsLines().filter((l) => l.opslog === "legal_body_executor_nonce_gap")).toEqual([
      expect.objectContaining({
        level: "error",
        orderId: row.legalBodyId,
        pendingNonce: 3,
        submittedNonce: 5,
      }),
    ]);
  });
});

// ── The re-submit step ──────────────────────────────────────────────────────────────────────

describe("the re-submit step", () => {
  test("at three submissions it answers waiting and asks the chain nothing more", async () => {
    const row = await reservedOrder();
    for (const nonce of [0, 1, 2]) recordSubmission(row.legalBodyId, nonce);
    chain.createOutcome.mockResolvedValue({ status: "reverted" });

    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("waiting");

    expect(calledMembers()).toEqual(["createOutcome", "createdState", "head"]);
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toHaveLength(3);
  });

  test("a revoked order, an ineligible company, a refused link and a link accepted for another owner each answer waiting and send nothing", async () => {
    const cases: [string, (row: LegalBodyRecord) => void][] = [
      [
        "revoked",
        (row) =>
          s.repo.recordEvent(row.legalBodyId, "revoked", "operator:ops.example", null, {
            reason: "revoked by the operator",
          }),
      ],
      ["ineligible company", (row) => appendCheck(s.checks, row.companyId, "failed")],
      ["refused link", () => chain.estimateCreate.mockRejectedValue(revert("BadSignature"))],
      ["another owner", () => chain.identityOwner.mockResolvedValue(LATER_OWNER)],
    ];
    for (const [name, arrange] of cases) {
      chain = fakeChain();
      const row = await reservedOrder();
      arrange(row);

      expect(await resolveOrder(deps(), row.legalBodyId), name).toBe("waiting");

      expect(chain.submitCreate, name).not.toHaveBeenCalled();
      expect(s.repo.listDeploySubmissions(row.legalBodyId), name).toEqual([]);
      expect(rowOf(row.legalBodyId).bindingState, name).toBe("reserved");
      expect(rowOf(row.legalBodyId).nextBindingCheckAt, name).toBe(clock + 30_000);
    }
  });

  test("a create the record refuses, a create cap and a refusal thrown by the create each answer waiting, with nothing recorded", async () => {
    const cases: [string, () => Partial<LegalBodyOrderDeps>][] = [
      [
        "not recorded",
        () => {
          chain.submitCreate.mockResolvedValue({ status: "not_recorded" });
          return {};
        },
      ],
      ["deployment cap", () => ({ maxCreatesPerDay: 0 })],
      ["tenant cap", () => ({ maxCreatesPerTenantPerDay: 0 })],
      [
        "named revert",
        () => {
          chain.submitCreate.mockRejectedValue(revert("BadSignature"));
          return {};
        },
      ],
      [
        "gas ceiling",
        () => {
          chain.submitCreate.mockRejectedValue(new LegalBodyGasTooHighError(900_000n));
          return {};
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      chain = fakeChain();
      const row = await reservedOrder();
      const over = arrange();

      expect(await resolveOrder(deps(over), row.legalBodyId), name).toBe("waiting");

      expect(s.repo.listDeploySubmissions(row.legalBodyId), name).toEqual([]);
      expect(rowOf(row.legalBodyId).bindingState, name).toBe("reserved");
    }
  });
});

// ── A chain that cannot answer ──────────────────────────────────────────────────────────────

describe("a chain that cannot answer", () => {
  test("each chain method throwing answers unknown: no state change, the schedule moved, and the line names the error, never its message", async () => {
    const fail = () => new TransportFailure();
    /** Each case arranges a row that reaches the failing call, and makes that call throw. */
    const cases: [string, (row: LegalBodyRecord) => void][] = [
      ["head", () => chain.head.mockRejectedValue(fail())],
      ["createdState", () => chain.createdState.mockRejectedValue(fail())],
      [
        "createOutcome, rule 1",
        (row) => {
          recordSubmission(row.legalBodyId, 0);
          chain.createdState.mockResolvedValue("created");
          chain.createOutcome.mockRejectedValue(fail());
        },
      ],
      [
        "findCreation",
        () => {
          chain.createdState.mockResolvedValue("created");
          chain.findCreation.mockRejectedValue(fail());
        },
      ],
      [
        "createOutcome, rule 5",
        (row) => {
          recordSubmission(row.legalBodyId, 0);
          chain.createOutcome.mockRejectedValue(fail());
        },
      ],
      [
        "executorNonce",
        (row) => {
          recordSubmission(row.legalBodyId, 0);
          chain.executorNonce.mockRejectedValue(fail());
        },
      ],
      [
        "createOutcome, rule 6",
        (row) => {
          recordSubmission(row.legalBodyId, 0);
          chain.executorNonce.mockResolvedValue(1);
          chain.createOutcome
            .mockResolvedValueOnce({ status: "absent" })
            .mockRejectedValueOnce(fail());
        },
      ],
      [
        "executorPendingNonce",
        (row) => {
          recordSubmission(row.legalBodyId, 0);
          chain.executorPendingNonce.mockRejectedValue(fail());
        },
      ],
      ["the link check's read", () => chain.identityOwner.mockRejectedValue(fail())],
      ["submitCreate", () => chain.submitCreate.mockRejectedValue(fail())],
    ];
    for (const [name, arrange] of cases) {
      chain = fakeChain();
      lines = [];
      const row = await reservedOrder();
      arrange(row);
      const before = rowOf(row.legalBodyId);
      const events = s.repo.listEvents(row.legalBodyId);

      expect(await resolveOrder(deps(), row.legalBodyId), name).toBe("unknown");

      const after = rowOf(row.legalBodyId);
      expect(after.bindingState, name).toBe("reserved");
      expect(after.createTxHash, name).toBe(before.createTxHash);
      expect(after.nextBindingCheckAt, name).toBe(clock + 30_000);
      expect(after.bindingCheckIntervalMs, name).toBe(60_000);
      // Only the search's kept block may be written, by the pass that searches.
      const added = s.repo.listEvents(row.legalBodyId).slice(events.length);
      expect(
        added.map((e) => e.kind),
        name,
      ).toEqual(name === "findCreation" ? ["note"] : []);
      expect(chain.rebroadcastCreate, name).not.toHaveBeenCalled();
      expect(lines.join("\n"), name).not.toContain("http");
      expect(opsLines(), name).toEqual([
        expect.objectContaining({
          opslog: "legal_body_resolve",
          level: "warn",
          orderId: row.legalBodyId,
          outcome: "unknown",
          errorName: "HttpRequestError",
        }),
      ]);
    }
  });
});

// ── The row's owner ─────────────────────────────────────────────────────────────────────────

describe("the owner the created state is asked about", () => {
  test("is the row's, even when the registry names another owner now", async () => {
    const row = await reservedOrder();
    chain.identityOwner.mockResolvedValue(LATER_OWNER);

    await resolveOrder(deps(), row.legalBodyId);

    expect(chain.createdState.mock.calls).toEqual([
      [
        {
          bodyAddress: row.bodyAddress,
          identityOwner: IDENTITY_OWNER.address,
          blockNumber: LINK_HEAD.number,
        },
      ],
    ]);
  });
});

// ── One line per outcome ────────────────────────────────────────────────────────────────────

describe("the log", () => {
  test("a row that answers the same on every pass writes one line, and one more when its outcome changes", async () => {
    const row = await reservedOrder();
    const sub = recordSubmission(row.legalBodyId, 3);
    chain.executorNonce.mockResolvedValue(3);
    chain.executorPendingNonce.mockResolvedValue(4);

    for (let pass = 0; pass < 4; pass++) {
      expect(await resolveOrder(deps(), row.legalBodyId)).toBe("waiting");
      clock += 60_000;
    }
    chain.createOutcome.mockResolvedValue({
      status: "created",
      created: creation(row, sub.txHash),
    });
    expect(await resolveOrder(deps(), row.legalBodyId)).toBe("deployed");

    expect(opsLines()).toEqual([
      expect.objectContaining({ opslog: "legal_body_resolve", outcome: "waiting" }),
      expect.objectContaining({
        opslog: "legal_body_resolve",
        outcome: "deployed",
        txHash: sub.txHash,
      }),
    ]);
  });
});

// ── The link door's reverted branch ─────────────────────────────────────────────────────────

describe("a create that reverts on the door's second read", () => {
  // The door reads a draft's age against the process clock: here the clock is the real one, and
  // the chain's time stays the fake head's.
  beforeEach(() => {
    clock = Date.now();
  });

  /** The order's link, signed by the identity's owner, submitted through the door, which holds
   *  the order's lock while the resolver runs. */
  async function submitThroughDoor(row: LegalBodyRecord) {
    const signedMessage = await signedLink(linkFor(row, { agentId: BigInt(++agents) }));
    return submitLinkAndCreate(deps(), row.tenantId, row.legalBodyId, signedMessage);
  }

  test("is settled by one resolver pass under the door's lock: here the create is submitted again, and the door answers reserved", async () => {
    const row = draft();
    chain.createOutcome
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "reverted" })
      .mockResolvedValueOnce({ status: "reverted" });
    signedNonce = 0;
    chain.submitCreate.mockImplementationOnce(async (p) => {
      const create = nextSigned();
      signedNonce = 1;
      return p.record({ ...create }) ? { status: "sent", ...create } : { status: "not_recorded" };
    });

    const result = await submitThroughDoor(row);

    const after = rowOf(row.legalBodyId);
    expect(result).toEqual({ status: "reserved", order: toOrderView(after) });
    expect(s.repo.listDeploySubmissions(row.legalBodyId).map((sub) => sub.nonce)).toEqual([1, 0]);
    expect(chain.createOutcome).toHaveBeenCalledTimes(3);
    expect(chain.createdState).toHaveBeenCalledOnce();
    expect(after.nextBindingCheckAt).toBe(clock + 30_000);
  });

  test("here the body reads as another owner's: the pass lapses the order, and the door answers refused with order_lapsed", async () => {
    const row = draft();
    chain.createOutcome
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "reverted" });
    chain.createdState.mockResolvedValue("foreign");

    const result = await submitThroughDoor(row);

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("lapsed");
    expect(result).toEqual({
      status: "refused",
      code: "order_lapsed",
      order: toOrderView(after),
      detail: {},
    });
  });

  test("the resolver takes no lock of its own: it completes under the order's lock held by its caller", async () => {
    const row = await reservedOrder();

    const outcome = await withKeyedLock(orderLockKey(row.legalBodyId), () =>
      resolveOrder(deps(), row.legalBodyId),
    );

    expect(outcome).toBe("resubmitted");
  });
});
