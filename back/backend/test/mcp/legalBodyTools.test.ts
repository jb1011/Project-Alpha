/**
 * The three legal-body tools of the MCP server, for an agent that holds the key of an identity's
 * owner: the message the owner signs, the signed link, and the binding. They act on an order its
 * guardian placed in the browser, as the API key's tenant, under the doors' own rules, and they
 * answer what the doors answer: a result of enums, decimals and hex, or a code and its fixed
 * sentence.
 *
 * The database is real (in memory); the chain is a fake whose answers each test steers. Every name,
 * company and filing number is an invention, and every key is one of anvil's published test
 * accounts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { type Address, type Hex, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CreateOutcome,
  LegalBodyGasTooHighError,
} from "../../src/adapters/arc/legalBodyChain";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { type LegalBodyOrderDeps, toOrderView } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { REAL_HUMAN_CHECK_CODES } from "../../src/mcp/server";
import { type Capability, SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
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
import type { MemoryDocumentStore } from "../helpers/formationFakes";
import {
  type FakeLinkChainMembers,
  H,
  IDENTITY_OWNER,
  JWT_SECRET,
  type Json,
  LINK_HEAD,
  type LegalBodyStores,
  TransportFailure,
  answerOf,
  asChainPort,
  call,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  linkFor,
  openLegalBodyStores,
  sessionOf,
  signedLink,
} from "../helpers/legalBodyFixtures";
import { startMcpTestClient } from "./helpers";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. The guardian and a
 *  stranger are verified humans; #4 holds a waiver. */
const guardian = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;
/** A tenant that never verified: a placeholder address. */
const UNVERIFIED = getAddress("0x00000000000000000000000000000000000000a1");

/** The three tools, sorted. */
const LEGAL_BODY_TOOLS = ["get_binding", "get_link_message", "submit_link"];
const S = LEGAL_BODY_SENTENCES;
/** The host of the node URL a transport failure carries. */
const NODE_HOST = "rpc.example";

const messagePath = (id: string) => `/legal-body-orders/${id}/link-message`;
const linkPath = (id: string) => `/legal-body-orders/${id}/link`;
const bindingPath = (id: string) => `/legal-body-orders/${id}/binding`;

/** One database and what runs over it: the stores, a fake chain, the API and its MCP endpoint. */
interface World {
  db: Database.Database;
  s: LegalBodyStores;
  chain: FakeLinkChainMembers;
  app: ReturnType<typeof buildApiApp>;
}

let opened: Database.Database[];
/** Every console line written in the test: the ops lines among them. */
let lines: string[];

beforeEach(() => {
  opened = [];
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened) db.close();
});

/**
 * The API over `db`, with the order doors and the tools over a sandbox deployment on a fake chain,
 * with room in every throttle; without them when `feature` is false.
 */
function worldOver(
  db: Database.Database,
  docStore: MemoryDocumentStore | undefined,
  opts: { feature?: boolean; over?: Partial<LegalBodyOrderDeps> } = {},
): World {
  opened.push(db);
  const s = openLegalBodyStores(db, docStore);
  const chain = fakeLinkChainMembers();
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
    legalBodyOrders:
      opts.feature === false
        ? undefined
        : legalBodyOrderDeps(s, { chain: asChainPort(chain), ...opts.over }),
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return { db, s, chain, app: buildApiApp(deps as ApiDeps) };
}

/** A fresh database where the guardian and the stranger are verified humans and #4 holds a
 *  waiver. */
function world(opts: { feature?: boolean; over?: Partial<LegalBodyOrderDeps> } = {}): World {
  const db = openDatabase(":memory:");
  migrate(db);
  const w = worldOver(db, undefined, opts);
  recordHuman(w.s.store, guardian.address, "3001", Date.now());
  recordHuman(w.s.store, stranger.address, "3002", Date.now());
  recordHuman(w.s.store, waived.address, "3003", Date.now(), "waiver");
  return w;
}

