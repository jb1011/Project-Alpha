/**
 * The two binding doors on REST: an order's binding and the pointer its identity's owner should
 * write, read as stored, and a refresh of it from the chain, under the order's lock. Mounted with
 * the other order doors, under the session protection, each starting with the real-human check.
 *
 * The database is real (in memory); the chain is a fake whose answers each test steers, and any
 * member it does not fake throws when read. The fake head's time is the wall clock's. Every name,
 * company and filing number is an invention, and every key is one of anvil's published test
 * accounts.
 */
import type Database from "better-sqlite3";
import { type Hex, getAddress, keccak256, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LegalBodyChainPort, LegalBodyCreated } from "../../src/adapters/arc/legalBodyChain";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { bucketsByKey } from "../../src/api/routes/legalBodyOrders";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { toBindingView } from "../../src/legalBody/binding";
import { type LegalBodyOrderDeps, orderLockKey } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { withKeyedLock } from "../../src/payments/keyedMutex";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  IDENTITY_OWNER,
  JWT_SECRET,
  type LegalBodyStores,
  OTHER_FACTORY,
  TransportFailure,
  answerOf,
  asChainPort,
  call,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  openLegalBodyStores,
  sessionOf,
} from "../helpers/legalBodyFixtures";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. The guardian and a
 *  stranger are verified humans; #4 holds a waiver. */
const guardian = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;

const MINUTE = 60_000;
/** The block every fake head is at. */
const HEAD_NUMBER = 9_000n;
/** The fields of an order's binding as the API shows it, and of the pointer it invites. */
const VIEW_KEYS = ["agentId", "bodyAddress", "intent", "nextCheckAt", "pointerSeenAt", "state"];
const INTENT_KEYS = ["action", "agentId", "body", "chainId"];

const bindingPath = (id: string) => `/legal-body-orders/${id}/binding`;
const refreshPath = (id: string) => `/legal-body-orders/${id}/binding/refresh`;

let db: Database.Database;
let s: LegalBodyStores;
let chain: FakeChain;
/** Every console line written in the test: the ops lines among them. */
let lines: string[];
let filings = 0;
let agents = 700;
let bodies = 0;

const nowSeconds = () => Math.floor(Date.now() / 1_000);

/**
 * The reads of the binding check and of the resolver's first rules, beside the link door's fakes,
 * each a mock a test can steer. By default the head is at `HEAD_NUMBER` and the wall clock's time,
 * the identity's pointer names no body, every body is active, and no body exists at a reserved
 * order's address.
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
    createdState: vi.fn<LegalBodyChainPort["createdState"]>(async () => "absent"),
  };
}
type FakeChain = ReturnType<typeof fakeChain>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  chain = fakeChain();
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  recordHuman(s.store, guardian.address, "3001", Date.now());
  recordHuman(s.store, stranger.address, "3002", Date.now());
  recordHuman(s.store, waived.address, "3003", Date.now(), "waiver");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The doors of a sandbox deployment over the fake chain, with room in every throttle unless a
 *  test gives its own. */
function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, {
    chain: asChainPort(chain),
    maxOpenPerTenant: 50,
    maxOrdersPerTenantPerDay: 50,
    ...over,
  });
}

