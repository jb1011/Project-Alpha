/**
 * The facts an order's view and its binding's view carry beside the row: why a reservation lapsed,
 * why a linked body broke, which order superseded or replaced it, whether it was revoked, and the
 * company name the declaration states. Each is read from the event log or the declaration, by the
 * repository's own moves, and every door that answers a view carries them.
 *
 * The database is real (in memory); the chain is a fake whose answers each test steers. Every
 * name, company and filing number is an invention, and every key is one of anvil's published test
 * accounts.
 */
import type Database from "better-sqlite3";
import { type Hex, getAddress, keccak256, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LegalBodyChainPort } from "../../src/adapters/arc/legalBodyChain";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { toBindingView } from "../../src/legalBody/binding";
import {
  type LegalBodyOrderDeps,
  createOrder,
  orderViewFacts,
  toOrderView,
} from "../../src/legalBody/orders";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type {
  BindingState,
  LapseReason,
  LegalBodyRecord,
  SqliteLegalBodyRepository,
} from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_2,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  IDENTITY_OWNER,
  JWT_SECRET,
  type Json,
  type LegalBodyStores,
  answerOf,
  asChainPort,
  bindingViewOf,
  call,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  linkFor,
  openLegalBodyStores,
  orderViewOf,
  sessionOf,
  signedLink,
} from "../helpers/legalBodyFixtures";
import { startMcpTestClient } from "../mcp/helpers";

const tenant = ANVIL_ACCOUNT_2;
const OPERATOR = "operator:ops.example" as const;
const HEAD_NUMBER = 9_000n;

/** The seventeen fields of the order view as they were, then the six facts, in order. */
const ORDER_VIEW_KEYS = [
  "id",
  "publicId",
  "companyId",
  "state",
  "chainId",
  "factory",
  "guardian",
  "amendmentDelay",
  "agreement",
  "agentId",
  "identityOwner",
  "bodyAddress",
  "linkDeadline",
  "createTxHash",
  "deployedAt",
  "pointerSeenAt",
  "createdAt",
  "lapseReason",
  "brokenReason",
  "revoked",
  "supersededBy",
  "replacedBy",
  "companyName",
];

let db: Database.Database;
let s: LegalBodyStores;
let made = 0;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, tenant.address, "5001", Date.now());
  // The doors' ops lines are not what these tests read.
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const nowSeconds = () => Math.floor(Date.now() / 1_000);

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** The name declared for the n-th company of a test. */
const companyNameOf = (n: number) => `Example Test Holdings ${n} LLC`;

/** A company of the tenant with a passed check, its declaration naming it, and its own number. */
function company(): { companyId: string; companyName: string } {
  const n = ++made;
  const companyName = companyNameOf(n);
  const companyId = customerCompany(s, tenant.address, {
    companyName,
    filingNumber: `TEST-${String(n).padStart(4, "0")}`,
  });
  return { companyId, companyName };
}

/** A draft with its agreement frozen, made with the repository's own moves. */
function draft(): LegalBodyRecord {
  const { companyId } = company();
  const row = s.repo.create({
    tenantId: tenant.address,
    companyId,
    chainId: CHAIN_ID,
    factory: FACTORY,
    amendmentDelay: 172_800,
  });
  expect(
    s.repo.freezeAgreement(row.legalBodyId, { hash: keccak256(toHex("oa")), version: 1 }),
  ).toBe(true);
  return rowOf(row.legalBodyId);
}

/** Reserved for `agentId` (its own unless one is given), with a body address of its own. */
function reserved(agentId?: string): LegalBodyRecord {
  const row = draft();
  const n = made;
  expect(
    s.repo.reserve(row.legalBodyId, {
      agentId: agentId ?? String(5_000 + n),
      identityOwner: IDENTITY_OWNER.address,
      linkDigest: keccak256(toHex(`link-${n}`)),
      linkDeadline: nowSeconds() + 3_600,
      linkSignature: `0x${"ab".repeat(65)}` as Hex,
      bodyAddress: getAddress(`0x${keccak256(toHex(`body-${n}`)).slice(-40)}`),
      observedAtBlock: 8_000,
      firstCheckAt: Date.now(),
    }),
  ).toBe("reserved");
  return rowOf(row.legalBodyId);
}

