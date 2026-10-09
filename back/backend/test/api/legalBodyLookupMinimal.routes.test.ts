/**
 * GET /legal-bodies/:address for a Minimal legal body. Only when the full-product resolver knows
 * nothing of the address, and the statement is wired, is the address answered from a statement
 * whose agent wallet, read fresh, is that address. Every full-product answer stays exactly as it
 * is, and so does the lookup on a deployment without the statement.
 *
 * The statement service over a real in-memory database and a fake chain, on a fixed clock; the
 * full-product resolver is a fake. Every key is one of anvil's published test accounts, every
 * other address a placeholder, and every name and filing number an invention.
 */
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { verifyPublicStatement } from "../../src/legalBody/publicStatement";
import type { LegalBodyResolution, LegalBodyStanding } from "../../src/payments/legalBody";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import type { EntityRecord } from "../../src/types";
import { CHAIN_ID } from "../helpers/customerCompanyFixtures";
import {
  CLOCK_MS,
  CLOCK_S,
  FakeStatementChain,
  OWNER,
  type StatementStores,
  TEST_ATTESTOR,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

/** The lookup's links, and the statement's own: distinct, so an answer shows which it used. */
const TRANSPARENCY = "https://www.example.test/transparency";
const METADATA_BASE = "https://api.example.test";
const STATEMENT_TRANSPARENCY = "https://statements.example.test/transparency";
const STATEMENT_BASE = "https://statements.example.test/legal-bodies/by-agent/";
const CHECKED_AT = new Date(CLOCK_MS).toISOString();
const FRESH = "public, max-age=15";
const NO_STORE = "no-store";
const UNAVAILABLE = {
  error: "unavailable",
  message: "could not check right now; try again shortly",
};

/** Placeholders: a full-product entity's payment address, another agent wallet, and an address
 *  nothing knows. */
const POCKET = getAddress("0x0000000000000000000000000000000000000fee");
const WALLET = getAddress("0x00000000000000000000000000000000000a11e7");
const STRANGER = getAddress("0x000000000000000000000000000000000000dead");

let s: StatementStores;
let chain: FakeStatementChain;
let clock: number;
let printed: string[];

beforeEach(() => {
  s = openStatementStores();
  chain = new FakeStatementChain();
  clock = CLOCK_MS;
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

// biome-ignore lint/suspicious/noExplicitAny: an ops line, read field by field
type OpsLine = Record<string, any>;

/** The ops lines printed for `event`, each without its `opslog` and `at` fields. */
function opsLines(event: string): OpsLine[] {
  return printed.flatMap((line) => {
    try {
      const { opslog, at: _at, ...fields } = JSON.parse(line) as OpsLine;
      return opslog === event ? [fields] : [];
    } catch {
      return [];
    }
  });
}

/** A shared read budget that counts every `take`, and never refuses. */
function countingBudget() {
  const budget = {
    calls: 0,
    take(): boolean {
      budget.calls += 1;
      return true;
    },
  };
  return budget;
}

/** A full-product legal body, as the resolver finds one: an entity of the full product. */
const fullProduct = (
  standing: LegalBodyStanding,
  matchedBy: "pocket" | "treasury" = "pocket",
): LegalBodyResolution =>
  ({
    kind: "body",
    matchedBy,
    standing,
    entity: {
      idempotencyKey: "tenant-a:agent",
      name: "Example Agent",
      agentId: "7001",
      publicId: "22222222-2222-2222-2222-222222222222",
      pocketAddress: POCKET,
      companyId: null,
    } as unknown as EntityRecord,
  }) as LegalBodyResolution;

interface AppOptions {
  /** What the full-product resolver answers for every address: nothing, unless told. */
  resolve?: () => Promise<LegalBodyResolution>;
  /** false: no statement deps, as on a deployment without the attestation key. */
  statements?: boolean;
  readBudget?: { take(): boolean };
  /** The network the lookup names. */
  network?: "testnet" | "mainnet";
}

function makeApp(o: AppOptions = {}) {
  const readBudget = o.readBudget ?? countingBudget();
  return buildApiApp({
    webOrigin: "https://www.example.test",
    jwtSecret: "s",
    now: () => clock,
    legalBody: {
      resolver: { resolve: o.resolve ?? (async () => ({ kind: "none" })) },
      readBudget,
      links: { transparency: TRANSPARENCY, metadataBase: METADATA_BASE },
      network: o.network ?? "testnet",
    },
    legalBodyStatements:
      o.statements === false
        ? undefined
        : statementDeps(s, chain, {
            readBudget,
            now: () => clock,
            links: { transparency: STATEMENT_TRANSPARENCY, statementBase: STATEMENT_BASE },
          }),
  } as never);
}
type App = ReturnType<typeof makeApp>;

const get = (app: App, address: string) => app.request(`/legal-bodies/${address}`);

/** A distinct valid lower-case address per index. */
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

/** A linked row of a ready company whose check passed, for agent 42, linked on chain too: its
 *  identity owner is `owner` (OWNER unless told), and so is the agent's wallet unless told. */
function linkedBody(
  o: { owner?: Address; wallet?: Address; status?: "draft" | "ready" } = {},
): LegalBodyRecord {
  const companyId = readyCompany(s, { status: o.status });
  s.checks.append(passedCheck(companyId));
  const row = bodyIn("linked", s, companyId, { owner: o.owner });
  chain.link(row, { wallet: o.wallet });
  return row;
}

/** The keys of a Minimal answer, in the order they are served. */
const MINIMAL_KEYS = [
  "address",
  "legalBody",
  "standing",
  "agentId",
  "publicId",
  "name",
  "network",
  "links",
  "formation",
  "checkedAt",
  "statement",
];

test("a full-product answer is the same, byte for byte, with the statement wired or not, even for an address a Minimal body also has", async () => {
  // The Minimal body's identity owner and agent wallet ARE the full-product entity's pocket.
  linkedBody({ owner: POCKET });
  const ownerFinder = vi.spyOn(s.repo, "listAgentIdsByIdentityOwner");
  for (const resolved of [
    fullProduct("active"),
    fullProduct("inactive", "treasury"),
    fullProduct("unknown"),
  ]) {
    const served = async (statements: boolean) => {
      printed = [];
      const res = await get(makeApp({ resolve: async () => resolved, statements }), POCKET);
      return {
        status: res.status,
        cache: res.headers.get("cache-control"),
        text: await res.text(),
        lines: opsLines("legal_body_lookup"),
      };
    };
    const without = await served(false);
    const withStatement = await served(true);
    expect(withStatement, resolved.kind === "body" ? resolved.standing : "none").toEqual(without);
    expect(JSON.parse(withStatement.text)).not.toHaveProperty("statement");
  }
  // The statement was never asked.
  expect(ownerFinder).not.toHaveBeenCalled();
  expect(chain.snapshots).toEqual([]);
});

describe("the Minimal branch", () => {
  test("an address no Minimal body has: the lookup's own legalBody false, memoised", async () => {
    linkedBody();
    const app = makeApp();
    const res = await get(app, STRANGER.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body = await res.json();
    expect(body).toEqual({
      address: STRANGER,
      legalBody: false,
      standing: null,
      checkedAt: CHECKED_AT,
    });
    expect(opsLines("legal_body_lookup")).toEqual([{ matchedBy: "none", standing: null }]);
    // No candidate: not a single chain read.
    expect(chain.snapshots).toEqual([]);

    const ownerFinder = vi.spyOn(s.repo, "listAgentIdsByIdentityOwner");
    clock += 14_999;
    expect(await (await get(app, STRANGER)).json()).toEqual(body);
    expect(ownerFinder).not.toHaveBeenCalled();
  });

  test("a candidate whose wallet the chain shows elsewhere: legalBody false", async () => {
    linkedBody({ wallet: WALLET });
    const res = await get(makeApp(), OWNER);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    expect(await res.json()).toEqual({
      address: OWNER,
      legalBody: false,
      standing: null,
      checkedAt: CHECKED_AT,
    });
    // The wallets were read, and no statement was made.
    expect(chain.snapshots).toEqual([[{ agentId: 42n, bodies: [] }]]);
    expect(opsLines("legal_body_lookup")).toEqual([{ matchedBy: "none", standing: null }]);
  });

  test("the agent's wallet: the signed statement, the company's name, no metadata, no formation; memoised", async () => {
    const row = linkedBody();
    const budget = countingBudget();
    const app = makeApp({ readBudget: budget });
    const res = await get(app, OWNER.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(MINIMAL_KEYS);
    expect(body).toEqual({
      address: OWNER,
      legalBody: true,
      standing: "active",
      agentId: "42",
      publicId: row.publicId,
      name: "Example Holdings LLC",
      network: "testnet",
      links: { transparency: TRANSPARENCY, metadata: null, statement: `${STATEMENT_BASE}42` },
      formation: null,
      checkedAt: CHECKED_AT,
      statement: expect.any(Object),
    });
    expect(Object.keys(body.links)).toEqual(["transparency", "metadata", "statement"]);
    expect(body.statement.message).toMatchObject({
      agentId: "42",
      agentWallet: OWNER,
      legalName: "Example Holdings LLC",
      standing: "active",
    });
    await expect(
      verifyPublicStatement(body.statement, {
        attestor: TEST_ATTESTOR.address,
        expectedChainId: CHAIN_ID,
        nowSeconds: CLOCK_S,
      }),
    ).resolves.toBe(true);
    expect(opsLines("legal_body_lookup")).toEqual([{ matchedBy: "statement", standing: "active" }]);

    // The memo holds it as a definitive answer: within the window no read and no token.
    const reads = chain.snapshots.length;
    clock += 14_000;
    const hit = await get(app, OWNER);
    expect(hit.headers.get("cache-control")).toBe(FRESH);
    expect(await hit.json()).toEqual(body);
    expect(chain.snapshots).toHaveLength(reads);
    expect(budget.calls).toBe(1);
  });

  test("network and the transparency link are the lookup's; the statement link is the statement's", async () => {
    linkedBody();
    const body = await (await get(makeApp({ network: "mainnet" }), OWNER)).json();
    expect(body.network).toBe("mainnet");
    expect(body.links).toEqual({
      transparency: TRANSPARENCY,
      metadata: null,
      statement: `${STATEMENT_BASE}42`,
    });
  });

  test("a body whose company is not paid for yet is stated too: standing pending, memoised", async () => {
    linkedBody({ status: "draft" });
    const app = makeApp();
    const res = await get(app, OWNER);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body = await res.json();
    expect(body).toMatchObject({ legalBody: true, standing: "pending", agentId: "42" });
    expect(body.statement.message.standing).toBe("pending");
    expect(opsLines("legal_body_lookup")).toEqual([
      { matchedBy: "statement", standing: "pending" },
    ]);
    clock += 1_000;
    expect(await (await get(app, OWNER)).json()).toEqual(body);
  });

  test("a chain read that fails, of the wallets or of the statement: unknown, unsigned, no agent named, no-store, never memoised", async () => {
    linkedBody();
    for (const failing of [1, 2]) {
      chain.snapshots.length = 0;
      printed = [];
      const app = makeApp();
      chain.beforeSnapshot = (n) => {
        if (n === failing)
          throw Object.assign(new Error("HTTP request failed. URL: https://rpc.example/v2/key"), {
            name: "HttpRequestError",
          });
      };
      const res = await get(app, OWNER);
      expect(res.status, `snapshot ${failing}`).toBe(200);
      expect(res.headers.get("cache-control"), `snapshot ${failing}`).toBe(NO_STORE);
      const text = await res.text();
      const body = JSON.parse(text);
      expect(body, `snapshot ${failing}`).toEqual({
        address: OWNER,
        legalBody: true,
        standing: "unknown",
        agentId: null,
        publicId: null,
        name: "",
        network: "testnet",
        links: { transparency: TRANSPARENCY, metadata: null },
        formation: null,
        checkedAt: CHECKED_AT,
        statement: null,
      });
      expect(Object.keys(body)).toEqual(MINIMAL_KEYS);
      expect(text).not.toContain("rpc.example");
      expect(opsLines("legal_body_lookup")).toEqual([
        { matchedBy: "statement", standing: "unknown" },
      ]);

      // The node recovers; same instant, and no memo entry stands in the way.
      chain.beforeSnapshot = () => {};
      const next = await get(app, OWNER);
      expect(next.headers.get("cache-control")).toBe(FRESH);
      expect((await next.json()).standing).toBe("active");
    }
  });

  test("a database read that fails: the flat 503, no-store, never memoised, one ops line naming the error", async () => {
    linkedBody();
    const ownerFinder = vi
      .spyOn(s.repo, "listAgentIdsByIdentityOwner")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { name: "SqliteError" });
      });
    const app = makeApp();
    const res = await get(app, OWNER);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(UNAVAILABLE);
    expect(text).not.toContain("SQLITE");
    expect(opsLines("legal_body_statement_db_failed")).toEqual([{ errorName: "SqliteError" }]);
    expect(printed.join("\n")).not.toContain("database is locked");
    expect(opsLines("legal_body_lookup")).toEqual([]);

    const next = await get(app, OWNER);
    expect(next.status).toBe(200);
    expect((await next.json()).standing).toBe("active");
    expect(ownerFinder).toHaveBeenCalledTimes(2);
  });

  test("a resolver that throws is the lookup's own 503: the statement is not asked", async () => {
    linkedBody();
    const ownerFinder = vi.spyOn(s.repo, "listAgentIdsByIdentityOwner");
    const app = makeApp({
      resolve: async () => {
        throw new Error("database is locked");
      },
    });
    const res = await get(app, OWNER);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
    expect(ownerFinder).not.toHaveBeenCalled();
    expect(opsLines("legal_body_statement_db_failed")).toEqual([]);
  });

  test("one token from each budget per miss, however many reads the branch makes", async () => {
    linkedBody();
    const budget = countingBudget();
    const from = { "x-forwarded-for": "10.0.0.1, 192.0.2.21" };
    const app = makeApp({ readBudget: budget });
    expect((await app.request(`/legal-bodies/${OWNER}`, { headers: from })).status).toBe(200);
    // The wallets' snapshot and the statement's: two reads behind one token.
    expect(chain.snapshots).toHaveLength(2);
    expect(budget.calls).toBe(1);
    // The rest of the client's ten tokens: one each.
    for (let i = 1; i <= 9; i += 1)
      expect((await app.request(`/legal-bodies/${addr(i)}`, { headers: from })).status).toBe(200);
    expect(budget.calls).toBe(10);
    const refused = await app.request(`/legal-bodies/${STRANGER}`, { headers: from });
    expect(refused.status).toBe(429);
  });
});

test("without the statement deps the address route behaves as today: legalBody false, nothing of the statement read", async () => {
  linkedBody();
  const ownerFinder = vi.spyOn(s.repo, "listAgentIdsByIdentityOwner");
  const res = await get(makeApp({ statements: false }), OWNER);
  expect(res.headers.get("cache-control")).toBe(FRESH);
  expect(await res.json()).toEqual({
    address: OWNER,
    legalBody: false,
    standing: null,
    checkedAt: CHECKED_AT,
  });
  expect(ownerFinder).not.toHaveBeenCalled();
  expect(chain.snapshots).toEqual([]);
  expect(opsLines("legal_body_lookup")).toEqual([{ matchedBy: "none", standing: null }]);
});
