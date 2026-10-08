/**
 * The legal-body section of `/transparency`: the deployment's linked legal bodies whose statement
 * would read `active`, worked out from ONE snapshot of the chain and the facts the deployment
 * recorded, through the statement's own rules, and never signed. A body that is pending, revoked,
 * broken, unknown, or was never recorded as linked is not listed. The route's ten-second cache also
 * holds a computation still running, so concurrent requests share one snapshot, and a computation
 * that fails is not kept. Without the statement's dependencies the body is exactly what it was.
 *
 * A fake chain over a real in-memory database, on a fixed clock. Every key is one of anvil's
 * published test accounts, every other address a placeholder, and every name, company and filing
 * number an invention.
 */
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StatementChainPort } from "../../src/adapters/arc/legalBodyChain";
import { buildApiApp } from "../../src/api/app";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { JobRecord } from "../../src/jobs/types";
import {
  type LegalBodyStatementDeps,
  type TransparencyLegalBody,
  activeLegalBodies,
  statementForAgent,
} from "../../src/legalBody/statements";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import type { EntityRecord } from "../../src/types";
import { CHAIN_ID, FACTORY } from "../helpers/customerCompanyFixtures";
import { H, TransportFailure, appendCheck } from "../helpers/legalBodyFixtures";
import {
  CLOCK_MS,
  CLOCK_S,
  FakeStatementChain,
  OWNER,
  type StatementStores,
  TENANT,
  TEST_ATTESTOR,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

const STATEMENT_BASE = "https://api.example.test/legal-bodies/by-agent/";
/** The first sighting of every linked row made here: three days before the clock, plus the agent's
 *  id in seconds, so a higher agent id is a more recent sighting. */
const SEEN_FROM = CLOCK_S - 3 * 86_400;
const FRESH = "public, max-age=300";

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

const logRows = () => s.db.prepare("SELECT * FROM statement_log").all();

/** The listing, which must not be "unavailable". */
function listedOf(out: TransparencyLegalBody[] | "unavailable"): TransparencyLegalBody[] {
  if (out === "unavailable") throw new Error("expected a listing, got unavailable");
  return out;
}
const agentIdsOf = (out: TransparencyLegalBody[] | "unavailable") =>
  listedOf(out).map((b) => b.agentId);

/** The section's listing over the stores, the fake chain and the clock, at most `limit` bodies. */
const list = (over: Partial<LegalBodyStatementDeps> = {}, limit = 100) =>
  activeLegalBodies(statementDeps(s, chain, { now: () => clock, ...over }), limit);

/** A ready customer company of the tenant whose check passed. */
function checkedCompany(o: { status?: "draft" | "ready"; formationDate?: string } = {}): string {
  const companyId = readyCompany(s, { status: o.status });
  s.checks.append(passedCheck(companyId, { formationDate: o.formationDate }));
  return companyId;
}

/** A linked row of its own checked company, for `agentId`, linked on the chain too: a body whose
 *  statement reads `active`, unless told otherwise. */
function linkedBody(
  agentId: string,
  o: { status?: "draft" | "ready"; formationDate?: string } = {},
): LegalBodyRecord {
  const row = bodyIn("linked", s, checkedCompany(o), {
    agentId,
    seenAt: SEEN_FROM + Number(agentId),
  });
  chain.link(row);
  return row;
}

/**
 * One body in each situation the section must tell apart, keyed by the situation. Agent 1 is
 * active; every other one is not, for one reason each.
 */
function situations(): Record<string, LegalBodyRecord> {
  const rows: Record<string, LegalBodyRecord> = {};
  rows.active = linkedBody("1");

  rows.revoked = linkedBody("2");
  s.repo.recordEvent(rows.revoked.legalBodyId, "revoked", "operator:ops.example", null, {
    reason: "Recorded for a test.",
  });

  rows.companyRevoked = linkedBody("3");
  appendCheck(s.checks, rows.companyRevoked.companyId, "revoked");

  // Linked and not paid yet.
  rows.pending = linkedBody("4", { status: "draft" });

  // Broken in the records: no longer a linked row.
  rows.brokenRow = bodyIn("broken", s, checkedCompany(), { agentId: "5" });
  chain.addBody(rows.brokenRow);

  // Linked in the records, but the chain links nothing for the agent any more.
  rows.unlinkedOnChain = linkedBody("6");
  chain.linked.delete("6");

  // Annual reports past due beyond grace.
  rows.lateReports = linkedBody("7", { formationDate: "2023-03-10" });

  // Another operating agreement on chain than the one frozen for the body.
  rows.otherAgreement = linkedBody("8");
  chain.addBody(rows.otherAgreement, { oaHash: H("c") });

  // Never recorded as linked, even while the chain links it.
  rows.neverLinked = bodyIn("deployed", s, checkedCompany(), { agentId: "9" });
  chain.link(rows.neverLinked);

  // Winding down, which the factory no longer links.
  rows.windingDown = linkedBody("10");
  chain.addBody(rows.windingDown, { status: "winding_down" });
  chain.linked.delete("10");

  // A body that names another agent than its row's.
  rows.otherAgent = linkedBody("11");
  chain.addBody(rows.otherAgent, { metaAgentId: 99n });
  return rows;
}

describe("activeLegalBodies", () => {
  test("a linked body that reads active is listed with what its statement says, and a link to that statement", async () => {
    const row = linkedBody("42");
    const listed = listedOf(await list());
    expect(listed).toEqual([
      {
        agentId: "42",
        publicId: row.publicId,
        legalBody: getAddress(row.bodyAddress as string),
        chainId: CHAIN_ID,
        legalName: "Example Holdings LLC",
        filingNumber: "TEST-0001",
        jurisdiction: "WY",
        entityType: "LLC",
        source: "customer",
        environment: "sandbox",
        standing: "active",
        linkedSince: "2026-10-04T18:00:42.000Z",
        links: { statement: `${STATEMENT_BASE}42` },
      },
    ]);
    expect(Object.keys(listed[0] as TransparencyLegalBody)).toEqual([
      "agentId",
      "publicId",
      "legalBody",
      "chainId",
      "legalName",
      "filingNumber",
      "jurisdiction",
      "entityType",
      "source",
      "environment",
      "standing",
      "linkedSince",
      "links",
    ]);
    // The same body, the same names, the same standing as its signed statement by agent.
    const out = await statementForAgent(statementDeps(s, chain), "42");
    if (out.kind !== "statement") throw new Error(`expected a statement, got ${out.kind}`);
    expect(out.statement.message).toMatchObject({
      legalBody: listed[0]?.legalBody,
      legalName: listed[0]?.legalName,
      filingNumber: listed[0]?.filingNumber,
      standing: "active",
    });
  });

  test("a body is listed under the deployment's environment", async () => {
    linkedBody("42");
    const listed = listedOf(await list({ environment: "production" }));
    expect(listed.map((b) => b.environment)).toEqual(["production"]);
  });

  test("every linked row is read in ONE snapshot, with no code read, no signature and no log row", async () => {
    const one = linkedBody("1");
    const two = linkedBody("2");
    const pending = linkedBody("3", { status: "draft" });
    const signs = vi.spyOn(TEST_ATTESTOR, "signTypedData");
    const appends = vi.spyOn(s.statements, "appendIfChanged");

    expect(agentIdsOf(await list())).toEqual(["2", "1"]);
    // The most recent sighting first, each agent with its row's body and nothing else.
    expect(chain.snapshots).toEqual([
      [
        { agentId: 3n, bodies: [pending.bodyAddress] },
        { agentId: 2n, bodies: [two.bodyAddress] },
        { agentId: 1n, bodies: [one.bodyAddress] },
      ],
    ]);
    expect(chain.codeReads).toEqual([]);
    expect(signs).not.toHaveBeenCalled();
    expect(appends).not.toHaveBeenCalled();
    expect(logRows()).toEqual([]);
    expect(opsLines("legal_body_statement")).toEqual([]);
  });

  test("each row's company, check, events, declaration and guardian are read once, as a statement reads them", async () => {
    linkedBody("1");
    linkedBody("2");
    const reads = {
      company: vi.spyOn(s.companies, "find"),
      check: vi.spyOn(s.checks, "latest"),
      checks: vi.spyOn(s.checks, "list"),
      events: vi.spyOn(s.repo, "listEvents"),
      isRevoked: vi.spyOn(s.repo, "isRevoked"),
      declaration: vi.spyOn(s.declarations, "find"),
      human: vi.spyOn(s.store, "findByTenant"),
      linked: vi.spyOn(s.repo, "listLinked"),
    };
    expect(agentIdsOf(await list())).toEqual(["2", "1"]);
    expect(
      Object.fromEntries(Object.entries(reads).map(([name, spy]) => [name, spy.mock.calls.length])),
    ).toEqual({
      company: 2,
      check: 2,
      checks: 0,
      events: 2,
      isRevoked: 0,
      declaration: 2,
      human: 2,
      linked: 1,
    });
    expect(reads.linked).toHaveBeenCalledWith({ chainId: CHAIN_ID, factory: FACTORY }, 100);
  });

  test("pending, revoked, broken, unknown and never-linked bodies are not listed", async () => {
    const rows = situations();
    expect(agentIdsOf(await list())).toEqual([rows.active?.agentId]);
    // Only linked rows are read: the broken row and the one never linked are not in the snapshot.
    expect(chain.snapshots).toHaveLength(1);
    expect(chain.snapshots[0]?.map((r) => r.agentId)).toEqual([
      11n,
      10n,
      8n,
      7n,
      6n,
      4n,
      3n,
      2n,
      1n,
    ]);
  });

  test("a linked body is listed exactly when its statement by agent reads active, about that body", async () => {
    situations();
    const deps = statementDeps(s, chain);
    const listed = new Set(listedOf(await activeLegalBodies(deps, 100)).map((b) => b.legalBody));
    const linkedRows = s.repo.listLinked(deps.deployment, 100);
    expect(linkedRows).toHaveLength(9);
    for (const row of linkedRows) {
      const out = await statementForAgent(deps, row.agentId as string);
      const active =
        out.kind === "statement" &&
        out.standing === "active" &&
        out.statement.message.legalBody === getAddress(row.bodyAddress as string);
      expect(listed.has(getAddress(row.bodyAddress as string)), `agent ${row.agentId}`).toBe(
        active,
      );
    }
  });

  test("no linked row: an empty list, and no chain read", async () => {
    // A body on its way, never linked: not a linked row, even while the chain links it.
    chain.link(bodyIn("deployed", s, checkedCompany(), { agentId: "7" }));
    await expect(list()).resolves.toEqual([]);
    expect(chain.snapshots).toEqual([]);
  });

  test("at most `limit` rows, the most recent sightings first", async () => {
    for (const id of ["1", "2", "3", "4", "5"]) linkedBody(id);
    expect(agentIdsOf(await list({}, 2))).toEqual(["5", "4"]);
    expect(chain.snapshots[0]).toHaveLength(2);
    // The repository's bound: a listing reads at most 100 rows.
    await expect(list({}, 101)).rejects.toThrow();
  });

  test("a row the chain or the records disagree with is skipped, with the statement's integrity ops line", async () => {
    const good = linkedBody("1");
    const otherAgent = linkedBody("2");
    chain.addBody(otherAgent, { metaAgentId: 99n });
    const noCreator = linkedBody("3");
    chain.addBody(noCreator, { creator: undefined });
    const otherCreator = linkedBody("4");
    chain.addBody(otherCreator, {
      creator: getAddress("0x00000000000000000000000000000000000a0002"),
    });
    const notCustomers = linkedBody("5");
    const find = s.companies.find.bind(s.companies);
    vi.spyOn(s.companies, "find").mockImplementation((companyId: string) => {
      const company = find(companyId);
      return company && companyId === notCustomers.companyId
        ? { ...company, provider: "example-formation-provider" }
        : company;
    });

    expect(agentIdsOf(await list())).toEqual([good.agentId]);
    expect(opsLines("legal_body_statement_integrity")).toEqual([
      { legalBodyId: notCustomers.legalBodyId, problem: "unsupported_provider" },
      { legalBodyId: otherCreator.legalBodyId, problem: "not_ours" },
      { legalBodyId: noCreator.legalBodyId, problem: "not_ours" },
      { legalBodyId: otherAgent.legalBodyId, problem: "agent_mismatch" },
    ]);
  });

  test("a row missing a field its state requires is skipped before the snapshot, with the ops line", async () => {
    const good = linkedBody("1");
    const incomplete = linkedBody("2");
    const unseen = linkedBody("3");
    vi.spyOn(s.repo, "listLinked").mockReturnValue([
      { ...unseen, pointerSeenAt: null },
      { ...incomplete, bodyAddress: null },
      good,
    ]);
    expect(agentIdsOf(await list())).toEqual(["1"]);
    expect(chain.snapshots).toEqual([[{ agentId: 1n, bodies: [good.bodyAddress] }]]);
    expect(opsLines("legal_body_statement_integrity")).toEqual([
      { legalBodyId: unseen.legalBodyId, problem: "row_incomplete" },
      { legalBodyId: incomplete.legalBodyId, problem: "row_incomplete" },
    ]);
  });

  test("a chain read that fails: unavailable, with one ops line naming the error, never its text", async () => {
    linkedBody("42");
    chain.beforeSnapshot = () => {
      throw new TransportFailure();
    };
    const company = vi.spyOn(s.companies, "find");
    await expect(list()).resolves.toBe("unavailable");
    expect(opsLines("legal_body_statement_unavailable")).toEqual([
      { stage: "snapshot", errorName: "HttpRequestError" },
    ]);
    expect(printed.join("\n")).not.toContain("rpc.example");
    // Nothing more is read once the chain could not be.
    expect(company).not.toHaveBeenCalled();
    expect(logRows()).toEqual([]);
  });

  test("a snapshot that does not hold exactly what was asked: unavailable", async () => {
    linkedBody("1");
    linkedBody("2");
    type Agents = Awaited<ReturnType<StatementChainPort["readStatementSnapshot"]>>["agents"];
    const faults: Record<string, (agents: Agents) => Agents> = {
      "an agent missing": (agents) => agents.slice(1),
      "an agent too many": (agents) => [...agents, ...agents.slice(0, 1)],
      "the agents in another order": (agents) => [...agents].reverse(),
      "a body missing": (agents) => agents.map((a) => ({ ...a, bodies: [] })),
    };
    for (const [fault, alter] of Object.entries(faults)) {
      printed.length = 0;
      const faulty: StatementChainPort = {
        chainId: chain.chainId,
        factory: chain.factory,
        codeKind: (address, blockNumber) => chain.codeKind(address, blockNumber),
        readStatementSnapshot: async (requests) => {
          const snap = await chain.readStatementSnapshot(requests);
          return { ...snap, agents: alter(snap.agents) };
        },
      };
      await expect(list({ chain: faulty }), fault).resolves.toBe("unavailable");
      expect(opsLines("legal_body_statement_unavailable"), fault).toEqual([
        { stage: "snapshot", errorName: "IncompleteSnapshotError" },
      ]);
    }
  });

  test("a database read that fails throws: the listing, or a row's facts", async () => {
    linkedBody("42");
    const locked = () => {
      throw Object.assign(new Error("database is locked"), { name: "SqliteError" });
    };
    const listing = vi.spyOn(s.repo, "listLinked").mockImplementation(locked);
    await expect(list()).rejects.toThrow("database is locked");
    expect(chain.snapshots).toEqual([]);
    listing.mockRestore();

    for (const fail of [
      () => vi.spyOn(s.companies, "find").mockImplementation(locked),
      () => vi.spyOn(s.checks, "latest").mockImplementation(locked),
      () => vi.spyOn(s.repo, "listEvents").mockImplementation(locked),
      () => vi.spyOn(s.declarations, "find").mockImplementation(locked),
      () => vi.spyOn(s.store, "findByTenant").mockImplementation(locked),
    ]) {
      const spy = fail();
      await expect(list()).rejects.toThrow("database is locked");
      spy.mockRestore();
    }
  });

  test("no ops line carries a name, a filing number, an address or an error's text", async () => {
    linkedBody("1");
    const refused = linkedBody("2");
    chain.addBody(refused, { metaAgentId: 99n });
    await list();
    chain.beforeSnapshot = () => {
      throw new TransportFailure();
    };
    await list();
    expect(opsLines("legal_body_statement_integrity")).toHaveLength(1);
    expect(opsLines("legal_body_statement_unavailable")).toHaveLength(1);
    for (const line of printed) {
      expect(() => JSON.parse(line), line).not.toThrow();
      expect(line).not.toMatch(/0x[0-9a-fA-F]{40}/);
      for (const secret of [
        "Example Holdings",
        "TEST-0001",
        "Example Registered Agent",
        "rpc.example",
      ])
        expect(line).not.toContain(secret);
    }
  });
});

// ── The route ───────────────────────────────────────────────────────────────────────────────

/** A public entity of the full product, with a settled job: the part of the body that was there
 *  before the section. Every value is a placeholder. */
const ENTITY: EntityRecord = {
  idempotencyKey: "tenant-example:agent",
  name: "Example Agent",
  status: "funded",
  manager: "0x0000000000000000000000000000000000000001",
  guardian: "0x0000000000000000000000000000000000000002",
  operator: null,
  amendmentDelay: "0",
  ein: "00-0000000",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: "7001",
  proxy: "0x0000000000000000000000000000000000000b01",
  treasury: "0x0000000000000000000000000000000000000b02",
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  ownerTenantId: "tenant-example",
  walletProvider: "circle",
  publicId: "00000000-0000-4000-8000-000000000001",
};
const SETTLED_JOB: JobRecord = {
  jobKey: "job-1",
  jobId: "1",
  entityKey: ENTITY.idempotencyKey,
  ownerTenantId: "tenant-example",
  status: "reputed",
  clientAddress: "0x0000000000000000000000000000000000000003",
  evaluatorAddress: "0x0000000000000000000000000000000000000004",
  providerAddress: "0x0000000000000000000000000000000000000005",
  budgetAmount: "1500000",
  description: "an invented job",
  deliverableHash: null,
  deliverablePath: null,
  createTxHash: null,
  fundTxHash: null,
  submitTxHash: null,
  completeTxHash: null,
  sweepTxHash: null,
  reputationTxHash: null,
  refundTxHash: null,
  escrowState: null,
  error: null,
  createdAt: null,
  updatedAt: null,
};

function fullProductPart(): void {
  new SqliteEntityRepository(s.db).upsert(ENTITY);
  new SqliteJobRepository(s.db).upsert(SETTLED_JOB);
}

/** The app over the stores, on the clock; the statement's dependencies wired unless told not. */
function makeApp(o: { statements?: boolean; over?: Partial<LegalBodyStatementDeps> } = {}) {
  return buildApiApp({
    webOrigin: "https://www.example.test",
    jwtSecret: "s",
    now: () => clock,
    repo: new SqliteEntityRepository(s.db),
    jobs: new SqliteJobRepository(s.db),
    legalBodyStatements:
      o.statements === false ? undefined : statementDeps(s, chain, { now: () => clock, ...o.over }),
  } as never);
}

// biome-ignore lint/suspicious/noExplicitAny: a JSON answer, read field by field
type Json = any;
const getBody = async (app: ReturnType<typeof makeApp>): Promise<Json> =>
  (await app.request("/transparency")).json();

/** A promise the test settles. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("GET /transparency", () => {
  test("with the statement's dependencies: the section, its flag and its count, beside the body as it was", async () => {
    fullProductPart();
    const row = linkedBody("42");
    linkedBody("43", { status: "draft" });

    const res = await makeApp().request("/transparency");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body: Json = await res.json();
    expect(Object.keys(body)).toEqual(["stats", "entities", "legalBodies", "legalBodiesAvailable"]);
    expect(body.stats).toEqual({
      entities: 1,
      jobsSettled: 1,
      usdcSettledAtomic: "1500000",
      legalBodies: 1,
    });
    expect(body.legalBodiesAvailable).toBe(true);
    expect(body.legalBodies).toEqual([
      {
        agentId: "42",
        publicId: row.publicId,
        legalBody: getAddress(row.bodyAddress as string),
        chainId: CHAIN_ID,
        legalName: "Example Holdings LLC",
        filingNumber: "TEST-0001",
        jurisdiction: "WY",
        entityType: "LLC",
        source: "customer",
        environment: "sandbox",
        standing: "active",
        linkedSince: "2026-10-04T18:00:42.000Z",
        links: { statement: `${STATEMENT_BASE}42` },
      },
    ]);

    // The rest is what the route serves without the section.
    const without: Json = await getBody(makeApp({ statements: false }));
    expect(body.entities).toEqual(without.entities);
    const { legalBodies: _count, ...stats } = body.stats;
    expect(stats).toEqual(without.stats);
  });

  test("the section names no human reference, credential, tenant, guardian or customer address, and no custody label", async () => {
    linkedBody("42");
    const body: Json = await getBody(makeApp());
    expect(body.legalBodies).toHaveLength(1);
    const text = JSON.stringify(body.legalBodies);
    for (const absent of [
      TENANT,
      TENANT.toLowerCase(),
      OWNER,
      OWNER.toLowerCase(),
      "humanRef",
      "credential",
      "nullifier",
      "tenant",
      "guardian",
      "walletProvider",
      "turnkey",
      "Example Registered Agent",
      "ops.example",
    ])
      expect(text).not.toContain(absent);
  });

  test("a chain read that fails: an empty section that says so, and the rest of the body as usual", async () => {
    fullProductPart();
    linkedBody("42");
    chain.beforeSnapshot = () => {
      throw new TransportFailure();
    };
    const res = await makeApp().request("/transparency");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body: Json = await res.json();
    expect(body.legalBodies).toEqual([]);
    expect(body.legalBodiesAvailable).toBe(false);
    expect(body.stats).toEqual({
      entities: 1,
      jobsSettled: 1,
      usdcSettledAtomic: "1500000",
      legalBodies: 0,
    });
    expect(body.entities).toHaveLength(1);
    expect(opsLines("legal_body_statement_unavailable")).toEqual([
      { stage: "snapshot", errorName: "HttpRequestError" },
    ]);
    expect(JSON.stringify(body)).not.toContain("rpc.example");
  });

  test("without the statement's dependencies: the body is exactly today's, and the chain is never read", async () => {
    fullProductPart();
    linkedBody("42");
    const listing = vi.spyOn(s.repo, "listLinked");
    const res = await makeApp({ statements: false }).request("/transparency");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const body: Json = await res.json();
    expect(body).toEqual({
      stats: { entities: 1, jobsSettled: 1, usdcSettledAtomic: "1500000" },
      entities: [
        {
          publicId: ENTITY.publicId,
          name: "Example Agent",
          agentId: "7001",
          status: "funded",
          legalManager: ENTITY.proxy,
          treasury: ENTITY.treasury,
          walletProvider: "circle",
          humanVerified: false,
          credential: null,
          createdAt: expect.any(String),
          formation: null,
          jobsSettled: 1,
          usdcSettledAtomic: "1500000",
        },
      ],
    });
    expect(Object.keys(body)).toEqual(["stats", "entities"]);
    expect(Object.keys(body.stats)).toEqual(["entities", "jobsSettled", "usdcSettledAtomic"]);
    expect(chain.snapshots).toEqual([]);
    expect(listing).not.toHaveBeenCalled();
  });

  test("twenty concurrent requests on a cold cache share ONE computation and ONE snapshot", async () => {
    linkedBody("42");
    const held = gate();
    let snapshotsAsked = 0;
    const slow: StatementChainPort = {
      chainId: chain.chainId,
      factory: chain.factory,
      codeKind: (address, blockNumber) => chain.codeKind(address, blockNumber),
      readStatementSnapshot: async (requests) => {
        snapshotsAsked += 1;
        await held.promise;
        return chain.readStatementSnapshot(requests);
      },
    };
    const listing = vi.spyOn(s.repo, "listLinked");
    const app = makeApp({ over: { chain: slow } });

    const pending = Array.from({ length: 20 }, () => app.request("/transparency"));
    // Every request has reached the route while the one snapshot is still being read.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshotsAsked).toBe(1);
    held.open();
    const answers = await Promise.all(pending);

    expect(answers.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(answers.map((r) => r.headers.get("cache-control"))).toEqual(Array(20).fill(FRESH));
    const texts = await Promise.all(answers.map((r) => r.text()));
    expect(new Set(texts).size).toBe(1);
    expect(JSON.parse(texts[0] as string).stats.legalBodies).toBe(1);
    expect(snapshotsAsked).toBe(1);
    expect(chain.snapshots).toHaveLength(1);
    expect(listing).toHaveBeenCalledTimes(1);
    // The section lists at most 100 bodies.
    expect(listing).toHaveBeenCalledWith({ chainId: CHAIN_ID, factory: FACTORY }, 100);
  });

  test("a computation that fails is not kept: the requests sharing it answer 500, uncacheable, and the next request computes afresh", async () => {
    linkedBody("42");
    const find = s.companies.find.bind(s.companies);
    let failing = true;
    vi.spyOn(s.companies, "find").mockImplementation((companyId: string) => {
      if (failing) throw Object.assign(new Error("database is locked"), { name: "SqliteError" });
      return find(companyId);
    });
    const app = makeApp();

    const shared = await Promise.all([app.request("/transparency"), app.request("/transparency")]);
    for (const res of shared) {
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBeNull();
      expect(await res.text()).not.toContain("database is locked");
    }
    expect(chain.snapshots).toHaveLength(1);

    // The same instant, well inside the ten seconds: nothing was kept, so it is computed again.
    failing = false;
    const res = await app.request("/transparency");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    expect((await res.json()).stats.legalBodies).toBe(1);
    expect(chain.snapshots).toHaveLength(2);
  });

  test("an older computation that fails after a newer one started leaves the newer one in place", async () => {
    linkedBody("42");
    const holds = [gate(), gate()];
    let snapshotsAsked = 0;
    const slow: StatementChainPort = {
      chainId: chain.chainId,
      factory: chain.factory,
      codeKind: (address, blockNumber) => chain.codeKind(address, blockNumber),
      readStatementSnapshot: async (requests) => {
        const held = holds[snapshotsAsked];
        snapshotsAsked += 1;
        await held?.promise;
        return chain.readStatementSnapshot(requests);
      },
    };
    const find = s.companies.find.bind(s.companies);
    let failing = true;
    vi.spyOn(s.companies, "find").mockImplementation((companyId: string) => {
      if (failing) throw Object.assign(new Error("database is locked"), { name: "SqliteError" });
      return find(companyId);
    });
    const app = makeApp({ over: { chain: slow } });

    const reachRoute = () => new Promise((resolve) => setTimeout(resolve, 20));
    const older = app.request("/transparency");
    await reachRoute();
    expect(snapshotsAsked).toBe(1);
    // The older computation is past its window and still reading: the next request starts anew.
    clock += 10_000;
    const newer = app.request("/transparency");
    await reachRoute();
    expect(snapshotsAsked).toBe(2);

    holds[0]?.open();
    expect((await older).status).toBe(500);
    failing = false;
    holds[1]?.open();
    expect((await newer).status).toBe(200);

    // Served by the newer computation, which the older one's failure did not drop.
    const res = await app.request("/transparency");
    expect(res.status).toBe(200);
    expect((await res.json()).stats.legalBodies).toBe(1);
    expect(snapshotsAsked).toBe(2);
  });

  test("a failure of the part that was there before is not kept either", async () => {
    fullProductPart();
    const entities = new SqliteEntityRepository(s.db);
    const listPublic = entities.listPublicOnChain.bind(entities);
    let failing = true;
    vi.spyOn(entities, "listPublicOnChain").mockImplementation(() => {
      if (failing) throw new Error("database is locked");
      return listPublic();
    });
    const app = buildApiApp({
      webOrigin: "https://www.example.test",
      jwtSecret: "s",
      now: () => clock,
      repo: entities,
      jobs: new SqliteJobRepository(s.db),
    } as never);
    const failed = await app.request("/transparency");
    expect(failed.status).toBe(500);
    expect(failed.headers.get("cache-control")).toBeNull();
    failing = false;
    const res = await app.request("/transparency");
    expect(res.status).toBe(200);
    expect((await res.json()).stats.entities).toBe(1);
  });

  test("the section rides the ten-second cache: one snapshot a window, and a revocation leaves the list at the next one", async () => {
    const row = linkedBody("42");
    const app = makeApp();
    expect((await getBody(app)).stats.legalBodies).toBe(1);
    s.repo.recordEvent(row.legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    clock += 9_999;
    expect((await getBody(app)).stats.legalBodies).toBe(1);
    expect(chain.snapshots).toHaveLength(1);

    clock += 1;
    const fresh: Json = await getBody(app);
    expect(fresh.legalBodies).toEqual([]);
    expect(fresh.stats.legalBodies).toBe(0);
    expect(chain.snapshots).toHaveLength(2);
  });

  test("an unavailable section is kept for the window like any answer: an outage costs one snapshot a window", async () => {
    linkedBody("42");
    let down = true;
    chain.beforeSnapshot = () => {
      if (down) throw new TransportFailure();
    };
    const app = makeApp();
    expect((await getBody(app)).legalBodiesAvailable).toBe(false);
    clock += 5_000;
    down = false;
    expect((await getBody(app)).legalBodiesAvailable).toBe(false);
    expect(chain.snapshots).toHaveLength(1);

    clock += 5_000;
    const back: Json = await getBody(app);
    expect(back.legalBodiesAvailable).toBe(true);
    expect(back.stats.legalBodies).toBe(1);
    expect(chain.snapshots).toHaveLength(2);
  });
});