function deployed(agentId?: string): LegalBodyRecord {
  const id = reserved(agentId).legalBodyId;
  expect(
    s.repo.markDeployed(id, {
      txHash: keccak256(toHex(`create-${id}`)),
      deployedAt: nowSeconds() - 60,
    }),
  ).toBe(true);
  return rowOf(id);
}

function linked(agentId?: string): LegalBodyRecord {
  const id = deployed(agentId).legalBodyId;
  expect(s.repo.markLinked(id, nowSeconds() - 30).outcome).toBe("linked");
  return rowOf(id);
}

function broken(reason: string): LegalBodyRecord {
  const id = linked().legalBodyId;
  expect(s.repo.markBroken(id, { reason, observedAtBlock: 8_500 })).toBe(true);
  return rowOf(id);
}

function lapsed(reason: LapseReason): LegalBodyRecord {
  const id = reserved().legalBodyId;
  expect(s.repo.lapse(id, { reason, blockTime: nowSeconds() })).toBe(true);
  return rowOf(id);
}

/** A body linked for an agent, then replaced by a second body linked for the same agent. */
function replacedPair(): { first: LegalBodyRecord; second: LegalBodyRecord } {
  const first = linked();
  const agentId = first.agentId;
  if (agentId === null) throw new Error("a linked body holds its agent");
  const second = deployed(agentId);
  const outcome = s.repo.markLinked(second.legalBodyId, nowSeconds());
  expect(outcome).toEqual({ outcome: "linked", replaced: [first.legalBodyId] });
  return { first: rowOf(first.legalBodyId), second: rowOf(second.legalBodyId) };
}

/** The revocation `legal-body:revoke` records. */
function revoke(id: string): void {
  s.repo.recordEvent(id, "revoked", OPERATOR, null, { reason: "Recorded for a test." });
}

const factsOf = (row: LegalBodyRecord) => orderViewFacts(s, row);

const NO_FACTS = {
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
};

// ── The facts, read from the event log ──────────────────────────────────────────────────────

