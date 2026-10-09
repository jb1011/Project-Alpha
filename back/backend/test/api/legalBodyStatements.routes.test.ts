/**
 * GET /legal-bodies/by-agent/:agentId: what Novi states, signed, about an agent's legal body,
 * public and unauthenticated. Its three answers, the 400, 429 and 503; the memo, and the two
 * budgets it shares with the lookup by address; the cache headers and CORS; and the composition
 * root's wiring of the statement's dependencies.
 *
 * The statement service over a real in-memory database and a fake chain, on a fixed clock. Every
 * key is one of anvil's published test accounts, every other address a placeholder, and every
 * name and filing number an invention.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { verifyPublicStatement } from "../../src/legalBody/publicStatement";
import { statementForAgent } from "../../src/legalBody/statements";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
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

const TRANSPARENCY = "https://www.example.test/transparency";
const STATEMENT_BASE = "https://api.example.test/legal-bodies/by-agent/";
const CHECKED_AT = new Date(CLOCK_MS).toISOString();

const VALIDATION = {
  error: "validation_error",
  message: "agentId must be a decimal token id of at most 78 digits, without leading zeros",
};
const RATE_LIMITED = { error: "rate_limited", message: "try again in a few seconds" };
const UNAVAILABLE = {
  error: "unavailable",
  message: "could not check right now; try again shortly",
};
const FRESH = "public, max-age=15";
const NO_STORE = "no-store";

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

/** A shared read budget that counts every `take`: `tokens` granted, then none. */
function countingBudget(tokens = Number.POSITIVE_INFINITY) {
  let granted = 0;
  const budget = {
    calls: 0,
    take(): boolean {
      budget.calls += 1;
      if (granted >= tokens) return false;
      granted += 1;
      return true;
    },
  };
  return budget;
}

interface AppOptions {
  /** The shared read budget: the statement's, and the lookup's too when it is wired. */
  readBudget?: { take(): boolean };
  /** false: no statement deps, as on a deployment without the attestation key. */
  statements?: boolean;
  /** true: the lookup by address is wired too, its resolver knowing no address. */
  lookup?: boolean;
}

function makeApp(o: AppOptions = {}) {
  const readBudget = o.readBudget ?? countingBudget();
  return buildApiApp({
    webOrigin: "https://www.example.test",
    jwtSecret: "s",
    now: () => clock,
    legalBodyStatements:
      o.statements === false
        ? undefined
        : statementDeps(s, chain, {
            readBudget,
            now: () => clock,
            links: { transparency: TRANSPARENCY, statementBase: STATEMENT_BASE },
          }),
    legalBody: o.lookup
      ? {
          resolver: { resolve: async () => ({ kind: "none" }) },
          readBudget,
          links: { transparency: TRANSPARENCY, metadataBase: "https://api.example.test" },
          network: "testnet",
        }
      : undefined,
  } as never);
}
type App = ReturnType<typeof makeApp>;

const get = (app: App, agentId: string, headers?: Record<string, string>) =>
  app.request(`/legal-bodies/by-agent/${agentId}`, headers ? { headers } : undefined);

/** A distinct valid lower-case address per index. */
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

/** A linked row of a ready company whose check passed, for agent 42 unless told otherwise, and
 *  linked on chain too, the agent's wallet being the row's identity owner. */
function linkedBody(agentId = "42"): LegalBodyRecord {
  const companyId = readyCompany(s);
  s.checks.append(passedCheck(companyId));
  const row = bodyIn("linked", s, companyId, { agentId });
  chain.link(row);
  return row;
}

/** A node failure as a client throws one, its message quoting the node's URL. */
const nodeError = () =>
  Object.assign(new Error("HTTP request failed. URL: https://rpc.example/v2/key-in-path"), {
    name: "HttpRequestError",
  });