/** A second world over a copy of `w`'s database as it is now: the same orders, keys and
 *  verifications, and the same stored agreements. The door acts in one, the tool in the other. */
function twinOf(w: World): World {
  const copy = new Database(w.db.serialize());
  copy.pragma("foreign_keys = ON");
  return worldOver(copy, w.s.docStore);
}

/** An API key of `tenant`: a tenant-wide provision key unless told otherwise. */
function keyOf(
  w: World,
  tenant: Address,
  opts: { capability?: Capability; entityId?: string } = {},
): string {
  return new SqliteApiKeyStore(w.db).mint(tenant, { capability: "provision", ...opts }).key;
}

function rowIn(w: World, id: string): LegalBodyRecord {
  const row = w.s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

let filings = 0;
/** A draft of `who` for a checked company of its own, placed through the order door, as the
 *  browser places one. */
async function ordered(w: World, who = guardian): Promise<LegalBodyRecord> {
  const companyId = customerCompany(w.s, who.address, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const res = await answerOf(
    await call(w.app, "POST", "/legal-body-orders", await sessionOf(who), { companyId }),
  );
  expect(res.status).toBe(201);
  return rowIn(w, res.body.id);
}

/** A session of a tenant that holds no key here. */
async function sessionFor(tenant: Address): Promise<string> {
  const { token } = await signSession(tenant, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

/** A tool's answer: whether it is an error, its one text, and that text read as JSON when it is. */
interface ToolAnswer {
  isError: boolean;
  text: string;
  body: Json;
}

function jsonOrNull(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callTool(
  w: World,
  key: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const { client, close } = await startMcpTestClient(w.app, key);
  try {
    const out = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const text = out.content[0]?.text ?? "";
    return { isError: out.isError === true, text, body: jsonOrNull(text) };
  } finally {
    await close();
  }
}

async function toolsOf(w: World, key: string) {
  const { client, close } = await startMcpTestClient(w.app, key);
  try {
    return (await client.listTools()).tools;
  } finally {
    await close();
  }
}

/** Each tool with arguments that name `orderId`. */
function toolCalls(
  orderId: string,
  signed: { message: unknown; signature: Hex },
): [string, Record<string, unknown>][] {
  return [
    ["get_link_message", { orderId, agentId: "42" }],
    ["submit_link", { orderId, ...signed }],
    ["get_binding", { orderId }],
  ];
}

/** Every row and every event, to show that a call wrote nothing. */
function snapshot(w: World) {
  return {
    rows: w.db.prepare("SELECT * FROM legal_bodies ORDER BY rowid").all(),
    events: w.db.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
  };
}

/** The names of the fake chain's members that were called, sorted. */
function calledMembers(w: World): string[] {
  return Object.entries(w.chain)
    .filter(([, member]) => vi.isMockFunction(member) && member.mock.calls.length > 0)
    .map(([name]) => name)
    .sort();
}

function clearChainCalls(w: World): void {
  for (const member of Object.values(w.chain)) if (vi.isMockFunction(member)) member.mockClear();
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

/** The create found mined at the first read of its receipt. */
function created(txHash: Hex, bodyAddress: Address): CreateOutcome {
  return {
    status: "created",
    created: {
      legalBody: bodyAddress,
      agentId: 42n,
      identityOwner: IDENTITY_OWNER.address,
      guardian: guardian.address,
      linkDigest: H("d"),
      txHash,
      blockNumber: Number(LINK_HEAD.number) + 1,
      deployedAt: Number(LINK_HEAD.timestamp) + 2,
    },
  };
}

/**
 * One order linked twice from the same state: through the door in one world and through the tool
 * in its twin, both chains steered alike, with the same signed link.
 */
async function linkedBothWays(steer: (chain: FakeLinkChainMembers) => void = () => {}) {
  const door = world();
  const row = await ordered(door);
  const tool = twinOf(door);
  steer(door.chain);
  steer(tool.chain);
  const signed = await signedLink(linkFor(row));
  const viaDoor = await answerOf(
    await call(door.app, "POST", linkPath(row.legalBodyId), await sessionOf(guardian), signed),
  );
  const viaTool = await callTool(tool, keyOf(tool, guardian.address), "submit_link", {
    orderId: row.legalBodyId,
    ...signed,
  });
  return { id: row.legalBodyId, tool, viaDoor, viaTool };
}

// ── With the feature off ────────────────────────────────────────────────────────────────────

describe("with the feature off", () => {
  test("the three tools are not registered, and the feature on adds exactly them", async () => {
    const off = world({ feature: false });
    const on = world();
    const without = (await toolsOf(off, keyOf(off, guardian.address))).map((t) => t.name);
    const withIt = (await toolsOf(on, keyOf(on, guardian.address))).map((t) => t.name);

    for (const name of LEGAL_BODY_TOOLS) expect(without).not.toContain(name);
    expect(withIt.sort()).toEqual([...without, ...LEGAL_BODY_TOOLS].sort());
  });
});

// ── The same answers as the doors ───────────────────────────────────────────────────────────

describe("each tool answers what its door answers for the same input", () => {
  test("get_link_message answers the door's typed data, owner and deadline, with or without a lifetime, and writes nothing", async () => {
    const w = world();
    const row = await ordered(w);
    const key = keyOf(w, guardian.address);
    const token = await sessionOf(guardian);
    const before = snapshot(w);

    // Each input, with the lifetime its deadline is counted with: the default, then one given.
    const inputs: [Record<string, unknown>, number][] = [
      [{ agentId: "42" }, 3_600],
      [{ agentId: "42", ttlSeconds: 900 }, 900],
    ];
    for (const [input, lifetime] of inputs) {
      const viaDoor = await answerOf(
        await call(w.app, "POST", messagePath(row.legalBodyId), token, input),
      );
      const viaTool = await callTool(w, key, "get_link_message", {
        orderId: row.legalBodyId,
        ...input,
      });
      expect(viaDoor.status).toBe(200);
      expect(viaTool.isError).toBe(false);
      expect(viaTool.body).toEqual(viaDoor.body);
      expect(viaTool.body.deadline).toBe(Number(LINK_HEAD.timestamp) + lifetime);
    }
    expect(snapshot(w)).toEqual(before);
  });

  test("submit_link answers the door's order for the same order from the same state: reserved, or deployed once the create's receipt is read", async () => {
    const reserved = await linkedBothWays();
    expect(reserved.viaDoor.status).toBe(202);
    expect(reserved.viaTool.isError).toBe(false);
    expect(reserved.viaTool.body).toEqual({ status: "reserved", order: reserved.viaDoor.body });
    expect(reserved.viaTool.body.order).toEqual(toOrderView(rowIn(reserved.tool, reserved.id)));

    const deployed = await linkedBothWays((chain) =>
      chain.createOutcome.mockImplementation(async (txHash, expected) =>
        created(txHash, expected.bodyAddress),
      ),
    );
    expect(deployed.viaDoor.status).toBe(200);
    expect(deployed.viaTool.isError).toBe(false);
    expect(deployed.viaTool.body).toEqual({ status: "deployed", order: deployed.viaDoor.body });
    expect(deployed.viaTool.body.order.state).toBe("deployed");
  });

  test("a refused link answers the door's code, sentence, detail and order: before the reservation the draft is kept; after it the order has lapsed, and the sentence says so", async () => {
    const before = await linkedBothWays((chain) =>
      chain.estimateCreate.mockRejectedValueOnce(new LegalBodyGasTooHighError(30_000_000n)),
    );
    expect(before.viaDoor.status).toBe(422);
    expect(before.viaTool.isError).toBe(true);
    expect(before.viaTool.body).toEqual({ status: "refused", ...before.viaDoor.body });
    expect(before.viaTool.body).toMatchObject({
      code: "gas_too_high",
      message: S.gas_too_high,
      detail: { gasEstimate: "30000000" },
      order: { state: "draft" },
    });
    expect(rowIn(before.tool, before.id).bindingState).toBe("draft");

    const after = await linkedBothWays((chain) =>
      chain.submitCreate.mockRejectedValueOnce(
        new ContractRevertError("createLegalBody reverted: BadSignature", "BadSignature"),
      ),
    );
    expect(after.viaDoor.status).toBe(422);
    expect(after.viaTool.isError).toBe(true);
    expect(after.viaTool.body).toEqual({ status: "refused", ...after.viaDoor.body });
    expect(after.viaTool.body).toMatchObject({
      code: "bad_signature",
      message: `${S.bad_signature} ${S.order_lapsed}`,
      order: { state: "lapsed" },
    });
  });

  test("get_binding answers the door's binding as stored, a draft's with no intent and a deployed body's with its pointer intent, and reads no chain", async () => {
    const w = world();
    const row = await ordered(w);
    const key = keyOf(w, guardian.address);
    const token = await sessionOf(guardian);
    w.chain.createOutcome.mockImplementation(async (txHash, expected) =>
      created(txHash, expected.bodyAddress),
    );

    const readBoth = async (): Promise<Json> => {
      clearChainCalls(w);
      const viaDoor = await answerOf(await call(w.app, "GET", bindingPath(row.legalBodyId), token));
      const viaTool = await callTool(w, key, "get_binding", { orderId: row.legalBodyId });
      expect(viaDoor.status).toBe(200);
      expect(viaTool.isError).toBe(false);
      expect(viaTool.body).toEqual(viaDoor.body);
      expect(calledMembers(w)).toEqual([]);
      return viaTool.body;
    };

    expect(await readBoth()).toMatchObject({ state: "draft", agentId: null, intent: null });

    const linked = await callTool(w, key, "submit_link", {
      orderId: row.legalBodyId,
      ...(await signedLink(linkFor(row))),
    });
    expect(linked.body.status).toBe("deployed");
    const deployed = rowIn(w, row.legalBodyId);
    expect(await readBoth()).toEqual({
      state: "deployed",
      agentId: "42",
      bodyAddress: deployed.bodyAddress,
      intent: {
        action: "setLegalBodyPointer",
        agentId: "42",
        body: deployed.bodyAddress,
        chainId: CHAIN_ID,
      },
      pointerSeenAt: null,
      nextCheckAt: deployed.nextBindingCheckAt,
    });
  });
});

// ── Who may use the tools ───────────────────────────────────────────────────────────────────

describe("who may use the tools", () => {
  test("submit_link needs the provision capability: a spend key is refused before anything is read; the two reads answer a read key", async () => {
    const w = world();
    const row = await ordered(w);
    const signed = await signedLink(linkFor(row));
    const before = snapshot(w);

    const spend = keyOf(w, guardian.address, { capability: "spend" });
    expect(
      await callTool(w, spend, "submit_link", { orderId: row.legalBodyId, ...signed }),
    ).toEqual({ isError: true, text: "not authorized", body: null });
    expect(calledMembers(w)).toEqual([]);
    expect(snapshot(w)).toEqual(before);

    const read = keyOf(w, guardian.address, { capability: "read" });
    expect(
      await callTool(w, read, "get_link_message", { orderId: row.legalBodyId, agentId: "42" }),
    ).toMatchObject({ isError: false, body: { identityOwner: IDENTITY_OWNER.address } });
    expect(await callTool(w, read, "get_binding", { orderId: row.legalBodyId })).toMatchObject({
      isError: false,
      body: { state: "draft" },
    });
  });

  test("an entity-scoped key is refused by all three, a provision key included, before anything is read", async () => {
    const w = world();
    const row = await ordered(w);
    const signed = await signedLink(linkFor(row));
    const scoped = keyOf(w, guardian.address, { entityId: "agent-0001" });
    const before = snapshot(w);

    for (const [name, args] of toolCalls(row.legalBodyId, signed))
      expect(await callTool(w, scoped, name, args), name).toEqual({
        isError: true,
        text: "not authorized",
        body: null,
      });
    expect(calledMembers(w)).toEqual([]);
    expect(snapshot(w)).toEqual(before);
  });

  test("a waiver tenant is refused by all three, its own order included, with the door's code and message", async () => {
    const w = world();
    const companyId = customerCompany(w.s, waived.address, { filingNumber: "TEST-0900" });
    const own = w.s.repo.create({
      tenantId: waived.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const viaDoor = await answerOf(
      await call(w.app, "GET", bindingPath(own.legalBodyId), await sessionOf(waived)),
    );
    expect(viaDoor).toMatchObject({
      status: 403,
      body: { error: { code: "waiver_not_accepted" } },
    });
    const key = keyOf(w, waived.address);
    const before = snapshot(w);

    for (const [name, args] of toolCalls(own.legalBodyId, { message: {}, signature: "0x" }))
      expect(await callTool(w, key, name, args), name).toMatchObject({
        isError: true,
        body: { code: "waiver_not_accepted", message: viaDoor.body.error.message },
      });
    expect(calledMembers(w)).toEqual([]);
    expect(snapshot(w)).toEqual(before);
  });

  test("the real-human check's codes are a closed list, the very codes that check throws, each with its message written as one string literal and answered with the message the door answers", async () => {
    expect([...REAL_HUMAN_CHECK_CODES].sort()).toEqual([
      "guardian_not_verified",
      "unavailable",
      "waiver_not_accepted",
    ]);
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "api", "routes", "worldId.ts"),
      "utf8",
    );
    const start = source.indexOf("export function assertRealHuman(");
    expect(start).toBeGreaterThan(-1);
    const check = source.slice(start, source.indexOf("\n}\n", start));
    const thrown = new Set(
      [...check.matchAll(/new ApiError\(\s*"([a-z_]+)"/g)].map((m) => m[1] as string),
    );
    expect([...thrown].sort()).toEqual([...REAL_HUMAN_CHECK_CODES].sort());
    // Each of those refusals carries its message as one string literal, written in the check: no
    // variable, no template and no concatenation. That is what makes it safe for a tool to pass
    // the message on as it is.
    const refusals = check.match(/new ApiError\(/g) ?? [];
    const literal = [
      ...check.matchAll(/new ApiError\(\s*"([a-z_]+)",\s*\d{3},\s*"[^"\\\n]*",?\s*\)/g),
    ];
    expect(refusals.length).toBeGreaterThanOrEqual(REAL_HUMAN_CHECK_CODES.size);
    expect(literal, "a refusal whose message is not one string literal").toHaveLength(
      refusals.length,
    );
    expect(new Set(literal.map((m) => m[1]))).toEqual(thrown);

    const cases: [string, World, Address][] = [
      ["unavailable", world({ over: { world: undefined } }), guardian.address],
      ["guardian_not_verified", world(), UNVERIFIED],
      ["waiver_not_accepted", world(), waived.address],
    ];
    for (const [code, w, tenant] of cases) {
      const viaDoor = await answerOf(
        await call(w.app, "GET", bindingPath("lb_any"), await sessionFor(tenant)),
      );
      const viaTool = await callTool(w, keyOf(w, tenant), "get_binding", { orderId: "lb_any" });
      expect(viaDoor.body.error.code, code).toBe(code);
      expect(viaTool, code).toEqual({
        isError: true,
        text: JSON.stringify({ code, message: viaDoor.body.error.message }),
        body: { code, message: viaDoor.body.error.message },
      });
    }
  });

  test("the tenant is the key's: another tenant gets the uniform not_found on every tool, whatever tenant its arguments name", async () => {
    const w = world();
    const row = await ordered(w);
    const signed = await signedLink(linkFor(row));
    const theirs = keyOf(w, stranger.address);
    const before = snapshot(w);

    for (const id of [row.legalBodyId, "lb_unknown"])
      for (const [name, args] of toolCalls(id, signed)) {
        const res = await callTool(w, theirs, name, { ...args, tenantId: guardian.address });
        expect(res, name).toEqual({
          isError: true,
          text: JSON.stringify({ code: "not_found", message: S.not_found }),
          body: { code: "not_found", message: S.not_found },
        });
        expect(res.text, name).not.toContain(row.publicId);
      }
    expect(calledMembers(w)).toEqual([]);
    expect(snapshot(w)).toEqual(before);
  });
});

// ── What an answer may carry ────────────────────────────────────────────────────────────────

describe("what an answer may carry", () => {
  test("a chain failure answers chain_unavailable and its sentence, with no upstream text in the answer or the log, and nothing changes", async () => {
    const w = world();
    const row = await ordered(w);
    const key = keyOf(w, guardian.address);
    const signed = await signedLink(linkFor(row));
    const failures: [string, Record<string, unknown>, () => void][] = [
      [
        "get_link_message",
        { orderId: row.legalBodyId, agentId: "42" },
        () => w.chain.head.mockRejectedValueOnce(new TransportFailure()),
      ],
      [
        "submit_link",
        { orderId: row.legalBodyId, ...signed },
        () => w.chain.estimateCreate.mockRejectedValueOnce(new TransportFailure()),
      ],
    ];
    for (const [name, args, fail] of failures) {
      fail();
      lines.length = 0;
      const before = snapshot(w);
      const res = await callTool(w, key, name, args);
      expect(res, name).toEqual({
        isError: true,
        text: JSON.stringify({ code: "chain_unavailable", message: S.chain_unavailable }),
        body: { code: "chain_unavailable", message: S.chain_unavailable },
      });
      expect(lines.join("\n"), name).not.toContain(NODE_HOST);
      expect(opsLines(), name).toEqual([
        expect.objectContaining({
          opslog: "legal_body_chain_unavailable",
          orderId: row.legalBodyId,
          errorName: "HttpRequestError",
        }),
      ]);
      expect(snapshot(w), name).toEqual(before);
    }
    expect(rowIn(w, row.legalBodyId).bindingState).toBe("draft");
  });

  test("an error a tool did not choose answers internal_error and its sentence, after one line naming the tool and the error's name, never its message", async () => {
    const w = world();
    const row = await ordered(w);
    const key = keyOf(w, guardian.address);
    const signed = await signedLink(linkFor(row));
    // The real-human check, the first step of every tool after the key's own, reads this store.
    vi.spyOn(w.s.store, "findByTenant").mockImplementation(() => {
      throw new TransportFailure();
    });

    for (const [name, args] of toolCalls(row.legalBodyId, signed)) {
      lines.length = 0;
      const res = await callTool(w, key, name, args);
      expect(res, name).toEqual({
        isError: true,
        text: JSON.stringify({ code: "internal_error", message: S.internal_error }),
        body: { code: "internal_error", message: S.internal_error },
      });
      expect(lines.join("\n"), name).not.toContain(NODE_HOST);
      expect(opsLines(), name).toEqual([
        expect.objectContaining({
          opslog: "legal_body_tool_failed",
          tool: name,
          errorName: "HttpRequestError",
        }),
      ]);
    }
  });

  test("get_link_message tells a signer built on ethers to drop types.EIP712Domain before signing, and no tool takes a tenant: each takes exactly its inputs", async () => {
    const w = world();
    const tools = await toolsOf(w, keyOf(w, guardian.address));
    const byName = new Map(tools.map((t) => [t.name, t]));

    const description = byName.get("get_link_message")?.description ?? "";
    expect(description).toMatch(/ethers/);
    expect(description).toContain("types.EIP712Domain");
    const inputs = (name: string) =>
      Object.keys(byName.get(name)?.inputSchema.properties ?? {}).sort();
    expect(inputs("get_link_message")).toEqual(["agentId", "orderId", "ttlSeconds"]);
    expect(inputs("submit_link")).toEqual(["message", "orderId", "signature"]);
    expect(inputs("get_binding")).toEqual(["orderId"]);
  });
});