/** The API over this test's database; the order doors only when `legalBodyOrders` is given. */
function makeApp(legalBodyOrders?: LegalBodyOrderDeps) {
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
type App = ReturnType<typeof makeApp>;

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A draft of `who` for a checked company of its own, as the order door makes one. */
async function ordered(app: App, who = guardian): Promise<LegalBodyRecord> {
  const companyId = customerCompany(s, who.address, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const res = await answerOf(
    await call(app, "POST", "/legal-body-orders", await sessionOf(who), { companyId }),
  );
  expect(res.status).toBe(201);
  return rowOf(res.body.id);
}

/** The order moved to `reserved` through the repository, as the link door reserves one, for an
 *  identity and a body address of its own. The signature is a placeholder: nothing here checks
 *  it. */
function reserve(id: string): LegalBodyRecord {
  const n = ++bodies;
  expect(
    s.repo.reserve(id, {
      agentId: String(++agents),
      identityOwner: IDENTITY_OWNER.address,
      linkDigest: keccak256(toHex(`link-${n}`)),
      linkDeadline: nowSeconds() + 3_600,
      linkSignature: `0x${"ab".repeat(65)}` as Hex,
      bodyAddress: getAddress(`0x${keccak256(toHex(`body-${n}`)).slice(-40)}`),
      observedAtBlock: 8_000,
      firstCheckAt: Date.now(),
    }),
  ).toBe("reserved");
  return rowOf(id);
}

/** The body created on chain a minute ago: `deployed`, checked from now, as the resolver leaves
 *  it. */
function deploy(id: string): LegalBodyRecord {
  reserve(id);
  expect(
    s.repo.markDeployed(id, {
      txHash: keccak256(toHex(`create-${id}`)),
      deployedAt: nowSeconds() - 60,
    }),
  ).toBe(true);
  expect(s.repo.scheduleBindingCheck(id, Date.now(), MINUTE)).toBe(true);
  return rowOf(id);
}

/** A body the identity's pointer names: `linked`. */
function link(id: string): LegalBodyRecord {
  deploy(id);
  expect(s.repo.markLinked(id, nowSeconds() - 30).outcome).toBe("linked");
  return rowOf(id);
}

/** A body the pointer named and then stopped naming, for `reason`. */
function brk(id: string, reason: string): LegalBodyRecord {
  link(id);
  expect(s.repo.markBroken(id, { reason, observedAtBlock: 8_500 })).toBe(true);
  return rowOf(id);
}

const bodyOf = (row: LegalBodyRecord) => {
  if (row.bodyAddress === null) throw new Error(`order ${row.legalBodyId} holds no body`);
  return row.bodyAddress;
};
const agentOf = (row: LegalBodyRecord) => {
  if (row.agentId === null) throw new Error(`order ${row.legalBodyId} holds no identity`);
  return row.agentId;
};

/** The view the doors should answer for the row as stored now. */
const storedView = (id: string) => toBindingView(rowOf(id), s.repo.latestBrokenReason(id));

/** Every row and every event, to show that a request wrote nothing. */
function snapshot() {
  return {
    rows: db.prepare("SELECT * FROM legal_bodies ORDER BY rowid").all(),
    events: db.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
  };
}

/** The names of the fake chain's members that were called, sorted. */
function calledMembers(): string[] {
  return Object.entries(chain)
    .filter(([, member]) => vi.isMockFunction(member) && member.mock.calls.length > 0)
    .map(([name]) => name)
    .sort();
}

function clearChainCalls(): void {
  for (const member of Object.values(chain)) if (vi.isMockFunction(member)) member.mockClear();
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

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── With the feature off ────────────────────────────────────────────────────────────────────

describe("with the feature off", () => {
  test("both doors are a 404, with a session and without one", async () => {
    const app = makeApp();
    const token = await sessionOf(guardian);
    for (const t of [token, undefined]) {
      expect((await call(app, "GET", bindingPath("lb_any"), t)).status).toBe(404);
      expect((await call(app, "POST", refreshPath("lb_any"), t, {})).status).toBe(404);
    }
  });
});

// ── Reading the binding ─────────────────────────────────────────────────────────────────────

describe("the binding as stored", () => {
  test("a deployed order's binding carries the pointer intent: the action, the identity, the body and the chain, and nothing else", async () => {
    const app = makeApp(orderDeps());
    const row = deploy((await ordered(app)).legalBodyId);
    const res = await answerOf(
      await call(app, "GET", bindingPath(row.legalBodyId), await sessionOf(guardian)),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: "deployed",
      agentId: agentOf(row),
      bodyAddress: bodyOf(row),
      intent: {
        action: "setLegalBodyPointer",
        agentId: agentOf(row),
        body: bodyOf(row),
        chainId: CHAIN_ID,
      },
      pointerSeenAt: null,
      nextCheckAt: row.nextBindingCheckAt,
    });
    expect(calledMembers()).toEqual([]);
  });

  test("a linked order and a dissolved one carry no intent; a body broken while active carries one again", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const linked = link((await ordered(app)).legalBodyId);
    const dissolved = brk((await ordered(app)).legalBodyId, "dissolved");
    const unpointed = brk((await ordered(app)).legalBodyId, "not_linked");

    const linkedRes = await answerOf(
      await call(app, "GET", bindingPath(linked.legalBodyId), token),
    );
    expect(linkedRes.status).toBe(200);
    expect(linkedRes.body).toMatchObject({ state: "linked", intent: null });
    expect(linkedRes.body.pointerSeenAt).toBe(linked.pointerSeenAt);

    const dissolvedRes = await answerOf(
      await call(app, "GET", bindingPath(dissolved.legalBodyId), token),
    );
    expect(dissolvedRes.status).toBe(200);
    expect(dissolvedRes.body).toMatchObject({ state: "broken", intent: null });

    const unpointedRes = await answerOf(
      await call(app, "GET", bindingPath(unpointed.legalBodyId), token),
    );
    expect(unpointedRes.body).toMatchObject({
      state: "broken",
      intent: { action: "setLegalBodyPointer", body: bodyOf(unpointed) },
    });
    expect(calledMembers()).toEqual([]);
  });

  test("a draft's binding names no identity, no body and no intent", async () => {
    const app = makeApp(orderDeps());
    const row = await ordered(app);
    const res = await answerOf(
      await call(app, "GET", bindingPath(row.legalBodyId), await sessionOf(guardian)),
    );
    expect(res).toMatchObject({
      status: 200,
      body: {
        state: "draft",
        agentId: null,
        bodyAddress: null,
        intent: null,
        pointerSeenAt: null,
        nextCheckAt: null,
      },
    });
  });
});

// ── Refreshing it ───────────────────────────────────────────────────────────────────────────

describe("a refresh of the binding", () => {
  test("after the pointer is written, a refresh answers linked, seen at the head's time, with no intent", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = deploy((await ordered(app)).legalBodyId);
    chain.linkedLegalBody.mockResolvedValue(bodyOf(row));

    const res = await answerOf(await call(app, "POST", refreshPath(row.legalBodyId), token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(storedView(row.legalBodyId));
    expect(res.body).toMatchObject({ state: "linked", intent: null });
    const seenAt = rowOf(row.legalBodyId).pointerSeenAt;
    expect(res.body.pointerSeenAt).toBe(seenAt);
    expect(seenAt).toBe(Number((await chain.head.mock.results[0]?.value)?.timestamp));
    expect(chain.linkedLegalBody).toHaveBeenCalledOnce();
    expect(chain.linkedLegalBody).toHaveBeenCalledWith(BigInt(agentOf(row)), HEAD_NUMBER);
    expect(calledMembers()).toEqual(["head", "linkedLegalBody"]);

    // The plain read now answers the same, with no chain call.
    clearChainCalls();
    const read = await answerOf(await call(app, "GET", bindingPath(row.legalBodyId), token));
    expect(read.body).toEqual(res.body);
    expect(calledMembers()).toEqual([]);
  });

  test("before the pointer is written, a refresh answers the deployed order and its intent", async () => {
    const app = makeApp(orderDeps());
    const row = deploy((await ordered(app)).legalBodyId);
    const res = await answerOf(
      await call(app, "POST", refreshPath(row.legalBodyId), await sessionOf(guardian)),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(storedView(row.legalBodyId));
    expect(res.body).toMatchObject({
      state: "deployed",
      intent: { action: "setLegalBodyPointer", agentId: agentOf(row), body: bodyOf(row) },
    });
  });

  test("a refresh that finds the pointer gone and the body dissolved answers broken, with no intent and no next check", async () => {
    const app = makeApp(orderDeps());
    const row = link((await ordered(app)).legalBodyId);
    chain.bodyStatus.mockResolvedValue("dissolved");
    const res = await answerOf(
      await call(app, "POST", refreshPath(row.legalBodyId), await sessionOf(guardian)),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(storedView(row.legalBodyId));
    expect(res.body).toMatchObject({ state: "broken", intent: null, nextCheckAt: null });
    expect(chain.bodyStatus).toHaveBeenCalledOnce();
    expect(chain.bodyStatus).toHaveBeenCalledWith(bodyOf(row), HEAD_NUMBER);
  });

  test("a reserved order's refresh is one resolver pass, not a binding check: a body the chain names as created is adopted", async () => {
    const app = makeApp(orderDeps());
    const row = reserve((await ordered(app)).legalBodyId);
    const txHash = keccak256(toHex(`recorded-${row.legalBodyId}`));
    expect(
      s.repo.recordDeploySubmission(row.legalBodyId, { txHash, rawTx: "0x02ab" as Hex, nonce: 0 }),
    ).toBe(true);
    const created: LegalBodyCreated = {
      legalBody: bodyOf(row),
      agentId: BigInt(agentOf(row)),
      identityOwner: IDENTITY_OWNER.address,
      guardian: guardian.address,
      linkDigest: keccak256(toHex("link-digest")),
      txHash,
      blockNumber: 8_900,
      deployedAt: nowSeconds() - 5,
    };
    chain.createdState.mockResolvedValue("created");
    chain.createOutcome.mockResolvedValue({ status: "created", created });

    const res = await answerOf(
      await call(app, "POST", refreshPath(row.legalBodyId), await sessionOf(guardian)),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(storedView(row.legalBodyId));
    expect(res.body).toMatchObject({
      state: "deployed",
      intent: { action: "setLegalBodyPointer", body: bodyOf(row) },
    });
    expect(rowOf(row.legalBodyId).createTxHash).toBe(txHash);
    expect(calledMembers()).toEqual(["createOutcome", "createdState", "head"]);
    expect(chain.linkedLegalBody).not.toHaveBeenCalled();
  });

  test("a draft's refresh reads no chain and answers its view", async () => {
    const app = makeApp(orderDeps());
    const row = await ordered(app);
    const before = snapshot();
    const res = await answerOf(
      await call(app, "POST", refreshPath(row.legalBodyId), await sessionOf(guardian)),
    );
    expect(res).toMatchObject({ status: 200, body: { state: "draft", intent: null } });
    expect(calledMembers()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test("the refresh waits for the order's lock, and reads the chain only once it holds it", async () => {
    const app = makeApp(orderDeps());
    const row = deploy((await ordered(app)).legalBodyId);
    chain.linkedLegalBody.mockResolvedValue(bodyOf(row));
    let release: () => void = () => {};
    const holder = withKeyedLock(
      orderLockKey(row.legalBodyId),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    // The door reads the order once before it asks for the lock: once that read is made, a door
    // that took no lock would already have asked the chain for its head.
    const ownedRead = vi.spyOn(s.repo, "findOwned");
    const refreshing = call(app, "POST", refreshPath(row.legalBodyId), await sessionOf(guardian));
    for (let i = 0; i < 200 && ownedRead.mock.calls.length === 0; i++) await settle();
    expect(ownedRead).toHaveBeenCalled();
    for (let i = 0; i < 10; i++) await settle();
    expect(chain.head).not.toHaveBeenCalled();
    expect(rowOf(row.legalBodyId).bindingState).toBe("deployed");

    release();
    await holder;
    const res = await answerOf(await refreshing);
    expect(res).toMatchObject({ status: 200, body: { state: "linked" } });
  });

  test("the sixth refresh in a burst is a 429 rate_limited that reads no chain; the plain read is not throttled", async () => {
    const app = makeApp(
      orderDeps({ tenantBucket: bucketsByKey(5, 1 / 10), doorBudget: new TokenBucket(20, 1) }),
    );
    const token = await sessionOf(guardian);
    const row = deploy((await ordered(app)).legalBodyId);
    for (let i = 0; i < 5; i++)
      expect(
        (await call(app, "POST", refreshPath(row.legalBodyId), token)).status,
        `#${i + 1}`,
      ).toBe(200);
    expect(chain.head).toHaveBeenCalledTimes(5);

    const before = snapshot();
    const sixth = await answerOf(await call(app, "POST", refreshPath(row.legalBodyId), token));
    expect(sixth).toMatchObject({
      status: 429,
      body: { error: { code: "rate_limited", message: LEGAL_BODY_SENTENCES.rate_limited } },
    });
    expect(chain.head).toHaveBeenCalledTimes(5);
    expect(snapshot()).toEqual(before);

    const read = await answerOf(await call(app, "GET", bindingPath(row.legalBodyId), token));
    expect(read).toMatchObject({ status: 200, body: storedView(row.legalBodyId) });
  });

  test("a refresh on an order of another factory is a 409 other_deployment that reads no chain; the plain read still serves it", async () => {
    const app = makeApp(orderDeps());
    const companyId = customerCompany(s, guardian.address, { filingNumber: "TEST-0800" });
    const other = s.repo.create({
      tenantId: guardian.address,
      companyId,
      chainId: CHAIN_ID,
      factory: OTHER_FACTORY,
      amendmentDelay: 172_800,
    });
    const token = await sessionOf(guardian);
    const before = snapshot();
    const res = await answerOf(await call(app, "POST", refreshPath(other.legalBodyId), token));
    expect(res).toMatchObject({
      status: 409,
      body: {
        error: { code: "other_deployment", message: LEGAL_BODY_SENTENCES.other_deployment },
      },
    });
    expect(calledMembers()).toEqual([]);
    expect(snapshot()).toEqual(before);
    const read = await answerOf(await call(app, "GET", bindingPath(other.legalBodyId), token));
    expect(read).toMatchObject({ status: 200, body: storedView(other.legalBodyId) });
  });
});

// ── When the chain cannot answer ────────────────────────────────────────────────────────────

describe("when the chain cannot answer", () => {
  test("a refresh is a 503 chain_unavailable with no http in the body or the log, for a binding check and for a resolver pass; the plain read still answers the stored state", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const deployed = deploy((await ordered(app)).legalBodyId);
    const reserved = reserve((await ordered(app)).legalBodyId);

    for (const row of [deployed, reserved]) {
      const id = row.legalBodyId;
      chain.head.mockRejectedValueOnce(new TransportFailure());
      lines.length = 0;
      const res = await answerOf(await call(app, "POST", refreshPath(id), token));
      expect(res, row.bindingState).toMatchObject({
        status: 503,
        body: {
          error: { code: "chain_unavailable", message: LEGAL_BODY_SENTENCES.chain_unavailable },
        },
      });
      expect(res.text, row.bindingState).not.toContain("http");
      expect(lines.join("\n"), row.bindingState).not.toContain("http");
      expect(rowOf(id).bindingState).toBe(row.bindingState);

      const read = await answerOf(await call(app, "GET", bindingPath(id), token));
      expect(read, row.bindingState).toMatchObject({ status: 200, body: storedView(id) });
      expect(read.body.state).toBe(row.bindingState);
    }
  });
});

// ── Who may use the doors ───────────────────────────────────────────────────────────────────

describe("who may use the binding doors", () => {
  test("a caller with no session is a 401 on both doors", async () => {
    const app = makeApp(orderDeps());
    expect((await call(app, "GET", bindingPath("lb_any"), undefined)).status).toBe(401);
    expect((await call(app, "POST", refreshPath("lb_any"), undefined)).status).toBe(401);
  });

  test("a waiver tenant is refused on both doors, its own order included, and its refresh takes no token", async () => {
    const tenantBucket = vi.fn(() => ({ take: () => true }));
    const app = makeApp(orderDeps({ tenantBucket }));
    const companyId = customerCompany(s, waived.address, { filingNumber: "TEST-0900" });
    const own = s.repo.create({
      tenantId: waived.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const token = await sessionOf(waived);
    const before = snapshot();
    for (const [method, path] of [
      ["GET", bindingPath(own.legalBodyId)],
      ["POST", refreshPath(own.legalBodyId)],
    ] as const) {
      const res = await answerOf(await call(app, method, path, token));
      expect(res, path).toMatchObject({
        status: 403,
        body: { error: { code: "waiver_not_accepted" } },
      });
    }
    expect(tenantBucket).not.toHaveBeenCalled();
    expect(calledMembers()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test("another tenant gets the uniform 404 on both doors, a deployed order included, never the binding", async () => {
    const app = makeApp(orderDeps());
    const row = deploy((await ordered(app)).legalBodyId);
    const theirs = await sessionOf(stranger);
    const notFound = {
      status: 404,
      body: { error: { code: "not_found", message: LEGAL_BODY_SENTENCES.not_found } },
    };
    const before = snapshot();
    for (const id of [row.legalBodyId, "lb_unknown"])
      for (const [method, path] of [
        ["GET", bindingPath(id)],
        ["POST", refreshPath(id)],
      ] as const) {
        const res = await answerOf(await call(app, method, path, theirs));
        expect(res, `${method} ${path}`).toMatchObject(notFound);
        expect(res.text, path).not.toContain(row.publicId);
        expect(res.text.toLowerCase(), path).not.toContain(bodyOf(row).toLowerCase());
      }
    expect(calledMembers()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });
});

// ── What an answer may carry ────────────────────────────────────────────────────────────────

describe("what an answer may carry", () => {
  test("both doors answer the binding's fields and no other, and no hex but the body's address: no calldata, no encoded pointer", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = deploy((await ordered(app)).legalBodyId);
    for (const [method, path] of [
      ["GET", bindingPath(row.legalBodyId)],
      ["POST", refreshPath(row.legalBodyId)],
    ] as const) {
      const res = await answerOf(await call(app, method, path, token));
      expect(res.status, method).toBe(200);
      expect(Object.keys(res.body).sort(), method).toEqual(VIEW_KEYS);
      expect(Object.keys(res.body.intent).sort(), method).toEqual(INTENT_KEYS);
      expect(new Set(res.text.match(/0x[0-9a-fA-F]+/g)), method).toEqual(new Set([bodyOf(row)]));
    }
  });

  test("an error a door did not choose answers 500 internal_error with the fixed sentence, and its line names the door", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = await ordered(app);
    // The real-human check, the first step of both doors, reads this store.
    vi.spyOn(s.store, "findByTenant").mockImplementation(() => {
      throw new TransportFailure();
    });
    for (const [door, method, path] of [
      ["binding", "GET", bindingPath(row.legalBodyId)],
      ["binding_refresh", "POST", refreshPath(row.legalBodyId)],
    ] as const) {
      lines.length = 0;
      const res = await answerOf(await call(app, method, path, token));
      expect(res, door).toMatchObject({
        status: 500,
        body: { error: { code: "internal_error", message: LEGAL_BODY_SENTENCES.internal_error } },
      });
      expect(res.text, door).not.toContain("http");
      expect(opsLines(), door).toEqual([
        expect.objectContaining({
          opslog: "legal_body_door_failed",
          door,
          errorName: "HttpRequestError",
        }),
      ]);
    }
  });
});