describe("orderViewFacts reads why from the event log", () => {
  test.each(["deadline_passed", "foreign_body", "owner_changed", "refused_before_send"] as const)(
    "a lapsed order carries its lapse reason: %s",
    (reason) => {
      const row = lapsed(reason);
      expect(factsOf(row)).toEqual({
        ...NO_FACTS,
        lapseReason: reason,
        companyName: companyNameOf(made),
      });
    },
  );

  test("a draft carries no lapse reason, and nothing else but its company's name", () => {
    expect(factsOf(draft())).toEqual({ ...NO_FACTS, companyName: companyNameOf(made) });
  });

  test.each(["not_linked", "winding_down", "dissolved"] as const)(
    "a broken body carries the reason of its break: %s, and no replacement",
    (reason) => {
      const facts = factsOf(broken(reason));
      expect(facts.brokenReason).toBe(reason);
      expect(facts.replacedBy).toBeNull();
      expect(facts.lapseReason).toBeNull();
      expect(facts.supersededBy).toBeNull();
    },
  );

  test("a body broken by a second body linked for the same agent carries replaced, and the newer order's id", () => {
    const { first, second } = replacedPair();
    expect(first.bindingState).toBe("broken");
    expect(factsOf(first)).toMatchObject({
      brokenReason: "replaced",
      replacedBy: second.legalBodyId,
      supersededBy: null,
    });
    expect(factsOf(second)).toMatchObject({ brokenReason: null, replacedBy: null });
  });

  test("the newest break is the one read: a reason recorded since the break replaces it", () => {
    const row = broken("winding_down");
    expect(
      s.repo.recordBrokenReason(row.legalBodyId, { reason: "dissolved", observedAtBlock: 9_000 }),
    ).toBe(true);
    expect(factsOf(row).brokenReason).toBe("dissolved");
  });

  test("a broken event with a reason this version does not know reads as no reason, and a by that is not text as no replacement", () => {
    expect(factsOf(broken("struck_by_lightning"))).toMatchObject({
      brokenReason: null,
      replacedBy: null,
    });
    expect(factsOf(broken("replaced")).replacedBy).toBeNull();
    const numbered = linked();
    expect(s.repo.markBroken(numbered.legalBodyId, { reason: "replaced", by: 42 })).toBe(true);
    expect(factsOf(rowOf(numbered.legalBodyId))).toMatchObject({
      brokenReason: "replaced",
      replacedBy: null,
    });
  });

  test("a superseded order carries the id of the order that superseded it, and no break when it never linked", () => {
    const newer = draft();
    const row = deployed();
    expect(s.repo.supersede(row.legalBodyId, newer.legalBodyId)).toBe(true);
    expect(factsOf(rowOf(row.legalBodyId))).toMatchObject({
      supersededBy: newer.legalBodyId,
      brokenReason: null,
      replacedBy: null,
    });
  });

  test("a body superseded after it broke while winding down carries that break and the superseding order", () => {
    const newer = draft();
    const row = broken("winding_down");
    expect(s.repo.supersede(row.legalBodyId, newer.legalBodyId)).toBe(true);
    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("superseded");
    expect(factsOf(after)).toMatchObject({
      brokenReason: "winding_down",
      supersededBy: newer.legalBodyId,
    });
    // The binding keeps serving no pointer intent for it, as the latest break says.
    expect(bindingViewOf(s, after)).toMatchObject({
      intent: null,
      brokenReason: "winding_down",
      supersededBy: newer.legalBodyId,
    });
  });

  test("no state but superseded carries a superseding order", () => {
    for (const row of [draft(), reserved(), deployed(), linked(), broken("not_linked")])
      expect(factsOf(row).supersededBy, row.bindingState).toBeNull();
  });

  test("revoked is false before a revoked event, and true after it", () => {
    const row = linked();
    expect(factsOf(row).revoked).toBe(false);
    revoke(row.legalBodyId);
    expect(factsOf(row).revoked).toBe(true);
    expect(orderViewOf(s, row).revoked).toBe(true);
    expect(bindingViewOf(s, row).revoked).toBe(true);
  });

  test("companyName is the declared name, and null when the declaration is missing", () => {
    const row = draft();
    expect(factsOf(row).companyName).toBe(companyNameOf(made));
    vi.spyOn(s.declarations, "find").mockReturnValue(undefined);
    expect(factsOf(row).companyName).toBeNull();
  });
});

// ── The view ────────────────────────────────────────────────────────────────────────────────

describe("the order view", () => {
  test("holds exactly the seventeen fields it had and the six facts after them, in order, and serialises as it is", () => {
    const newer = draft();
    const row = broken("winding_down");
    s.repo.supersede(row.legalBodyId, newer.legalBodyId);
    revoke(row.legalBodyId);
    const view = orderViewOf(s, rowOf(row.legalBodyId));
    expect(Object.keys(view)).toEqual(ORDER_VIEW_KEYS);
    expect(ORDER_VIEW_KEYS).toHaveLength(23);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(view).toMatchObject({
      state: "superseded",
      lapseReason: null,
      brokenReason: "winding_down",
      revoked: true,
      supersededBy: newer.legalBodyId,
      replacedBy: null,
      companyName: companyNameOf(made),
    });
  });

  test("takes its facts as given: the builder reads nothing", () => {
    const row = draft();
    const facts = { ...NO_FACTS, lapseReason: "foreign_body" as const, companyName: "Given" };
    expect(toOrderView(row, facts)).toMatchObject(facts);
    expect(toBindingView(row, { ...facts, revoked: true })).toMatchObject({ revoked: true });
  });
});