describe("the three answers", () => {
  test("an agent with no legal body: legalBody false, for 15 s, memoised", async () => {
    const budget = countingBudget();
    const app = makeApp({ readBudget: budget });
    const res = await get(app, "7");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body = await res.json();
    expect(body).toEqual({ agentId: "7", legalBody: false, standing: null, checkedAt: CHECKED_AT });
    expect(Object.keys(body)).toEqual(["agentId", "legalBody", "standing", "checkedAt"]);

    // Within the window the memo answers, as checked: nothing read, no token taken.
    const listed = vi.spyOn(s.repo, "listPublicByAgent");
    clock += 14_999;
    const hit = await get(app, "7");
    expect(hit.headers.get("cache-control")).toBe(FRESH);
    expect(await hit.json()).toEqual(body);
    expect(listed).not.toHaveBeenCalled();
    expect(budget.calls).toBe(1);
    expect(chain.snapshots).toEqual([]);
  });

  test("a linked body: the service's signed statement, which verifies against the attestor", async () => {
    const row = linkedBody();
    const res = await get(makeApp(), "42");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body = await res.json();
    expect(Object.keys(body)).toEqual([
      "agentId",
      "legalBody",
      "standing",
      "publicId",
      "network",
      "links",
      "checkedAt",
      "statement",
    ]);
    expect(body).toEqual({
      agentId: "42",
      legalBody: true,
      standing: "active",
      publicId: row.publicId,
      network: "testnet",
      links: { transparency: TRANSPARENCY, statement: `${STATEMENT_BASE}42` },
      checkedAt: CHECKED_AT,
      statement: expect.any(Object),
    });
    expect(Object.keys(body.links)).toEqual(["transparency", "statement"]);
    await expect(
      verifyPublicStatement(body.statement, {
        attestor: TEST_ATTESTOR.address,
        expectedChainId: CHAIN_ID,
        nowSeconds: CLOCK_S,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyPublicStatement(body.statement, {
        attestor: OWNER,
        expectedChainId: CHAIN_ID,
        nowSeconds: CLOCK_S,
      }),
    ).resolves.toBe(false);
    // Exactly what the service signs for the agent at the same instant: the route adds nothing
    // to the statement and drops nothing from it.
    const direct = await statementForAgent(statementDeps(s, chain), "42");
    if (direct.kind !== "statement") throw new Error(`expected a statement, got ${direct.kind}`);
    expect(body.statement).toEqual(direct.statement);
  });

  test("a chain read that fails: unknown, unsigned, no-store, never memoised: the next request reads again", async () => {
    linkedBody();
    const budget = countingBudget();
    const app = makeApp({ readBudget: budget });
    chain.beforeSnapshot = () => {
      throw nodeError();
    };
    const res = await get(app, "42");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toEqual({
      agentId: "42",
      legalBody: true,
      standing: "unknown",
      publicId: null,
      network: "testnet",
      links: { transparency: TRANSPARENCY },
      checkedAt: CHECKED_AT,
      statement: null,
    });
    expect(Object.keys(body)).toEqual([
      "agentId",
      "legalBody",
      "standing",
      "publicId",
      "network",
      "links",
      "checkedAt",
      "statement",
    ]);
    expect(text).not.toContain("rpc.example");

    // The node recovers. Same instant: no memo entry stands in the way.
    chain.beforeSnapshot = () => {};
    const next = await get(app, "42");
    expect(next.headers.get("cache-control")).toBe(FRESH);
    expect((await next.json()).standing).toBe("active");
    expect(chain.snapshots).toHaveLength(2);
    expect(budget.calls).toBe(2);
  });

  test("a database read that fails: 503, no-store, never memoised, one ops line naming the error and nothing more", async () => {
    linkedBody();
    const listed = vi.spyOn(s.repo, "listPublicByAgent").mockImplementationOnce(() => {
      throw Object.assign(new Error("SQLITE_IOERR: disk I/O error at /var/lib/example.sqlite"), {
        name: "SqliteError",
      });
    });
    const app = makeApp();
    const res = await get(app, "42");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(UNAVAILABLE);
    expect(text).not.toContain("SQLITE");
    expect(opsLines("legal_body_statement_db_failed")).toEqual([{ errorName: "SqliteError" }]);
    expect(printed.join("\n")).not.toContain("disk I/O");

    const next = await get(app, "42");
    expect(next.status).toBe(200);
    expect((await next.json()).standing).toBe("active");
    expect(listed).toHaveBeenCalledTimes(2);
  });

  test("a signed statement whose standing is unknown is an answer: memoised, for 15 s", async () => {
    // Formed in 2024 with no annual report recorded: the reports are past due beyond grace.
    const companyId = readyCompany(s);
    s.checks.append(passedCheck(companyId, { formationDate: "2024-02-29" }));
    chain.link(bodyIn("linked", s, companyId));
    const budget = countingBudget();
    const app = makeApp({ readBudget: budget });
    const res = await get(app, "42");
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body = await res.json();
    expect(body).toMatchObject({ legalBody: true, standing: "unknown" });
    expect(body.statement.message.standing).toBe("unknown");
    clock += 10_000;
    expect(await (await get(app, "42")).json()).toEqual(body);
    expect(budget.calls).toBe(1);
  });
});

describe("validation", () => {
  test("a leading zero, 79 digits, above 2^256 - 1, letters, a sign, hex or a fraction: 400, no-store, nothing read and no token", async () => {
    const budget = countingBudget();
    const app = makeApp({ readBudget: budget });
    const listed = vi.spyOn(s.repo, "listPublicByAgent");
    for (const id of [
      "042",
      "00",
      "1".repeat(79),
      `1${"0".repeat(78)}`,
      (2n ** 256n).toString(),
      `2${"0".repeat(77)}`,
      "4a",
      "abc",
      "-1",
      "+1",
      "0x2a",
      "4.2",
      "1e3",
      "%2042",
    ]) {
      const res = await get(app, id);
      expect(res.status, id).toBe(400);
      expect(res.headers.get("cache-control"), id).toBe(NO_STORE);
      expect(await res.json(), id).toEqual(VALIDATION);
    }
    expect(listed).not.toHaveBeenCalled();
    expect(budget.calls).toBe(0);
    expect(chain.snapshots).toEqual([]);
  });

  test("0, 2^256 - 1 and the decimals between them are agent ids", async () => {
    const app = makeApp();
    for (const id of ["0", "42", `1${"0".repeat(77)}`, (2n ** 256n - 1n).toString()]) {
      const res = await get(app, id);
      expect(res.status, id).toBe(200);
      expect((await res.json()).agentId, id).toBe(id);
    }
  });
});

describe("the memo and the two budgets", () => {
  test("a memo hit takes no token from either budget and reads nothing", async () => {
    linkedBody();
    const budget = countingBudget();
    const app = makeApp({ readBudget: budget });
    const from = { "x-forwarded-for": "10.0.0.1, 192.0.2.7" };
    const first = await (await get(app, "42", from)).json();
    expect(budget.calls).toBe(1);
    expect(chain.snapshots).toHaveLength(1);
    // Twenty hits from the same client inside the window. A client holds ten tokens, so a hit
    // that took one would be refused well before the last.
    for (let i = 0; i < 20; i += 1) {
      clock += 500;
      const hit = await get(app, "42", from);
      expect(hit.status).toBe(200);
      expect(hit.headers.get("cache-control")).toBe(FRESH);
      expect(await hit.json()).toEqual(first);
    }
    expect(budget.calls).toBe(1);
    expect(chain.snapshots).toHaveLength(1);
    // The window is over: a miss, one token, one snapshot.
    clock = CLOCK_MS + 15_000;
    expect((await get(app, "42", from)).status).toBe(200);
    expect(budget.calls).toBe(2);
    expect(chain.snapshots).toHaveLength(2);
  });

  test("an empty shared budget: 429, no-store, nothing read, one ops line naming the shared bucket", async () => {
    linkedBody();
    const app = makeApp({ readBudget: countingBudget(0) });
    const res = await get(app, "42");
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual(RATE_LIMITED);
    expect(opsLines("legal_body_statement_throttled")).toEqual([{ bucket: "shared" }]);
    expect(chain.snapshots).toEqual([]);
  });

  test("a client that spent its own allowance: the same 429, naming the client bucket; another client is served", async () => {
    const budget = countingBudget();
    const app = makeApp({ readBudget: budget });
    const from = { "x-forwarded-for": "10.0.0.1, 192.0.2.7" };
    // Ten in a burst, each a different agent so that none is a memo hit.
    for (let i = 0; i < 10; i += 1)
      expect((await get(app, String(100 + i), from)).status).toBe(200);
    const res = await get(app, "200", from);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual(RATE_LIMITED);
    expect(opsLines("legal_body_statement_throttled")).toEqual([{ bucket: "client" }]);
    // The caller's own bucket is asked first: the refused request took nothing from the shared one.
    expect(budget.calls).toBe(10);
    expect((await get(app, "201", { "x-forwarded-for": "10.0.0.1, 192.0.2.8" })).status).toBe(200);
  });

  test("a drain writes one throttle line per minute", async () => {
    const app = makeApp({ readBudget: countingBudget(0) });
    for (let i = 0; i < 5; i += 1) expect((await get(app, String(i))).status).toBe(429);
    expect(opsLines("legal_body_statement_throttled")).toHaveLength(1);
    clock += 59_999;
    await get(app, "5");
    expect(opsLines("legal_body_statement_throttled")).toHaveLength(1);
    clock += 1;
    await get(app, "6");
    expect(opsLines("legal_body_statement_throttled")).toHaveLength(2);
  });

  test("the per-client allowance is the lookup's own: spent by address, refused by agent", async () => {
    const app = makeApp({ lookup: true });
    const from = { "x-forwarded-for": "10.0.0.1, 192.0.2.9" };
    for (let i = 1; i <= 10; i += 1)
      expect((await app.request(`/legal-bodies/${addr(i)}`, { headers: from })).status).toBe(200);
    const res = await get(app, "42", from);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(RATE_LIMITED);
    expect(opsLines("legal_body_statement_throttled")).toEqual([{ bucket: "client" }]);
    expect((await get(app, "42", { "x-forwarded-for": "10.0.0.1, 192.0.2.10" })).status).toBe(200);
  });

  test("…and spent by agent, refused by address", async () => {
    const app = makeApp({ lookup: true });
    const from = { "x-forwarded-for": "10.0.0.1, 192.0.2.11" };
    for (let i = 0; i < 10; i += 1)
      expect((await get(app, String(300 + i), from)).status).toBe(200);
    const res = await app.request(`/legal-bodies/${addr(1)}`, { headers: from });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(RATE_LIMITED);
  });
});

describe("the surface", () => {
  test("Cache-Control on each kind of answer", async () => {
    linkedBody();
    const shared = { open: true };
    const app = makeApp({ readBudget: { take: () => shared.open } });
    const cacheOf = async (agentId: string) =>
      (await get(app, agentId)).headers.get("cache-control");
    expect(await cacheOf("42")).toBe(FRESH); // a statement
    expect(await cacheOf("42")).toBe(FRESH); // the memo's hit
    expect(await cacheOf("7")).toBe(FRESH); // no legal body
    expect(await cacheOf("042")).toBe(NO_STORE); // a 400
    chain.beforeSnapshot = () => {
      throw nodeError();
    };
    clock += 15_000;
    expect(await cacheOf("42")).toBe(NO_STORE); // unknown, unsigned
    shared.open = false;
    expect(await cacheOf("43")).toBe(NO_STORE); // a 429
    shared.open = true;
    vi.spyOn(s.repo, "listPublicByAgent").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    expect(await cacheOf("44")).toBe(NO_STORE); // a 503
  });

  test("CORS *: a seller's page may ask by agent and by address", async () => {
    const app = makeApp({ lookup: true });
    for (const path of ["/legal-bodies/by-agent/42", `/legal-bodies/${addr(0xdead)}`]) {
      const preflight = await app.request(path, {
        method: "OPTIONS",
        headers: { Origin: "https://seller.example", "Access-Control-Request-Method": "GET" },
      });
      expect(preflight.headers.get("access-control-allow-origin"), path).toBe("*");
      const res = await app.request(path, { headers: { Origin: "https://seller.example" } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
    }
  });

  test("without the statement deps the route is not mounted: 404, and nothing is read", async () => {
    linkedBody();
    const app = makeApp({ statements: false, lookup: true });
    expect((await get(app, "42")).status).toBe(404);
    expect(chain.snapshots).toEqual([]);
  });
});

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file,
 * as the other composition guards do. What it protects:
 *  - the statement's dependencies exist only with the legal-body store, its chain and the
 *    attestation key, and they sign with that key;
 *  - ONE chain serves the order doors and the statement: it believes no head older than two
 *    minutes, and reads a statement's snapshot through the Multicall3 listed for the chain;
 *  - ONE shared public read budget, 30 in a burst and 1 a second, is spent by the lookup by
 *    address and by the statement by agent alike;
 *  - the statement links to the transparency page the lookup links to, names the lookup's
 *    network, and builds its own link on the API's public origin;
 *  - the API is handed the statement's dependencies after the gas seed's.
 */
test("the composition root builds the statement's dependencies only with the store, its chain and the attestation key, over the lookup's budget", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const built = (name: string) => {
    const at = main.indexOf(`const ${name}`);
    expect(at, `${name} was not found`).toBeGreaterThan(0);
    return { at, text: main.slice(at, main.indexOf(": undefined;", at)) };
  };

  const chainBuilt = built("legalBodyChain =").text;
  expect(chainBuilt).toMatch(
    /=\n\s+legalBodies && cfg\.legalBodyFactory\n\s+\? new LegalBodyChain\(\{/,
  );
  expect(chainBuilt).toMatch(/^ {10}maxHeadAgeSeconds: 120,$/m);
  expect(chainBuilt).toMatch(/^ {10}multicall3: MULTICALL3_BY_CHAIN\[cfg\.chainId\],$/m);
  expect(main.match(/new LegalBodyChain\(/g)).toHaveLength(1);
  const orders = built("legalBodyOrders =").text;
  expect(orders).toMatch(/=\n\s+legalBodies && cfg\.legalBodyFactory && legalBodyChain\n\s+\? \{/);
  expect(orders).toMatch(/^ {10}chain: legalBodyChain,$/m);

  expect(main).toMatch(/^ {2}const publicReadBudget = new TokenBucket\(30, 1\);$/m);
  expect(main.match(/new TokenBucket\(30, 1\)/g)).toHaveLength(1);

  const statements = built("legalBodyStatements");
  expect(main).toMatch(
    /^ {2}const legalBodyStatements: LegalBodyStatementDeps \| undefined =\n {4}legalBodies && legalBodyChain && cfg\.attestation\n {6}\? \{$/m,
  );
  expect(statements.text).toMatch(/^ {10}repo: legalBodies,$/m);
  expect(statements.text).toMatch(
    /^ {10}statements: new SqliteLegalBodyStatementRepository\(db\),$/m,
  );
  // The instances the customer company and order doors read, and the order doors' deployment:
  // each of them decides a claim the statement signs.
  for (const member of [
    /^ {10}companies,$/m,
    /^ {10}checks: companyChecks,$/m,
    /^ {10}declarations: companyDeclarations,$/m,
    /^ {10}world: worldId,$/m,
    /^ {10}deployment: \{ chainId: cfg\.chainId, factory: legalBodyChain\.factory \},$/m,
    /^ {10}identityRegistry: cfg\.identityRegistry,$/m,
    /^ {10}environment: legalBodyEnvironment\(cfg\),$/m,
  ])
    expect(statements.text).toMatch(member);
  expect(statements.text).toMatch(/^ {10}chain: legalBodyChain,$/m);
  expect(statements.text).toMatch(/^ {10}signer: privateKeyToAccount\(cfg\.attestation\.key\),$/m);
  expect(statements.text).toMatch(/^ {10}readBudget: publicReadBudget,$/m);
  expect(statements.text).toMatch(/^ {10}network: agentBook\.network,$/m);
  expect(statements.text).toMatch(/^ {12}transparency: transparencyLink,$/m);
  expect(statements.text).toContain(
    'statementBase: `${(cfg.publicApiUrl ?? cfg.metadataBaseUrl).replace(/\\/+$/, "")}/legal-bodies/by-agent/`,',
  );
  // After the transparency link it reuses, before the API it is handed to.
  expect(statements.at).toBeGreaterThan(main.indexOf("const transparencyLink = "));
  expect(statements.at).toBeLessThan(main.indexOf("const app = buildApiApp({"));

  // The lookup spends the same budget.
  const lookupAt = main.indexOf("    legalBody: {\n      resolver: legalBody,");
  expect(lookupAt, "the lookup's deps were not found").toBeGreaterThan(0);
  expect(main.slice(lookupAt, main.indexOf("\n    },\n", lookupAt))).toMatch(
    /^ {6}readBudget: publicReadBudget,$/m,
  );
  expect(main).toMatch(/^ {4}legalBodyGasSeed,\n(?: {4}\/\/.*\n)* {4}legalBodyStatements,$/m);
});
