/**
 * The binding check: whether the identity's pointer names the order's body, read at one block, and
 * what follows from it: the row's state (deployed, linked, broken, superseded), its next check, and
 * the pointer the identity's owner should write.
 *
 * The database is real (in memory). The chain is a fake whose answers each test steers; any member
 * it does not fake throws when read. The process clock is injected and starts at the wall clock,
 * because a row's `updatedAt` is written by the database's own clock; the fake head's time follows
 * the injected clock. Every name, company and filing number is an invention, and every key is one
 * of anvil's published test accounts.
 */
import type Database from "better-sqlite3";
import { type Address, type Hex, getAddress, keccak256, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LegalBodyChainPort } from "../../src/adapters/arc/legalBodyChain";
import {
  LEGAL_BODY_POINTER_KEY,
  checkBinding,
  nextBindingSchedule,
  pointerIntent,
  toBindingView,
} from "../../src/legalBody/binding";
import { type LegalBodyOrderDeps, createOrder } from "../../src/legalBody/orders";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { BindingState, LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import {
  ANVIL_ACCOUNT_2,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  BODY,
  H,
  IDENTITY_OWNER,
  type LegalBodyStores,
  OTHER_FACTORY,
  TransportFailure,
  asChainPort,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

const tenant = ANVIL_ACCOUNT_2.address;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The block every fake head is at. */
const HEAD_NUMBER = 9_000n;

let db: Database.Database;
let s: LegalBodyStores;
let chain: FakeChain;
let lines: string[];
/** The process clock the deps read, in unix milliseconds. */
let clock: number;
let filings = 0;
let agents = 900;
let bodies = 0;

const nowSeconds = () => Math.floor(clock / 1_000);

/**
 * The three reads the binding check makes, each a mock a test can steer, beside the link door's
 * fakes (never read here). By default the head is at `HEAD_NUMBER` and the clock's time, the
 * identity's pointer names no body, and every body is active.
 */
function fakeChain() {
  return {
    ...fakeLinkChainMembers(),
    head: vi.fn<LegalBodyChainPort["head"]>(async () => ({
      number: HEAD_NUMBER,
      timestamp: BigInt(nowSeconds()),
    })),
    linkedLegalBody: vi.fn<LegalBodyChainPort["linkedLegalBody"]>(async () => undefined),
    bodyStatus: vi.fn<LegalBodyChainPort["bodyStatus"]>(async () => "active"),
  };
}
type FakeChain = ReturnType<typeof fakeChain>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, tenant, "4001", Date.now());
  chain = fakeChain();
  clock = Date.now();
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
function draft(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyRecord {
  const companyId = customerCompany(s, tenant, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const view = createOrder(
    deps({ maxOpenPerTenant: 50, maxOrdersPerTenantPerDay: 50, ...over }),
    tenant,
    { companyId },
  );
  return rowOf(view.id);
}

/** An order reserved through the repository for its own identity (unless one is given) and its
 *  own body address. The signature is a placeholder: nothing here checks it. */
function reservedOrder(
  p: { agentId?: string; over?: Partial<LegalBodyOrderDeps> } = {},
): LegalBodyRecord {
  const row = draft(p.over);
  const n = ++bodies;
  expect(
    s.repo.reserve(row.legalBodyId, {
      agentId: p.agentId ?? String(++agents),
      identityOwner: IDENTITY_OWNER.address,
      linkDigest: keccak256(toHex(`link-${n}`)),
      linkDeadline: nowSeconds() + 3_600,
      linkSignature: `0x${"ab".repeat(65)}` as Hex,
      bodyAddress: getAddress(`0x${keccak256(toHex(`body-${n}`)).slice(-40)}`),
      observedAtBlock: 8_000,
      firstCheckAt: clock,
    }),
  ).toBe("reserved");
  return rowOf(row.legalBodyId);
}

/** A body created on chain: the order is `deployed`, and checked from now, every minute at first,
 *  as the resolver leaves it. `deployedAt` is in unix seconds. */
function deployedOrder(
  p: { agentId?: string; deployedAt?: number; over?: Partial<LegalBodyOrderDeps> } = {},
): LegalBodyRecord {
  const row = reservedOrder(p);
  const id = row.legalBodyId;
  expect(
    s.repo.markDeployed(id, {
      txHash: keccak256(toHex(`create-${id}`)),
      deployedAt: p.deployedAt ?? nowSeconds() - 60,
    }),
  ).toBe(true);
  expect(s.repo.scheduleBindingCheck(id, clock, MINUTE)).toBe(true);
  return rowOf(id);
}

/** A body the identity's pointer named: `linked`, checked every day. */
function linkedOrder(p: { agentId?: string } = {}): LegalBodyRecord {
  const id = deployedOrder(p).legalBodyId;
  expect(s.repo.markLinked(id, nowSeconds() - 30).outcome).toBe("linked");
  expect(s.repo.scheduleBindingCheck(id, clock, DAY)).toBe(true);
  return rowOf(id);
}

/** A body the pointer named and then stopped naming, for `reason`. */
function brokenOrder(reason = "not_linked"): LegalBodyRecord {
  const id = linkedOrder().legalBodyId;
  expect(s.repo.markBroken(id, { reason, observedAtBlock: 8_500 })).toBe(true);
  expect(s.repo.scheduleBindingCheck(id, clock, 2 * HOUR)).toBe(true);
  return rowOf(id);
}

/** A deployed body that gave its identity up to another order. */
function supersededOrder(): LegalBodyRecord {
  const id = deployedOrder().legalBodyId;
  expect(s.repo.supersede(id, "lb_replacement_order_placeholder_0001")).toBe(true);
  return rowOf(id);
}

const bodyOf = (row: LegalBodyRecord): Address => {
  if (row.bodyAddress === null) throw new Error(`order ${row.legalBodyId} holds no body`);
  return row.bodyAddress;
};

const agentOf = (row: LegalBodyRecord): string => {
  if (row.agentId === null) throw new Error(`order ${row.legalBodyId} holds no identity`);
  return row.agentId;
};

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

const brokenEvents = (id: string) => s.repo.listEvents(id).filter((e) => e.kind === "broken");

// ── checkBinding: the moves ─────────────────────────────────────────────────────────────────

describe("checkBinding moves the row by what the pointer names", () => {
  test("a deployed body the pointer names becomes linked, seen at the head's time, and is checked again in a day", async () => {
    const row = deployedOrder();
    // Any casing of the address is the same body.
    chain.linkedLegalBody.mockResolvedValue(bodyOf(row).toLowerCase() as Address);

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("linked");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("linked");
    expect(after.pointerSeenAt).toBe(nowSeconds());
    expect(after.nextBindingCheckAt).toBe(clock + DAY);
    expect(after.bindingCheckIntervalMs).toBe(DAY);
    expect(chain.bodyStatus).not.toHaveBeenCalled();
  });

  test("a linked body the pointer stops naming, while the body is active, is broken with not_linked, at the head's block", async () => {
    const row = linkedOrder();

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("broken");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("broken");
    expect(s.repo.latestBrokenReason(row.legalBodyId)).toBe("not_linked");
    expect(brokenEvents(row.legalBodyId).map((e) => e.detail)).toEqual([
      { reason: "not_linked", observedAtBlock: Number(HEAD_NUMBER) },
    ]);
    // The broken schedule starts over: an hour, then doubling.
    expect(after.nextBindingCheckAt).toBe(clock + HOUR);
    expect(after.bindingCheckIntervalMs).toBe(2 * HOUR);
    expect(toBindingView(after, "not_linked").intent).not.toBeNull();
    expect(opsLines()).toEqual([
      expect.objectContaining({
        opslog: "legal_body_binding",
        orderId: row.legalBodyId,
        outcome: "broken",
        reason: "not_linked",
        block: Number(HEAD_NUMBER),
      }),
    ]);
  });

  test("a linked body whose pointer names another body is broken too", async () => {
    const row = linkedOrder();
    chain.linkedLegalBody.mockResolvedValue(BODY);

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("broken");
    expect(s.repo.latestBrokenReason(row.legalBodyId)).toBe("not_linked");
  });

  test("a linked body that is dissolved is broken with dissolved, leaves the schedule for good, and carries no intent", async () => {
    const row = linkedOrder();
    chain.bodyStatus.mockResolvedValue("dissolved");

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("broken");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("broken");
    expect(brokenEvents(row.legalBodyId).map((e) => e.detail)).toEqual([
      { reason: "dissolved", observedAtBlock: Number(HEAD_NUMBER) },
    ]);
    expect(after.nextBindingCheckAt).toBeNull();
    expect(after.bindingCheckIntervalMs).toBeNull();
    expect(s.repo.listBindingDue(after, clock + 365 * DAY, 5)).toEqual([]);
    expect(toBindingView(after, s.repo.latestBrokenReason(row.legalBodyId)).intent).toBeNull();
  });

  test("a linked body that is winding down is broken with winding_down, checked again in an hour, and carries no intent", async () => {
    const row = linkedOrder();
    chain.bodyStatus.mockResolvedValue("winding_down");

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("broken");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("broken");
    expect(brokenEvents(row.legalBodyId).map((e) => e.detail)).toEqual([
      { reason: "winding_down", observedAtBlock: Number(HEAD_NUMBER) },
    ]);
    expect(after.nextBindingCheckAt).toBe(clock + HOUR);
    expect(after.bindingCheckIntervalMs).toBe(2 * HOUR);
    expect(s.repo.listBindingDue(after, clock + HOUR, 5).map((r) => r.legalBodyId)).toEqual([
      row.legalBodyId,
    ]);
    expect(toBindingView(after, s.repo.latestBrokenReason(row.legalBodyId)).intent).toBeNull();
  });

  test("a body broken while winding down stays on the broken schedule, and once its dissolution is vetoed (active again, the pointer passing) the next check links it", async () => {
    const row = linkedOrder();
    chain.bodyStatus.mockResolvedValue("winding_down");
    expect(await checkBinding(deps(), row.legalBodyId)).toBe("broken");

    // Still winding down an hour later: the pointer does not pass, the status is read again and
    // has not changed, and the wait doubles.
    clock = rowOf(row.legalBodyId).nextBindingCheckAt ?? 0;
    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 2 * HOUR);
    expect(chain.bodyStatus).toHaveBeenCalledTimes(2);
    expect(brokenEvents(row.legalBodyId)).toHaveLength(1);

    // The guardian vetoes the dissolution: the body is active again and the pointer passes, so
    // the row links, with no status read.
    clock = rowOf(row.legalBodyId).nextBindingCheckAt ?? 0;
    chain.linkedLegalBody.mockResolvedValue(bodyOf(row));
    expect(await checkBinding(deps(), row.legalBodyId)).toBe("linked");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("linked");
    expect(after.pointerSeenAt).toBe(nowSeconds());
    expect(after.nextBindingCheckAt).toBe(clock + DAY);
    expect(chain.bodyStatus).toHaveBeenCalledTimes(2);
  });

  test("a broken body the pointer names again becomes linked, seen at the new head's time", async () => {
    const row = brokenOrder();
    clock += 5 * MINUTE;
    chain.linkedLegalBody.mockResolvedValue(bodyOf(row));

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("linked");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("linked");
    expect(after.pointerSeenAt).toBe(nowSeconds());
    expect(after.nextBindingCheckAt).toBe(clock + DAY);
    expect(after.bindingCheckIntervalMs).toBe(DAY);
  });

  test("a superseded body the pointer names becomes linked likewise", async () => {
    const row = supersededOrder();
    chain.linkedLegalBody.mockResolvedValue(bodyOf(row));

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("linked");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("linked");
    expect(after.pointerSeenAt).toBe(nowSeconds());
    expect(after.nextBindingCheckAt).toBe(clock + DAY);
  });

  test("a body the pointer names in place of a linked one: the new one is linked, and the old one is broken with replaced and checked again in an hour", async () => {
    const old = linkedOrder({ agentId: "4242" });
    expect(old.nextBindingCheckAt).toBe(clock);
    expect(old.bindingCheckIntervalMs).toBe(DAY);
    const replacement = deployedOrder({ agentId: "4242" });
    chain.linkedLegalBody.mockResolvedValue(bodyOf(replacement));

    expect(await checkBinding(deps(), replacement.legalBodyId)).toBe("linked");

    expect(rowOf(replacement.legalBodyId).bindingState).toBe("linked");
    expect(rowOf(old.legalBodyId).bindingState).toBe("broken");
    expect(s.repo.latestBrokenReason(old.legalBodyId)).toBe("replaced");
    // The old body's broken schedule starts at its first interval, not at the day it held.
    expect(rowOf(old.legalBodyId).nextBindingCheckAt).toBe(clock + HOUR);
    expect(rowOf(old.legalBodyId).bindingCheckIntervalMs).toBe(HOUR);
    expect(opsLines()).toEqual([
      expect.objectContaining({
        opslog: "legal_body_binding",
        orderId: replacement.legalBodyId,
        outcome: "linked",
        block: Number(HEAD_NUMBER),
        replaced: [old.legalBodyId],
      }),
    ]);
  });

  test("a move another order's transaction made first is not made again: the check is unchanged, and the new state's schedule starts over", async () => {
    const old = linkedOrder({ agentId: "4343" });
    const replacement = deployedOrder({ agentId: "4343" });
    chain.linkedLegalBody.mockResolvedValue(bodyOf(replacement));
    // While the old body's status is read, the replacement is linked by its own check.
    chain.bodyStatus.mockImplementation(async () => {
      expect(s.repo.markLinked(replacement.legalBodyId, nowSeconds()).outcome).toBe("linked");
      return "active";
    });

    expect(await checkBinding(deps(), old.legalBodyId)).toBe("unchanged");

    const after = rowOf(old.legalBodyId);
    expect(after.bindingState).toBe("broken");
    expect(brokenEvents(old.legalBodyId)).toHaveLength(1);
    expect(s.repo.latestBrokenReason(old.legalBodyId)).toBe("replaced");
    expect(after.nextBindingCheckAt).toBe(clock + HOUR);
    expect(after.bindingCheckIntervalMs).toBe(2 * HOUR);
  });
});

describe("checkBinding leaves the row's state when the pointer has not moved", () => {
  test("a linked body the pointer still names is unchanged, with no status read, and checked again in a day", async () => {
    const row = linkedOrder();
    chain.linkedLegalBody.mockResolvedValue(bodyOf(row));
    const events = s.repo.listEvents(row.legalBodyId).length;

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("linked");
    expect(after.pointerSeenAt).toBe(row.pointerSeenAt);
    expect(after.nextBindingCheckAt).toBe(clock + DAY);
    expect(s.repo.listEvents(row.legalBodyId)).toHaveLength(events);
    expect(chain.bodyStatus).not.toHaveBeenCalled();
  });

  test("a deployed body the pointer does not name is unchanged, never read for its status, and checked a minute later, then two", async () => {
    const row = deployedOrder();
    chain.linkedLegalBody.mockResolvedValue(BODY);

    const gaps: number[] = [];
    for (let pass = 1; pass <= 3; pass++) {
      expect(await checkBinding(deps(), row.legalBodyId), `pass ${pass}`).toBe("unchanged");
      const next = rowOf(row.legalBodyId).nextBindingCheckAt;
      if (next === null) throw new Error("the row left the schedule");
      gaps.push(next - clock);
      clock = next;
    }
    expect(gaps).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE]);
    expect(rowOf(row.legalBodyId).bindingState).toBe("deployed");
    expect(chain.bodyStatus).not.toHaveBeenCalled();
  });

  test("a broken body the pointer does not name is unchanged and never read for its status", async () => {
    const row = brokenOrder();

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("broken");
    expect(after.nextBindingCheckAt).toBe(clock + 2 * HOUR);
    expect(after.bindingCheckIntervalMs).toBe(4 * HOUR);
    expect(chain.bodyStatus).not.toHaveBeenCalled();
  });

  test("a body broken because it was dissolved, checked again, stays off the schedule, with no status read", async () => {
    const row = brokenOrder("dissolved");

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBeNull();
    expect(rowOf(row.legalBodyId).bindingCheckIntervalMs).toBeNull();
    expect(chain.bodyStatus).not.toHaveBeenCalled();
  });

  test("a deployed body never linked within 7 days of its creation leaves the schedule", async () => {
    const row = deployedOrder({ deployedAt: nowSeconds() - 7 * 24 * 3_600 });

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBeNull();
    expect(rowOf(row.legalBodyId).bindingState).toBe("deployed");
  });

  test("a body broken for 30 days leaves the schedule", async () => {
    const row = brokenOrder();
    db.prepare("UPDATE legal_bodies SET updated_at = ? WHERE legal_body_id = ?").run(
      sqliteUtcTimestamp(clock - 30 * DAY),
      row.legalBodyId,
    );

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBeNull();
  });
});