// ── The doors ───────────────────────────────────────────────────────────────────────────────

/** The reads of the event log and of the declaration a view makes, by name. */
type Counts = Record<string, number>;
const EVENT_READS = ["lapseReason", "brokenDetail", "supersededBy", "isRevoked"];

/** The object itself, every call delegated to it; the calls of `names` counted. */
function counting<T extends object>(target: T, names: readonly string[], counts: Counts): T {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (typeof prop === "string" && names.includes(prop))
          counts[prop] = (counts[prop] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/** A fake chain for the binding check: the head at the clock's time, no pointer, an active body. */
function bindingChain() {
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

function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, { chain: asChainPort(bindingChain()), ...over });
}

function makeApp(legalBodyOrders: LegalBodyOrderDeps) {
  const requests = new SqliteFormationRepository(db);
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo: new SqliteEntityRepository(db),
    companies: s.companies,
    docStore: s.docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations: s.declarations,
      checks: s.checks,
      hasLinkedLegalBody: (companyId) => s.repo.hasLinkedForCompany(companyId),
    },
    legalBodyOrders,
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}

async function get(app: ReturnType<typeof makeApp>, path: string) {
  return answerOf(await call(app, "GET", path, await sessionOf(tenant)));
}

/** A tool's answer, read as JSON. */
async function callTool(
  app: ReturnType<typeof makeApp>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Json }> {
  const key = new SqliteApiKeyStore(db).mint(tenant.address, { capability: "provision" }).key;
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const out = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { isError: out.isError === true, body: JSON.parse(out.content[0]?.text ?? "null") };
  } finally {
    await close();
  }
}

/** One row of the tenant in each state, made with the repository's moves. */
function oneRowPerState(): Record<BindingState, LegalBodyRecord> {
  const abandoned = draft();
  expect(s.repo.abandon(abandoned.legalBodyId, "tenant_request", "tenant")).toBe(true);
  const newer = draft();
  const superseded = broken("winding_down");
  expect(s.repo.supersede(superseded.legalBodyId, newer.legalBodyId)).toBe(true);
  return {
    draft: newer,
    reserved: reserved(),
    deployed: deployed(),
    linked: linked(),
    broken: broken("not_linked"),
    lapsed: lapsed("deadline_passed"),
    superseded: rowOf(superseded.legalBodyId),
    abandoned: rowOf(abandoned.legalBodyId),
  };
}