/** A body broken when it was found winding down, checked every two hours, with its last state
 *  move a day back, so a write that moved the row would show. */
function windingDownOrder(p: { superseded?: boolean } = {}): LegalBodyRecord {
  const id = brokenOrder("winding_down").legalBodyId;
  if (p.superseded)
    expect(s.repo.supersede(id, "lb_replacement_order_placeholder_0002")).toBe(true);
  db.prepare("UPDATE legal_bodies SET updated_at = ? WHERE legal_body_id = ?").run(
    sqliteUtcTimestamp(clock - DAY),
    id,
  );
  return rowOf(id);
}

describe("a body last found winding down has its status read again, at the same block", () => {
  test("dissolved since: dissolved is recorded with no state move, and the row leaves the schedule with no intent", async () => {
    const row = windingDownOrder();
    chain.bodyStatus.mockResolvedValue("dissolved");

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("broken");
    expect(after.updatedAt).toBe(row.updatedAt);
    expect(brokenEvents(row.legalBodyId).map((e) => e.detail)).toEqual([
      { reason: "winding_down", observedAtBlock: 8_500 },
      { reason: "dissolved", observedAtBlock: Number(HEAD_NUMBER) },
    ]);
    expect(after.nextBindingCheckAt).toBeNull();
    expect(after.bindingCheckIntervalMs).toBeNull();
    expect(toBindingView(after, s.repo.latestBrokenReason(row.legalBodyId)).intent).toBeNull();

    expect(chain.head).toHaveBeenCalledTimes(1);
    expect(chain.linkedLegalBody).toHaveBeenCalledWith(BigInt(agentOf(row)), HEAD_NUMBER);
    expect(chain.bodyStatus).toHaveBeenCalledTimes(1);
    expect(chain.bodyStatus).toHaveBeenCalledWith(bodyOf(row), HEAD_NUMBER);
    expect(chain.linkedLegalBody.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      chain.bodyStatus.mock.invocationCallOrder[0] ?? 0,
    );
    expect(opsLines()).toEqual([
      expect.objectContaining({
        opslog: "legal_body_binding",
        orderId: row.legalBodyId,
        outcome: "reason_changed",
        reason: "dissolved",
        block: Number(HEAD_NUMBER),
      }),
    ]);
  });

  test("active again (a veto) while the pointer does not pass: not_linked is recorded, the intent is served again, and the broken schedule goes on", async () => {
    const row = windingDownOrder();
    chain.bodyStatus.mockResolvedValue("active");

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("broken");
    expect(after.updatedAt).toBe(row.updatedAt);
    expect(s.repo.latestBrokenReason(row.legalBodyId)).toBe("not_linked");
    expect(brokenEvents(row.legalBodyId).map((e) => e.detail)).toEqual([
      { reason: "winding_down", observedAtBlock: 8_500 },
      { reason: "not_linked", observedAtBlock: Number(HEAD_NUMBER) },
    ]);
    // Not started over: the row waits its two hours and doubles them.
    expect(after.nextBindingCheckAt).toBe(clock + 2 * HOUR);
    expect(after.bindingCheckIntervalMs).toBe(4 * HOUR);
    expect(toBindingView(after, s.repo.latestBrokenReason(row.legalBodyId)).intent).toEqual({
      action: "setLegalBodyPointer",
      agentId: agentOf(row),
      body: bodyOf(row),
      chainId: CHAIN_ID,
    });
  });

  test("still winding down: nothing is recorded, and the wait doubles", async () => {
    const row = windingDownOrder();
    chain.bodyStatus.mockResolvedValue("winding_down");

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    const after = rowOf(row.legalBodyId);
    expect(brokenEvents(row.legalBodyId)).toHaveLength(1);
    expect(after.nextBindingCheckAt).toBe(clock + 2 * HOUR);
    expect(after.bindingCheckIntervalMs).toBe(4 * HOUR);
    expect(chain.bodyStatus).toHaveBeenCalledWith(bodyOf(row), HEAD_NUMBER);
    expect(opsLines()).toEqual([]);
  });

  test("a superseded body that was linked once and last found winding down is read the same way", async () => {
    const row = windingDownOrder({ superseded: true });
    expect(row.bindingState).toBe("superseded");
    chain.bodyStatus.mockResolvedValue("dissolved");

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("superseded");
    expect(s.repo.latestBrokenReason(row.legalBodyId)).toBe("dissolved");
    expect(after.nextBindingCheckAt).toBeNull();
    expect(toBindingView(after, "dissolved").intent).toBeNull();
  });

  test("a reason recorded since the break does not move it: the 30 days still count from the break", async () => {
    const row = windingDownOrder();
    db.prepare("UPDATE legal_bodies SET updated_at = ? WHERE legal_body_id = ?").run(
      sqliteUtcTimestamp(clock - 30 * DAY),
      row.legalBodyId,
    );
    chain.bodyStatus.mockResolvedValue("active");

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unchanged");

    expect(s.repo.latestBrokenReason(row.legalBodyId)).toBe("not_linked");
    expect(rowOf(row.legalBodyId).updatedAt).toBe(sqliteUtcTimestamp(clock - 30 * DAY));
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBeNull();
  });

  test("a status read that throws is unknown: nothing is recorded, and the schedule moves forward", async () => {
    const row = windingDownOrder();
    chain.bodyStatus.mockRejectedValue(new TransportFailure());

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unknown");

    expect(brokenEvents(row.legalBodyId)).toHaveLength(1);
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + 2 * HOUR);
    expect(lines.join("\n")).not.toMatch(/rpc\.example|key-in-path|HTTP request failed/);
    expect(opsLines()).toEqual([
      expect.objectContaining({ outcome: "unknown", stage: "body_status" }),
    ]);
  });
});

describe("checkBinding reads at one block", () => {
  test("the pointer is read at the head's block number, after the head", async () => {
    const row = deployedOrder();

    await checkBinding(deps(), row.legalBodyId);

    expect(chain.head).toHaveBeenCalledTimes(1);
    expect(chain.linkedLegalBody).toHaveBeenCalledTimes(1);
    expect(chain.linkedLegalBody).toHaveBeenCalledWith(BigInt(agentOf(row)), HEAD_NUMBER);
    expect(chain.head.mock.invocationCallOrder[0]).toBeLessThan(
      chain.linkedLegalBody.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("the body's status is read at the same block as the pointer", async () => {
    const row = linkedOrder();

    await checkBinding(deps(), row.legalBodyId);

    expect(chain.head).toHaveBeenCalledTimes(1);
    expect(chain.linkedLegalBody).toHaveBeenCalledWith(BigInt(agentOf(row)), HEAD_NUMBER);
    expect(chain.bodyStatus).toHaveBeenCalledTimes(1);
    expect(chain.bodyStatus).toHaveBeenCalledWith(bodyOf(row), HEAD_NUMBER);
  });
});

// ── checkBinding: a chain that cannot answer ────────────────────────────────────────────────

describe("a chain that cannot answer", () => {
  test("a head that throws is unknown: nothing moves, the schedule moves forward by its interval, and the log names the error, never its text", async () => {
    const row = deployedOrder();
    chain.head.mockRejectedValue(new TransportFailure());
    const events = s.repo.listEvents(row.legalBodyId).length;

    const gaps: number[] = [];
    for (let pass = 1; pass <= 3; pass++) {
      expect(await checkBinding(deps(), row.legalBodyId), `pass ${pass}`).toBe("unknown");
      const next = rowOf(row.legalBodyId).nextBindingCheckAt;
      if (next === null) throw new Error("the row left the schedule");
      expect(s.repo.listBindingDue(row, clock, 5), `pass ${pass}`).toEqual([]);
      gaps.push(next - clock);
      clock = next;
    }
    expect(gaps).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE]);
    expect(rowOf(row.legalBodyId).bindingState).toBe("deployed");
    expect(s.repo.listEvents(row.legalBodyId)).toHaveLength(events);

    expect(lines.join("\n")).not.toMatch(/rpc\.example|key-in-path|HTTP request failed/);
    expect(opsLines()[0]).toMatchObject({
      opslog: "legal_body_binding",
      orderId: row.legalBodyId,
      outcome: "unknown",
      stage: "head",
      errorName: "HttpRequestError",
    });
  });

  test("a pointer read that throws leaves a linked body linked, checked again in a day", async () => {
    const row = linkedOrder();
    chain.linkedLegalBody.mockRejectedValue(new TransportFailure());

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unknown");

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("linked");
    expect(after.nextBindingCheckAt).toBe(clock + DAY);
    expect(chain.bodyStatus).not.toHaveBeenCalled();
  });

  test("a status read that throws leaves a linked body linked, with no broken event", async () => {
    const row = linkedOrder();
    chain.bodyStatus.mockRejectedValue(new TransportFailure());

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("unknown");

    expect(rowOf(row.legalBodyId).bindingState).toBe("linked");
    expect(brokenEvents(row.legalBodyId)).toEqual([]);
    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBe(clock + DAY);
    expect(opsLines()[0]).toMatchObject({ outcome: "unknown", stage: "body_status" });
  });
});

// ── checkBinding: rows it does not check ────────────────────────────────────────────────────

describe("rows the binding check does not read", () => {
  test("a draft, an abandoned order and an unknown id are not_checkable, with no chain call", async () => {
    const aDraft = draft();
    const anAbandoned = draft();
    expect(s.repo.abandon(anAbandoned.legalBodyId, "test")).toBe(true);

    for (const id of [aDraft.legalBodyId, anAbandoned.legalBodyId, "lb_unknown"])
      expect(await checkBinding(deps(), id), id).toBe("not_checkable");
    expect(calledMembers()).toEqual([]);
  });

  test("a lapsed order is not_checkable, and a schedule it still held is cleared", async () => {
    const row = reservedOrder();
    expect(
      s.repo.lapse(row.legalBodyId, { reason: "deadline_passed", blockTime: nowSeconds() }),
    ).toBe(true);
    db.prepare(
      "UPDATE legal_bodies SET next_binding_check_at = ?, binding_check_interval_ms = ? WHERE legal_body_id = ?",
    ).run(clock, MINUTE, row.legalBodyId);

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("not_checkable");

    expect(rowOf(row.legalBodyId).nextBindingCheckAt).toBeNull();
    expect(rowOf(row.legalBodyId).bindingCheckIntervalMs).toBeNull();
    expect(calledMembers()).toEqual([]);
  });

  test("a reserved order is not_checkable, and its schedule, which settles it, is left as it was", async () => {
    const row = reservedOrder();

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("not_checkable");

    expect(rowOf(row.legalBodyId)).toEqual(row);
    expect(calledMembers()).toEqual([]);
  });

  test("a body of another deployment is not_checkable, with no chain call and nothing changed", async () => {
    const row = deployedOrder({
      over: { deployment: { chainId: CHAIN_ID, factory: OTHER_FACTORY } },
    });

    expect(await checkBinding(deps(), row.legalBodyId)).toBe("not_checkable");

    expect(rowOf(row.legalBodyId)).toEqual(row);
    expect(calledMembers()).toEqual([]);
  });
});

// ── nextBindingSchedule ─────────────────────────────────────────────────────────────────────

/** A fixed instant, in unix milliseconds. */
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const NOW_S = NOW / 1_000;

/** A row as the repository reads it, in any state, with every column a test does not set filled
 *  for a body deployed an hour ago. */
function record(over: Partial<LegalBodyRecord> = {}): LegalBodyRecord {
  return {
    legalBodyId: "lb_000000000000000000000000000000000001",
    publicId: "00000000-0000-4000-8000-000000000001",
    tenantId: tenant,
    companyId: "co_example",
    chainId: CHAIN_ID,
    factory: FACTORY,
    guardian: tenant,
    amendmentDelay: 172_800,
    oaManifestHash: H("a"),
    oaManifestVersion: 1,
    agentId: "42",
    identityOwner: IDENTITY_OWNER.address,
    linkDigest: H("d"),
    linkDeadline: NOW_S - 3_000,
    linkSignature: `0x${"ab".repeat(65)}` as Hex,
    bodyAddress: BODY,
    createTxHash: H("c"),
    deployedAt: NOW_S - 3_600,
    bindingState: "deployed",
    pointerSeenAt: null,
    nextBindingCheckAt: NOW,
    bindingCheckIntervalMs: MINUTE,
    createdAt: sqliteUtcTimestamp(NOW - DAY),
    updatedAt: sqliteUtcTimestamp(NOW - HOUR),
    ...over,
  };
}

describe("nextBindingSchedule", () => {
  describe("a body never linked (deployed)", () => {
    test("waits its interval, then doubles it, up to an hour", () => {
      expect(
        nextBindingSchedule(record({ bindingCheckIntervalMs: MINUTE }), NOW, false, undefined),
      ).toEqual({ nextAt: NOW + MINUTE, intervalMs: 2 * MINUTE });
      expect(
        nextBindingSchedule(record({ bindingCheckIntervalMs: 32 * MINUTE }), NOW, false, undefined),
      ).toEqual({ nextAt: NOW + 32 * MINUTE, intervalMs: HOUR });
      expect(
        nextBindingSchedule(record({ bindingCheckIntervalMs: HOUR }), NOW, false, undefined),
      ).toEqual({
        nextAt: NOW + HOUR,
        intervalMs: HOUR,
      });
    });

    test("an interval outside its range is brought into it, and a row with none starts at a minute", () => {
      expect(
        nextBindingSchedule(record({ bindingCheckIntervalMs: DAY }), NOW, false, undefined),
      ).toEqual({
        nextAt: NOW + HOUR,
        intervalMs: HOUR,
      });
      expect(
        nextBindingSchedule(
          record({ nextBindingCheckAt: null, bindingCheckIntervalMs: null }),
          NOW,
          false,
          undefined,
        ),
      ).toEqual({ nextAt: NOW + MINUTE, intervalMs: 2 * MINUTE });
    });

    test("moved: the interval restarts at a minute", () => {
      expect(
        nextBindingSchedule(record({ bindingCheckIntervalMs: HOUR }), NOW, true, undefined),
      ).toEqual({
        nextAt: NOW + MINUTE,
        intervalMs: 2 * MINUTE,
      });
    });

    test("stops 7 days after deployedAt, which is in seconds", () => {
      const sevenDays = 7 * 24 * 3_600;
      expect(
        nextBindingSchedule(record({ deployedAt: NOW_S - sevenDays + 1 }), NOW, false, undefined),
      ).toEqual({ nextAt: NOW + MINUTE, intervalMs: 2 * MINUTE });
      expect(
        nextBindingSchedule(record({ deployedAt: NOW_S - sevenDays }), NOW, false, undefined),
      ).toBeUndefined();
    });
  });

  describe("a superseded body", () => {
    test("never linked (no pointer seen): the never-linked schedule, and its 7 days from deployedAt", () => {
      const superseded = record({ bindingState: "superseded", pointerSeenAt: null });
      expect(nextBindingSchedule(superseded, NOW, false, undefined)).toEqual({
        nextAt: NOW + MINUTE,
        intervalMs: 2 * MINUTE,
      });
      expect(
        nextBindingSchedule(
          { ...superseded, deployedAt: NOW_S - 7 * 24 * 3_600, updatedAt: sqliteUtcTimestamp(NOW) },
          NOW,
          false,
          undefined,
        ),
      ).toBeUndefined();
    });

    test("linked once (a pointer seen): the broken schedule, and its 30 days from updatedAt", () => {
      const superseded = record({
        bindingState: "superseded",
        pointerSeenAt: NOW_S - 2 * 3_600,
        deployedAt: NOW_S - 20 * 24 * 3_600,
      });
      expect(nextBindingSchedule(superseded, NOW, false, "not_linked")).toEqual({
        nextAt: NOW + HOUR,
        intervalMs: 2 * HOUR,
      });
      expect(
        nextBindingSchedule(
          { ...superseded, updatedAt: sqliteUtcTimestamp(NOW - 30 * DAY) },
          NOW,
          false,
          "not_linked",
        ),
      ).toBeUndefined();
    });

    test("linked once and broken because it was dissolved: no further check", () => {
      const superseded = record({ bindingState: "superseded", pointerSeenAt: NOW_S - 2 * 3_600 });
      expect(nextBindingSchedule(superseded, NOW, false, "dissolved")).toBeUndefined();
    });

    test("linked once and broken while winding down: the broken schedule goes on", () => {
      const superseded = record({ bindingState: "superseded", pointerSeenAt: NOW_S - 2 * 3_600 });
      expect(nextBindingSchedule(superseded, NOW, false, "winding_down")).toEqual({
        nextAt: NOW + HOUR,
        intervalMs: 2 * HOUR,
      });
    });
  });

  describe("a linked body", () => {
    test("is checked every 24 hours, moved or not, whatever its interval held", () => {
      const linked = record({ bindingState: "linked", pointerSeenAt: NOW_S - 60 });
      for (const moved of [true, false])
        for (const bindingCheckIntervalMs of [MINUTE, DAY, 2 * DAY])
          expect(
            nextBindingSchedule({ ...linked, bindingCheckIntervalMs }, NOW, moved, undefined),
            `${moved} ${bindingCheckIntervalMs}`,
          ).toEqual({ nextAt: NOW + DAY, intervalMs: DAY });
    });

    test("is never taken off the schedule by age, nor by an old break it came back from", () => {
      const linked = record({
        bindingState: "linked",
        pointerSeenAt: NOW_S - 60,
        deployedAt: NOW_S - 400 * 24 * 3_600,
        updatedAt: sqliteUtcTimestamp(NOW - 400 * DAY),
      });
      for (const reason of ["winding_down", "dissolved"])
        expect(nextBindingSchedule(linked, NOW, false, reason), reason).toEqual({
          nextAt: NOW + DAY,
          intervalMs: DAY,
        });
    });
  });

  describe("a broken body", () => {
    const broken = record({
      bindingState: "broken",
      pointerSeenAt: NOW_S - 2 * 3_600,
      deployedAt: NOW_S - 20 * 24 * 3_600,
    });

    test("moved: an hour, then doubling", () => {
      expect(
        nextBindingSchedule({ ...broken, bindingCheckIntervalMs: DAY }, NOW, true, "not_linked"),
      ).toEqual({ nextAt: NOW + HOUR, intervalMs: 2 * HOUR });
    });

    test("not moved: waits its interval and doubles it, up to 24 hours", () => {
      const steps: [number, number, number][] = [
        [2 * HOUR, 2 * HOUR, 4 * HOUR],
        [16 * HOUR, 16 * HOUR, DAY],
        [DAY, DAY, DAY],
        [MINUTE, HOUR, 2 * HOUR],
      ];
      for (const [stored, wait, interval] of steps)
        expect(
          nextBindingSchedule(
            { ...broken, bindingCheckIntervalMs: stored },
            NOW,
            false,
            "not_linked",
          ),
          String(stored),
        ).toEqual({ nextAt: NOW + wait, intervalMs: interval });
    });

    test("stops 30 days after its last state move (updatedAt, stored as UTC text), whatever deployedAt says", () => {
      const waiting = { ...broken, bindingCheckIntervalMs: 2 * HOUR };
      expect(
        nextBindingSchedule(
          { ...waiting, updatedAt: sqliteUtcTimestamp(NOW - 30 * DAY + 1_000) },
          NOW,
          false,
          "not_linked",
        ),
      ).toEqual({ nextAt: NOW + 2 * HOUR, intervalMs: 4 * HOUR });
      expect(
        nextBindingSchedule(
          { ...waiting, updatedAt: sqliteUtcTimestamp(NOW - 30 * DAY) },
          NOW,
          false,
          "not_linked",
        ),
      ).toBeUndefined();
    });

    test("broken because it was dissolved: no further check, moved or not", () => {
      expect(nextBindingSchedule(broken, NOW, true, "dissolved")).toBeUndefined();
      expect(nextBindingSchedule(broken, NOW, false, "dissolved")).toBeUndefined();
    });

    test("broken while winding down: the broken schedule goes on, and stops 30 days after the move", () => {
      expect(nextBindingSchedule(broken, NOW, true, "winding_down")).toEqual({
        nextAt: NOW + HOUR,
        intervalMs: 2 * HOUR,
      });
      expect(
        nextBindingSchedule(
          { ...broken, bindingCheckIntervalMs: 4 * HOUR },
          NOW,
          false,
          "winding_down",
        ),
      ).toEqual({ nextAt: NOW + 4 * HOUR, intervalMs: 8 * HOUR });
      expect(
        nextBindingSchedule(
          { ...broken, updatedAt: sqliteUtcTimestamp(NOW - 30 * DAY) },
          NOW,
          false,
          "winding_down",
        ),
      ).toBeUndefined();
    });

    test("broken because it was replaced: the broken schedule goes on", () => {
      expect(nextBindingSchedule(broken, NOW, true, "replaced")).toEqual({
        nextAt: NOW + HOUR,
        intervalMs: 2 * HOUR,
      });
    });
  });

  test.each(["draft", "reserved", "lapsed", "abandoned"] as const)(
    "a %s row has no binding schedule",
    (bindingState) => {
      expect(nextBindingSchedule(record({ bindingState }), NOW, true, undefined)).toBeUndefined();
      expect(nextBindingSchedule(record({ bindingState }), NOW, false, undefined)).toBeUndefined();
    },
  );
});

// ── pointerIntent and toBindingView ─────────────────────────────────────────────────────────

/** A row in each state, with the columns that state holds. */
function rowIn(bindingState: BindingState, over: Partial<LegalBodyRecord> = {}): LegalBodyRecord {
  const unlinked = bindingState === "draft" || bindingState === "abandoned";
  const deployed = ["deployed", "linked", "broken", "superseded"].includes(bindingState);
  return record({
    bindingState,
    agentId: unlinked ? null : "42",
    identityOwner: unlinked ? null : IDENTITY_OWNER.address,
    linkDigest: unlinked ? null : H("d"),
    linkDeadline: unlinked ? null : NOW_S - 3_000,
    linkSignature: unlinked ? null : (`0x${"ab".repeat(65)}` as Hex),
    bodyAddress: unlinked ? null : BODY,
    createTxHash: deployed ? H("c") : null,
    deployedAt: deployed ? NOW_S - 3_600 : null,
    pointerSeenAt: bindingState === "linked" || bindingState === "broken" ? NOW_S - 600 : null,
    nextBindingCheckAt: unlinked || bindingState === "lapsed" ? null : NOW + MINUTE,
    bindingCheckIntervalMs: unlinked || bindingState === "lapsed" ? null : 2 * MINUTE,
    ...over,
  });
}

const INTENT = { action: "setLegalBodyPointer", agentId: "42", body: BODY, chainId: CHAIN_ID };

describe("pointerIntent and toBindingView", () => {
  test("the pointer's key is legalBody", () => {
    expect(LEGAL_BODY_POINTER_KEY).toBe("legalBody");
  });

  test.each([
    ["deployed", undefined],
    ["broken", "not_linked"],
    ["broken", "replaced"],
    ["superseded", undefined],
  ] as const)("a %s body (latest break: %s) carries the intent to point at it", (state, reason) => {
    const row = rowIn(state);
    expect(pointerIntent(row, reason)).toEqual(INTENT);
    expect(toBindingView(row, reason)).toEqual({
      state,
      agentId: "42",
      bodyAddress: BODY,
      intent: INTENT,
      pointerSeenAt: row.pointerSeenAt,
      nextCheckAt: NOW + MINUTE,
    });
  });

  test("a superseded body that was linked once carries the intent too", () => {
    const row = rowIn("superseded", { pointerSeenAt: NOW_S - 600 });
    expect(pointerIntent(row, "not_linked")).toEqual(INTENT);
    expect(toBindingView(row, "not_linked").pointerSeenAt).toBe(NOW_S - 600);
  });

  test("a body winding down or dissolved carries no intent: writing a pointer would not link it", () => {
    for (const row of [rowIn("broken"), rowIn("superseded", { pointerSeenAt: NOW_S - 600 })])
      for (const reason of ["winding_down", "dissolved"]) {
        expect(pointerIntent(row, reason), `${row.bindingState} ${reason}`).toBeUndefined();
        expect(toBindingView(row, reason), `${row.bindingState} ${reason}`).toEqual({
          state: row.bindingState,
          agentId: "42",
          bodyAddress: BODY,
          intent: null,
          pointerSeenAt: NOW_S - 600,
          nextCheckAt: NOW + MINUTE,
        });
      }
  });

  test("a linked body carries no intent, and shows when its pointer was seen", () => {
    const row = rowIn("linked");
    expect(pointerIntent(row, undefined)).toBeUndefined();
    expect(toBindingView(row, undefined)).toEqual({
      state: "linked",
      agentId: "42",
      bodyAddress: BODY,
      intent: null,
      pointerSeenAt: NOW_S - 600,
      nextCheckAt: NOW + MINUTE,
    });
  });

  test.each(["draft", "reserved", "lapsed", "abandoned"] as const)(
    "a %s order carries no intent",
    (state) => {
      const row = rowIn(state);
      expect(pointerIntent(row, undefined)).toBeUndefined();
      expect(toBindingView(row, undefined)).toEqual({
        state,
        agentId: row.agentId,
        bodyAddress: row.bodyAddress,
        intent: null,
        pointerSeenAt: null,
        nextCheckAt: row.nextBindingCheckAt,
      });
    },
  );

  test("the view holds exactly its six fields, and serialises as it is", () => {
    const view = toBindingView(rowIn("deployed"), undefined);
    expect(Object.keys(view).sort()).toEqual([
      "agentId",
      "bodyAddress",
      "intent",
      "nextCheckAt",
      "pointerSeenAt",
      "state",
    ]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});