describe("every door that answers a view carries the facts", () => {
  test("the list door carries companyName and revoked on every row, and each row is the view of the row as stored", async () => {
    const rows = oneRowPerState();
    revoke(rows.linked.legalBodyId);
    const res = await get(makeApp(orderDeps()), "/legal-body-orders");
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(Object.keys(rows).length);
    for (const order of res.body.orders) {
      expect(typeof order.companyName, order.id).toBe("string");
      expect(typeof order.revoked, order.id).toBe("boolean");
      expect(order).toEqual(orderViewOf(s, rowOf(order.id)));
    }
    expect(res.body.orders.filter((o: Json) => o.revoked).map((o: Json) => o.id)).toEqual([
      rows.linked.legalBodyId,
    ]);
  });

  test("the read door carries them too", async () => {
    const row = lapsed("owner_changed");
    revoke(row.legalBodyId);
    const res = await get(makeApp(orderDeps()), `/legal-body-orders/${row.legalBodyId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(orderViewOf(s, row));
    expect(res.body).toMatchObject({
      lapseReason: "owner_changed",
      revoked: true,
      companyName: companyNameOf(made),
    });
  });

  test("the binding door and its refresh carry the four facts of the binding", async () => {
    const { first, second } = replacedPair();
    revoke(first.legalBodyId);
    const app = makeApp(orderDeps());
    const expected = {
      brokenReason: "replaced",
      revoked: true,
      supersededBy: null,
      replacedBy: second.legalBodyId,
    };
    const read = await get(app, `/legal-body-orders/${first.legalBodyId}/binding`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject(expected);
    const refreshed = await answerOf(
      await call(
        app,
        "POST",
        `/legal-body-orders/${first.legalBodyId}/binding/refresh`,
        await sessionOf(tenant),
      ),
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject(expected);
    expect(refreshed.body).toEqual(bindingViewOf(s, rowOf(first.legalBodyId)));
  });

  test("submit_link answers the order with its facts, and get_binding the binding with its four", async () => {
    const chain = fakeLinkChainMembers();
    const deps = legalBodyOrderDeps(s, { chain: asChainPort(chain) });
    const app = makeApp(deps);
    const { companyId, companyName } = company();
    const view = createOrder(deps, tenant.address, { companyId });
    const signed = await signedLink(linkFor(rowOf(view.id)));

    const submitted = await callTool(app, "submit_link", { orderId: view.id, ...signed });
    expect(submitted.isError).toBe(false);
    expect(submitted.body.status).toBe("reserved");
    expect(submitted.body.order).toEqual(orderViewOf(s, rowOf(view.id)));
    expect(submitted.body.order).toMatchObject({ ...NO_FACTS, companyName });

    const { first, second } = replacedPair();
    const binding = await callTool(app, "get_binding", { orderId: first.legalBodyId });
    expect(binding.isError).toBe(false);
    expect(binding.body).toEqual(bindingViewOf(s, rowOf(first.legalBodyId)));
    expect(binding.body).toMatchObject({
      brokenReason: "replaced",
      revoked: false,
      supersededBy: null,
      replacedBy: second.legalBodyId,
    });
  });
});

describe("the reads a view makes per row", () => {
  /** The event reads per state: each state reads only the events that can describe it. */
  const EXPECTED: Record<BindingState, Counts> = {
    draft: { isRevoked: 1 },
    reserved: { isRevoked: 1 },
    deployed: { isRevoked: 1 },
    linked: { isRevoked: 1 },
    broken: { brokenDetail: 1, isRevoked: 1 },
    lapsed: { lapseReason: 1, isRevoked: 1 },
    superseded: { brokenDetail: 1, supersededBy: 1, isRevoked: 1 },
    abandoned: { isRevoked: 1 },
  };

  test("at most three event reads and one declaration read per row, by state", () => {
    const rows = oneRowPerState();
    for (const [state, row] of Object.entries(rows) as [BindingState, LegalBodyRecord][]) {
      const events: Counts = {};
      const finds: Counts = {};
      orderViewFacts(
        {
          repo: counting(s.repo, EVENT_READS, events),
          declarations: counting(s.declarations, ["find"], finds),
        },
        row,
      );
      expect(events, state).toEqual(EXPECTED[state]);
      expect(finds, state).toEqual({ find: 1 });
      const total = Object.values(events).reduce((a, b) => a + b, 0);
      expect(total, state).toBeLessThanOrEqual(3);
    }
  });

  test("the list door makes the same reads, row by row, and no more", async () => {
    oneRowPerState();
    const events: Counts = {};
    const finds: Counts = {};
    const repo = counting(s.repo, EVENT_READS, events) as SqliteLegalBodyRepository;
    const declarations = counting(s.declarations, ["find"], finds);
    const res = await get(makeApp(orderDeps({ repo, declarations })), "/legal-body-orders");
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(8);
    const sum: Counts = {};
    for (const counts of Object.values(EXPECTED))
      for (const [name, n] of Object.entries(counts)) sum[name] = (sum[name] ?? 0) + n;
    expect(events).toEqual(sum);
    expect(finds).toEqual({ find: 8 });
  });
});
