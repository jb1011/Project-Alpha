/**
 * THE PUBLIC LEGAL-BODY STATEMENT ON A LOCAL CHAIN: a linked legal body of a checked company is
 * stated by agent and by address, signed, and read at one block, through the canonical Multicall3
 * and without it; and each later fact (a revocation, a cleared pointer, a dissolution, a transfer,
 * a node that throttles, a payment, a filing) changes what the next statement says.
 *
 * The real API app with its order doors, the public lookup by address and the statement by agent;
 * the real repositories over a database file and a file document store; the real sweeper; and the
 * real chain adapter over anvil, where the real NoviController relays each create to the real
 * LegalBodyFactory. The identity registry is the mock registry the factory reads. The canonical
 * Multicall3 runtime code is installed at its canonical address. The full product's resolver reads
 * an entity table that holds no entity, so every address goes to the Minimal legal body's answer.
 *
 * Two chain adapters over the same node: one reads a statement's chain facts through Multicall3,
 * the other with separate reads. Every case runs on the first; the first case and the case of the
 * statement log run on the second too. A deployment's order doors and its statement share one
 * adapter, as the composition root wires them.
 *
 * One chain for the file. One database, app and sweeper per case. Each case mines a block first,
 * since the adapter believes no head more than 120 seconds old, and has its own guardian. The app,
 * the sweeper and the adapter read one clock; a case that needs a memo to expire moves the chain's
 * clock and that one together. The per-client limiter refills on the real clock, so every request
 * comes from a client of its own.
 *
 * The attestor is an anvil test key that holds no other role here. Every key is derived from
 * anvil's published test mnemonic, never a real wallet, and every name and filing number is an
 * invention.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  http,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
  createPublicClient,
  createTestClient,
  keccak256,
  parseEther,
  size,
  zeroAddress,
} from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  iIdentityRegistryAbi,
  legalBodyFactoryAbi,
  legalManagerAbi,
} from "../../src/abis/generated";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { LegalBodyChain } from "../../src/adapters/arc/legalBodyChain";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { anvilChain } from "../../src/chains";
import {
  DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS,
  LEGAL_BODY_FLOW_DEFAULTS,
} from "../../src/config/env";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { expireStaleCustomerCompanies } from "../../src/legalBody/customerCompany";
import { expireEvidenceBytes } from "../../src/legalBody/evidence";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { verifyPublicStatement } from "../../src/legalBody/publicStatement";
import type { LegalBodyStatementDeps } from "../../src/legalBody/statements";
import {
  HOUSEKEEPING_BATCH,
  LEGAL_BODY_SWEEP_MAX_PER_TICK,
  LegalBodySweeper,
} from "../../src/legalBody/sweeper";
import { createLegalBodyResolver } from "../../src/payments/legalBody";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import { SqliteLegalBodyStatementRepository } from "../../src/persistence/legalBodyStatementRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { addDays, wyomingDate } from "../../src/util/wyomingCalendar";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { sandboxCustomerCompanyDeps, worldFor } from "../helpers/customerCompanyFixtures";
import type { Json } from "../helpers/legalBodyFixtures";
import {
  COMPANY_NAME,
  type CheckedFilings,
  type Guardian,
  JWT_SECRET,
  type LinkedHarness,
  asGuardian,
  identityOfKey,
  keyAt,
  linkedOrder,
  newGuardian,
  recordPassedCheck,
  setAgentWallet,
  setPointer,
  transferIdentity,
  walletOf,
} from "../helpers/legalBodyLinkedHarness";
import { type LegalBodyStack, deployLegalBodyStack } from "../helpers/legalBodyStack";
import { MULTICALL3_ADDRESS, MULTICALL3_CODE_HASH, installMulticall3 } from "../helpers/multicall3";

/** This file's own port: 8545 to 8554 belong to the other anvil-based files. */
const PORT = 8555;

/** Signs and pays for every create: the backend's platform key. */
const executor = keyAt(0);
/** The controller's role administrator. */
const admin = keyAt(1);
/** The identities' owner. The test registry binds it as each identity's wallet. */
const owner = keyAt(2);
/** A key that owns nothing here. */
const stranger = keyAt(3);
/** Deploys the contracts. */
const deployer = keyAt(4);
/** The identity's next owner, once the owner transfers it. */
const buyer = keyAt(5);
/** Signs every statement: an anvil test key, and no other role here. */
const attestor = keyAt(6);
/** Each case's guardians take the next keys from here on: keys anvil does not fund. */
const FIRST_GUARDIAN_INDEX = 10;
/** A wallet the owner binds to its identity after the link. It never pays for anything. */
const secondWallet = keyAt(1_001);

/** The links the deployment serves: placeholders. */
const TRANSPARENCY = "https://www.example.test/transparency";
const METADATA_BASE = "https://api.example.test";
const STATEMENT_BASE = "https://api.example.test/legal-bodies/by-agent/";

const FRESH = "public, max-age=15";
const NO_STORE = "no-store";
/** Past the 15-second memo of both public routes. */
const PAST_MEMO_SECONDS = 16;
/** Past the 10-second cache of `/transparency`. */
const PAST_TRANSPARENCY_CACHE_SECONDS = 11;

let anvil: AnvilHandle | undefined;
let rpcUrl = "";
let pub: PublicClient;
/** anvil's own controls: mine a block, move the chain's clock, set a balance, set code. */
let node: TestClient;
let stack: LegalBodyStack;
let arc: ArcAdapter;
/** The chain adapter whose statement snapshot reads through Multicall3, and the one that reads
 *  each fact with a call of its own. */
let throughMulticall3: LegalBodyChain;
let withSeparateReads: LegalBodyChain;

/**
 * The one clock of the app, the sweeper and the chain adapters: the wall clock, moved forward only
 * together with the chain's (`moveTime`).
 */
let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;

/**
 * The node the chain adapters read, a transport in front of anvil. While `throttle.on` is set it
 * answers every request with HTTP 429, as a provider over its rate limit does. Every request it
 * passes on is noted in `reached`: its method, and an `eth_call`'s target.
 */
const throttle = { on: false };
const reached: { method: string; to: string | null }[] = [];

function noteRequests(body: unknown): void {
  if (typeof body !== "string") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  for (const request of Array.isArray(parsed) ? parsed : [parsed]) {
    const { method, params } = request as { method?: unknown; params?: unknown };
    if (typeof method !== "string") continue;
    const target = Array.isArray(params) ? (params[0] as { to?: unknown } | undefined)?.to : null;
    reached.push({
      method,
      to: method === "eth_call" && typeof target === "string" ? target.toLowerCase() : null,
    });
  }
}

/** How many of `requests` went out under each method. */
function byMethod(requests: readonly { method: string }[]): Record<string, number> {
  const counted: Record<string, number> = {};
  for (const { method } of requests) counted[method] = (counted[method] ?? 0) + 1;
  return counted;
}

beforeAll(async () => {
  anvil = await startAnvil(PORT);
  rpcUrl = anvil.rpcUrl;
  pub = createPublicClient({
    chain: anvilChain,
    transport: http(rpcUrl, {
      retryCount: 0,
      fetchFn: async (input, init) => {
        if (throttle.on) return new Response("Too Many Requests", { status: 429 });
        noteRequests(init?.body);
        return fetch(input, init);
      },
    }),
  });
  node = createTestClient({ chain: anvilChain, mode: "anvil", transport: http(rpcUrl) });
  stack = await deployLegalBodyStack({
    deployer: walletOf(rpcUrl, deployer),
    admin: walletOf(rpcUrl, admin),
    pub,
    executor: executor.address,
  });
  await installMulticall3(node);
  arc = new ArcAdapter({
    publicClient: pub,
    managerWallet: walletOf(rpcUrl, executor),
    sendClient: pub,
    chainId: anvilChain.id,
    // The entity factory, a placeholder: the legal-body path never calls it.
    factory: "0x00000000000000000000000000000000000000f1",
    identityRegistry: stack.registry,
    controller: stack.controller,
  });
  const chainDeps = {
    publicClient: pub,
    arc,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
    maxHeadAgeSeconds: 120,
    now,
  };
  throughMulticall3 = new LegalBodyChain({ ...chainDeps, multicall3: MULTICALL3_ADDRESS });
  withSeparateReads = new LegalBodyChain(chainDeps);
}, 60_000);

afterAll(() => anvil?.stop());

// ── One deployment per case ───────────────────────────────────────────────────────────────────

/** What one case runs on: its stores, its app, and the harness the linked order is made with. */
interface Deployment {
  db: Database.Database;
  companies: SqliteCompanyRepository;
  legalBodies: SqliteLegalBodyRepository;
  statementLog: SqliteLegalBodyStatementRepository;
  app: ReturnType<typeof buildApiApp>;
  h: LinkedHarness;
}

interface DeployOptions {
  /** A deployment that charges: a customer company waits as a draft for its payment. */
  charging?: boolean;
  /** How the statement's snapshot reads the chain. */
  reads?: "multicall3" | "separate";
}

let dir: string;
let d: Deployment;
/** Every console line written in the case: the ops lines among them. */
let printed: string[];
let nextGuardian = FIRST_GUARDIAN_INDEX;

/** A throttle that always has a token: the order doors' caps are not under test here. */
const open = () => ({ take: () => true });

/**
 * The deployment as the composition root wires it where the legal-body feature is on and the
 * attestation key is set, over this case's database and document store, on the shared clock: the
 * order doors and the sweeper, the public lookup by address with the full product's resolver over
 * an empty entity table, and the statement by agent. The two public routes share one read budget,
 * 30 burst and 1 per second, as the composition root's.
 */
function deploy(opts: DeployOptions = {}): Deployment {
  const db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  const companies = new SqliteCompanyRepository(db);
  const declarations = new SqliteCompanyDeclarationRepository(db);
  const checks = new SqliteCompanyCheckRepository(db);
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new FileDocumentStore(join(dir, "documents"));
  const store = new SqliteWorldStore(db);
  const legalBodies = new SqliteLegalBodyRepository(db);
  const statementLog = new SqliteLegalBodyStatementRepository(db);
  const requests = new SqliteFormationRepository(db);
  const entities = new SqliteEntityRepository(db);
  const world = worldFor(store);
  const chain = opts.reads === "separate" ? withSeparateReads : throughMulticall3;
  const deployment = { chainId: anvilChain.id, factory: stack.factory };

  const orderDeps: LegalBodyOrderDeps = {
    repo: legalBodies,
    companies,
    declarations,
    checks,
    world,
    chain,
    docStore,
    deployment,
    identityRegistry: stack.registry,
    // The agreement's wording is a draft, which only a sandbox serves.
    environment: "sandbox",
    ...LEGAL_BODY_FLOW_DEFAULTS,
    doorBudget: open(),
    tenantBucket: open,
    identityBucket: open,
    transaction: (fn) => legalBodies.transaction(fn),
    now,
    sleep: async () => {},
  };
  const customerDeps = sandboxCustomerCompanyDeps(
    { db, companies, declarations, checks, store },
    now,
    {
      chainId: anvilChain.id,
      factory: stack.factory,
      paymentRequired: opts.charging === true,
      world,
    },
  );
  const sweeper = new LegalBodySweeper({
    ...orderDeps,
    intervalMs: DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS,
    maxPerTick: LEGAL_BODY_SWEEP_MAX_PER_TICK,
    housekeeping: {
      expireEvidence: () => expireEvidenceBytes({ documents, docStore, now }, HOUSEKEEPING_BATCH),
      expireStaleCompanies: () =>
        expireStaleCustomerCompanies(
          {
            companies,
            declarations,
            checks,
            hasOpenLegalBody: (companyId: string) =>
              legalBodies.hasOpenForCompany(companyId, now()),
            transaction: (fn) => legalBodies.transaction(fn),
            now,
          },
          HOUSEKEEPING_BATCH,
        ),
    },
  });

  const publicReadBudget = new TokenBucket(30, 1);
  const legalBodyStatements: LegalBodyStatementDeps = {
    repo: legalBodies,
    statements: statementLog,
    companies,
    checks,
    declarations,
    world,
    chain,
    deployment,
    identityRegistry: stack.registry,
    environment: "sandbox",
    signer: attestor,
    readBudget: publicReadBudget,
    network: "testnet",
    links: { transparency: TRANSPARENCY, statementBase: STATEMENT_BASE },
    now,
  };
  /** The full product's two chain reads: never made, since no entity of the full product exists. */
  const noFullProductRead = async (): Promise<never> => {
    throw new Error("the full product's chain was read");
  };
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: anvilChain.id,
    identityRegistry: stack.registry,
    now,
    repo: entities,
    jobs: new SqliteJobRepository(db),
    companies,
    documents,
    docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations,
      checks,
      hasLinkedLegalBody: (companyId: string) => legalBodies.hasLinkedForCompany(companyId),
    },
    legalBodyOrders: orderDeps,
    legalBodyStatements,
    legalBody: {
      resolver: createLegalBodyResolver({
        findByPocketAddress: (a) => entities.findByPocketAddress(a),
        findByTreasury: (a) => entities.findByTreasury(a),
        legalStatus: noFullProductRead,
        treasuryPaused: noFullProductRead,
      }),
      readBudget: publicReadBudget,
      links: { transparency: TRANSPARENCY, metadataBase: METADATA_BASE },
      network: "testnet",
    },
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  const app = buildApiApp(deps as ApiDeps);
  return {
    db,
    companies,
    legalBodies,
    statementLog,
    app,
    h: {
      rpcUrl,
      pub,
      stack,
      app,
      tick: () => sweeper.tick(),
      checks,
      store,
      customerDeps,
      now,
    },
  };
}

/** The case's deployment built again over the same files, with other options. */
function redeploy(opts: DeployOptions): void {
  d.db.close();
  d = deploy(opts);
}

beforeEach(async () => {
  // A head more than 120 seconds old is not believed: every case starts on a fresh block.
  await node.mine({ blocks: 1 });
  dir = mkdtempSync(join(tmpdir(), "legal-body-statement-"));
  d = deploy();
  printed = [];
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  throttle.on = false;
  d.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Asking, as a stranger does ────────────────────────────────────────────────────────────────

/** How many public requests the file has made: each comes from a client of its own. */
let clients = 0;

/** One public, unauthenticated request. The proxy appends the client's address last. */
async function ask(
  path: string,
): Promise<{ status: number; cache: string | null; body: Json; text: string }> {
  clients += 1;
  const res = await d.app.request(path, {
    headers: { "x-forwarded-for": `198.51.100.7, 2001:db8::${clients.toString(16)}` },
  });
  const text = await res.text();
  return {
    status: res.status,
    cache: res.headers.get("cache-control"),
    body: JSON.parse(text),
    text,
  };
}
const byAgent = (agentId: bigint) => ask(`/legal-bodies/by-agent/${agentId}`);
const byAddress = (address: Address) => ask(`/legal-bodies/${address}`);

/** Move the chain's clock and the shared clock forward together, by whole seconds. */
async function moveTime(seconds: number): Promise<void> {
  await node.increaseTime({ seconds });
  await node.mine({ blocks: 1 });
  clockOffsetMs += seconds * 1_000;
}
const pastMemo = () => moveTime(PAST_MEMO_SECONDS);

/** The rows of the case's statement log. */
const logRows = (): number =>
  (d.db.prepare("SELECT COUNT(*) AS n FROM statement_log").get() as { n: number }).n;

/** Whether `signed` verifies as a statement of `signer` for this chain, now. */
const verifies = (signed: Json, signer: Address = attestor.address): Promise<boolean> =>
  verifyPublicStatement(signed, {
    attestor: signer,
    expectedChainId: anvilChain.id,
    nowSeconds: Math.floor(now() / 1_000),
  });

/** The ops lines named `event` this case printed, parsed. */
function opsLines(event: string): Json[] {
  return printed.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { opslog?: string };
      return parsed.opslog === event ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

/**
 * A guardian of its own, whose company was checked with `filings`; an identity of the owner's
 * key; and the body linked for it through the doors.
 */
async function linkedBody(
  filings: CheckedFilings = {},
): Promise<{ g: Guardian; agentId: bigint; id: string; body: Address }> {
  const g = await newGuardian(d.h, nextGuardian++, filings);
  const agentId = await identityOfKey(d.h, owner);
  const { id, body } = await linkedOrder(d.h, g, owner, agentId);
  return { g, agentId, id, body };
}

/** `legal-body:revoke`: the event the operator's command writes. */
function revokeLegalBody(id: string): void {
  d.legalBodies.recordEvent(id, "revoked", "operator:ops.example", null, {
    reason: "Recorded for a test.",
  });
}

/** `company:revoke` or `company:reinstate`: the check the operator's command records. */
function companyStateCheck(companyId: string, result: "revoked" | "reinstated"): void {
  d.h.checks.append({
    companyId,
    result,
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: Math.floor(now() / 1_000),
    registryName: null,
    registryFilingId: null,
    registryStatus: null,
    formationDate: null,
    registeredAgent: null,
    existenceEvidenceSha256: null,
    controlEvidenceSha256: null,
    controlEvidenceKind: null,
    reasonCode: null,
    reason: "Recorded for a test.",
  });
}

/** The first annual report due date of a company formed on `formationDate`: the first day of its
 *  formation month, the year after. */
const firstDueOf = (formationDate: string): string =>
  `${Number(formationDate.slice(0, 4)) + 1}-${formationDate.slice(5, 7)}-01`;

/**
 * The filing dates of a company whose last annual report fell due about 120 days before the
 * shared clock: the first day of the month four months before its Wyoming date, a formation on
 * the 10th of that month two years earlier, and the next due date a year after the last, about
 * eight months ahead. Derived from the clock, so they hold whatever the date.
 */
function dueAboutFourMonthsAgo(): { formedOn: string; lastDue: string; nextDue: string } {
  const today = wyomingDate(Math.floor(now() / 1_000));
  const months = Number(today.slice(0, 4)) * 12 + (Number(today.slice(5, 7)) - 1) - 4;
  const year = Math.floor(months / 12);
  const month = String((months % 12) + 1).padStart(2, "0");
  return {
    formedOn: `${year - 2}-${month}-10`,
    lastDue: `${year}-${month}-01`,
    nextDue: `${year + 1}-${month}-01`,
  };
}

// ── The cases ─────────────────────────────────────────────────────────────────────────────────

test("the canonical Multicall3 is installed at its address: 3,808 bytes hashing to the canonical deployment's", async () => {
  const code = await pub.getCode({ address: MULTICALL3_ADDRESS });
  if (code === undefined) throw new Error("no code at the Multicall3 address");
  expect(size(code)).toBe(3_808);
  expect(keccak256(code)).toBe(MULTICALL3_CODE_HASH);
});

describe.each([
  ["through Multicall3", "multicall3"],
  ["with separate reads", "separate"],
] as const)("a statement whose chain facts are read %s", (_how, reads) => {
  beforeEach(() => {
    if (reads !== "multicall3") redeploy({ reads });
  });

  test("a linked body of a checked, ready company is active, signed by the attestor, and states what the chain holds at its block", async () => {
    const { g, agentId, id, body } = await linkedBody();

    const before = reached.length;
    const res = await byAgent(agentId);
    const during = reached.slice(before);

    expect(res.status).toBe(200);
    expect(res.cache).toBe(FRESH);
    const row = d.legalBodies.findById(id);
    expect(res.body).toMatchObject({
      agentId: agentId.toString(),
      legalBody: true,
      standing: "active",
      publicId: row?.publicId,
      network: "testnet",
      links: { transparency: TRANSPARENCY, statement: `${STATEMENT_BASE}${agentId}` },
    });
    const signed = res.body.statement;
    expect(signed.attestor).toBe(attestor.address);
    expect(await verifies(signed)).toBe(true);
    // Checked against any other key, it does not verify.
    expect(await verifies(signed, stranger.address)).toBe(false);

    // Every chain fact equals a direct read of the chain at the statement's block, and that block
    // is at most the head (read uncached: viem keeps a block number for a few seconds).
    const m = signed.message;
    const head = await pub.getBlock({ blockTag: "latest" });
    expect(BigInt(m.observedAtBlock)).toBeLessThanOrEqual(head.number);
    const at = BigInt(m.observedAtBlock);
    const linked = await pub.readContract({
      address: stack.factory,
      abi: legalBodyFactoryAbi,
      functionName: "linkedLegalBody",
      args: [agentId],
      blockNumber: at,
    });
    const creator = await pub.readContract({
      address: stack.factory,
      abi: legalBodyFactoryAbi,
      functionName: "identityOwnerAtCreation",
      args: [body],
      blockNumber: at,
    });
    const [, , agreementHash, metaAgentId] = (await pub.readContract({
      address: body,
      abi: legalManagerAbi,
      functionName: "meta",
      blockNumber: at,
    })) as readonly [string, bigint, Hex, bigint];
    const wallet = await pub.readContract({
      address: stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "getAgentWallet",
      args: [agentId],
      blockNumber: at,
    });
    expect(linked).toBe(body);
    expect(metaAgentId).toBe(agentId);
    expect(creator).toBe(owner.address);
    expect(m).toMatchObject({
      chainId: String(anvilChain.id),
      identityRegistry: stack.registry,
      factory: stack.factory,
      legalBody: linked,
      agentId: metaAgentId.toString(),
      agentWallet: wallet,
      identityOwnerAtCreation: creator,
      oaManifestHash: agreementHash.toLowerCase(),
    });
    expect(m.oaManifestHash).toBe(row?.oaManifestHash?.toLowerCase());

    // What the deployment recorded: the passed check, the declared names, the verified guardian,
    // and no annual report due yet.
    const check = d.h.checks.latest(g.companyId);
    expect(m).toMatchObject({
      bindingState: "linked",
      identityOwnerIsContract: false,
      agentWalletIsContract: false,
      standing: "active",
      attestationState: "active",
      jurisdiction: "WY",
      entityType: "LLC",
      legalName: COMPANY_NAME,
      filingNumber: g.filingNumber,
      source: "customer",
      environment: "sandbox",
      controlVerified: true,
      existenceCheckedAt: String(check?.checkedAt),
      filedAt: check?.formationDate,
      einIssued: false,
      filingStatus: "not_yet_due",
      lastFiledPeriod: "0",
      nextDue: firstDueOf(check?.formationDate ?? ""),
      oaManifestVersion: "1",
      guardianHumanVerified: true,
    });

    // The snapshot: one eth_call, to Multicall3, or one per fact without it, none of them to
    // Multicall3. Around it, one head read and one code read (the wallet is the creator).
    const toMulticall3 = during.filter(
      (r) => r.method === "eth_call" && r.to === MULTICALL3_ADDRESS.toLowerCase(),
    );
    if (reads === "multicall3") {
      expect(byMethod(during)).toEqual({ eth_getBlockByNumber: 1, eth_call: 1, eth_getCode: 1 });
      expect(toMulticall3).toHaveLength(1);
    } else {
      // linkedLegalBody and getAgentWallet; the body's creator, status() and meta().
      expect(byMethod(during)).toEqual({ eth_getBlockByNumber: 1, eth_call: 5, eth_getCode: 1 });
      expect(toMulticall3).toHaveLength(0);
    }
  });

  test("two answers inside 15 seconds carry the same signature and add one log row; the same claims later add none; a change of claims adds a second", async () => {
    const { agentId, id } = await linkedBody();

    const first = await byAgent(agentId);
    const second = await byAgent(agentId);
    expect(first.body.standing).toBe("active");
    expect(second.body).toEqual(first.body);
    expect(second.body.statement.signature).toBe(first.body.statement.signature);
    expect(logRows()).toBe(1);

    // Past the memo: a statement issued again, signed again, with the same claims: no new row.
    await pastMemo();
    const third = await byAgent(agentId);
    expect(third.body.statement.message.issuedAt).not.toBe(first.body.statement.message.issuedAt);
    expect(third.body.statement.signature).not.toBe(first.body.statement.signature);
    expect(await verifies(third.body.statement)).toBe(true);
    expect(logRows()).toBe(1);

    // A revocation changes the claims: a second row.
    revokeLegalBody(id);
    await pastMemo();
    const fourth = await byAgent(agentId);
    expect(fourth.body.standing).toBe("inactive");
    expect(logRows()).toBe(2);
    expect(d.statementLog.latest(id)).toMatchObject({
      agentId: agentId.toString(),
      agentWallet: owner.address,
      attestor: attestor.address,
      standing: "inactive",
      observedAtBlock: Number(fourth.body.statement.message.observedAtBlock),
    });
  });
});

test("by address: the owner's address, the identity's wallet, finds the same agent with its public id; an address nothing knows is no legal body", async () => {
  const { agentId, id, body } = await linkedBody();

  const res = await byAddress(owner.address);
  expect(res.status).toBe(200);
  expect(res.cache).toBe(FRESH);
  expect(res.body).toMatchObject({
    address: owner.address,
    legalBody: true,
    standing: "active",
    agentId: agentId.toString(),
    publicId: d.legalBodies.findById(id)?.publicId,
    name: COMPANY_NAME,
    network: "testnet",
    links: {
      transparency: TRANSPARENCY,
      metadata: null,
      statement: `${STATEMENT_BASE}${agentId}`,
    },
    formation: null,
  });
  expect(typeof res.body.publicId).toBe("string");
  expect(res.body.statement.message).toMatchObject({
    legalBody: body,
    agentId: agentId.toString(),
    agentWallet: owner.address,
    standing: "active",
  });
  expect(await verifies(res.body.statement)).toBe(true);

  const unknown = await byAddress(stranger.address);
  expect(unknown.status).toBe(200);
  expect(unknown.body).toEqual({
    address: stranger.address,
    legalBody: false,
    standing: null,
    checkedAt: expect.any(String),
  });
});

test("a second wallet set on the identity: no legal body by its address until, past both memos, a by-agent answer has logged it; then it finds the agent", async () => {
  const { agentId, id } = await linkedBody();
  const first = await byAgent(agentId);
  expect(first.body.statement.message.agentWallet).toBe(owner.address);

  await setAgentWallet(d.h, owner, agentId, secondWallet);
  await expect(
    pub.readContract({
      address: stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "getAgentWallet",
      args: [agentId],
    }),
  ).resolves.toBe(secondWallet.address);

  // No by-agent answer since: nothing recorded names the new wallet.
  const before = await byAddress(secondWallet.address);
  expect(before.body).toMatchObject({
    address: secondWallet.address,
    legalBody: false,
    standing: null,
  });

  // Past both memos, one by-agent answer states the new wallet and logs it.
  await pastMemo();
  const seen = await byAgent(agentId);
  expect(seen.body.statement.message.agentWallet).toBe(secondWallet.address);
  expect(d.statementLog.latest(id)?.agentWallet).toBe(secondWallet.address);

  const found = await byAddress(secondWallet.address);
  expect(found.body).toMatchObject({
    address: secondWallet.address,
    legalBody: true,
    standing: "active",
    agentId: agentId.toString(),
  });
  expect(found.body.statement.message.agentWallet).toBe(secondWallet.address);
  expect(await verifies(found.body.statement)).toBe(true);

  // The owner's address is still the identity owner on record, and no longer the wallet the
  // chain returns: the record alone is not believed.
  const formerWallet = await byAddress(owner.address);
  expect(formerWallet.body).toMatchObject({ legalBody: false, standing: null });
});

test("legal-body:revoke: once the memo has expired, the statement is inactive and revoked, with no names", async () => {
  const { agentId, id } = await linkedBody();
  expect((await byAgent(agentId)).body.standing).toBe("active");

  revokeLegalBody(id);
  // Inside the memo, the answer already given stands.
  expect((await byAgent(agentId)).body.standing).toBe("active");

  await pastMemo();
  const res = await byAgent(agentId);
  expect(res.cache).toBe(FRESH);
  expect(res.body).toMatchObject({ legalBody: true, standing: "inactive" });
  expect(res.body.statement.message).toMatchObject({
    bindingState: "linked",
    standing: "inactive",
    attestationState: "revoked",
    legalName: "",
    filingNumber: "",
  });
  expect(await verifies(res.body.statement)).toBe(true);
});

test("company:revoke makes the statement inactive; company:reinstate makes it pending until a new check passes", async () => {
  const { g, agentId } = await linkedBody();

  companyStateCheck(g.companyId, "revoked");
  const revoked = await byAgent(agentId);
  expect(revoked.body.statement.message).toMatchObject({
    standing: "inactive",
    attestationState: "revoked",
    legalName: "",
    filingNumber: "",
  });

  companyStateCheck(g.companyId, "reinstated");
  await pastMemo();
  const reinstated = await byAgent(agentId);
  expect(reinstated.body.statement.message).toMatchObject({
    bindingState: "linked",
    standing: "pending",
    attestationState: "pending",
    controlVerified: false,
    existenceCheckedAt: "0",
    legalName: "",
    filingNumber: "",
  });
  expect(await verifies(reinstated.body.statement)).toBe(true);
});

test("the owner clears the pointer: the body it linked is stated broken and inactive, with no names", async () => {
  const { agentId, body } = await linkedBody();

  await setPointer(d.h, owner, agentId, "0x");
  const res = await byAgent(agentId);
  expect(res.body).toMatchObject({ legalBody: true, standing: "inactive" });
  expect(res.body.statement.message).toMatchObject({
    legalBody: body,
    bindingState: "broken",
    standing: "inactive",
    attestationState: "active",
    legalName: "",
    filingNumber: "",
  });
  expect(await verifies(res.body.statement)).toBe(true);
});

test("the guardian starts a dissolution: the factory no longer returns the body, the database finds it, and it is stated inactive", async () => {
  const { g, agentId, body } = await linkedBody();

  // A guardian key starts with no gas.
  await node.setBalance({ address: g.address, value: parseEther("1") });
  await asGuardian(d.h, g, body, "initiateDissolution");
  await expect(
    pub.readContract({
      address: stack.factory,
      abi: legalBodyFactoryAbi,
      functionName: "linkedLegalBody",
      args: [agentId],
    }),
  ).resolves.toBe(zeroAddress);

  const res = await byAgent(agentId);
  expect(res.body).toMatchObject({ legalBody: true, standing: "inactive" });
  expect(res.body.statement.message).toMatchObject({
    legalBody: body,
    bindingState: "broken",
    standing: "inactive",
    legalName: "",
  });
  expect(await verifies(res.body.statement)).toBe(true);
});

test("the identity is transferred: inactive; the test registry keeps the wallet, so the owner's address still finds the body, inactive", async () => {
  const { agentId, body } = await linkedBody();

  await transferIdentity(d.h, owner, buyer.address, agentId);
  await expect(
    pub.readContract({
      address: stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    }),
  ).resolves.toBe(buyer.address);

  const res = await byAgent(agentId);
  expect(res.body).toMatchObject({ legalBody: true, standing: "inactive" });
  expect(res.body.statement.message).toMatchObject({
    legalBody: body,
    bindingState: "broken",
    standing: "inactive",
    identityOwnerAtCreation: owner.address,
    agentWallet: owner.address,
    legalName: "",
  });

  // The live registry clears the wallet on a transfer; the test registry keeps it, so the former
  // owner's address is still the agent's wallet and still names the body.
  const byFormerOwner = await byAddress(owner.address);
  expect(byFormerOwner.body).toMatchObject({
    address: owner.address,
    legalBody: true,
    standing: "inactive",
    agentId: agentId.toString(),
    name: "",
  });
  expect(await verifies(byFormerOwner.body.statement)).toBe(true);
});

test("a node that answers 429: unknown, unsigned and not stored, with no memo entry and no log row; the next request once it recovers is active", async () => {
  const { agentId } = await linkedBody();

  throttle.on = true;
  const linesBefore = printed.length;
  const res = await byAgent(agentId);
  throttle.on = false;

  expect(res.status).toBe(200);
  expect(res.cache).toBe(NO_STORE);
  expect(res.body).toEqual({
    agentId: agentId.toString(),
    legalBody: true,
    standing: "unknown",
    publicId: null,
    network: "testnet",
    links: { transparency: TRANSPARENCY },
    checkedAt: expect.any(String),
    statement: null,
  });
  expect(logRows()).toBe(0);
  expect(opsLines("legal_body_statement_unavailable")).toEqual([
    expect.objectContaining({ stage: "snapshot", errorName: expect.any(String) }),
  ]);
  // Neither the answer nor a line printed for it holds the node's address.
  for (const text of [res.text, ...printed.slice(linesBefore)])
    for (const part of [rpcUrl, "127.0.0.1", `:${PORT}`]) expect(text).not.toContain(part);

  // Nothing was remembered: the very next request reads the chain again.
  const next = await byAgent(agentId);
  expect(next.cache).toBe(FRESH);
  expect(next.body.standing).toBe("active");
  expect(await verifies(next.body.statement)).toBe(true);
  expect(logRows()).toBe(1);
});

test("activation once paid: on a deployment that charges, the company waits as a draft and the statement is pending; once the payment settles it, active after the memo", async () => {
  redeploy({ charging: true });
  const { g, agentId } = await linkedBody();
  expect(d.companies.find(g.companyId)?.status).toBe("draft");

  const unpaid = await byAgent(agentId);
  expect(unpaid.body.statement.message).toMatchObject({
    bindingState: "linked",
    standing: "pending",
    attestationState: "pending",
    controlVerified: true,
  });
  expect(await verifies(unpaid.body.statement)).toBe(true);

  // As the settlement of the payment does.
  expect(d.companies.setStatus(g.companyId, "draft", "ready")).toBe(true);
  expect((await byAgent(agentId)).body.standing).toBe("pending");

  await pastMemo();
  const paid = await byAgent(agentId);
  expect(paid.body.statement.message).toMatchObject({
    standing: "active",
    attestationState: "active",
  });
  expect(await verifies(paid.body.statement)).toBe(true);
});

test("filing facts: a report about four months past due with none recorded is unknown, past grace; a later check recording that year's report makes it active", async () => {
  const { formedOn, lastDue, nextDue } = dueAboutFourMonthsAgo();
  const { g, agentId } = await linkedBody({ formationDate: formedOn });

  const late = await byAgent(agentId);
  // A statement, signed and stored like any other: what it states is that Novi cannot say.
  expect(late.cache).toBe(FRESH);
  expect(late.body.standing).toBe("unknown");
  expect(late.body.statement.message).toMatchObject({
    standing: "unknown",
    attestationState: "active",
    filedAt: formedOn,
    filingStatus: "past_due_unverified",
    lastFiledPeriod: "0",
    lastFiledAt: "",
    lastFiledConfirmedBy: "",
    nextDue,
  });
  expect(await verifies(late.body.statement)).toBe(true);

  const period = Number(lastDue.slice(0, 4));
  const filedOn = addDays(lastDue, -20);
  recordPassedCheck(d.h, g.companyId, g.filingNumber, {
    formationDate: formedOn,
    lastReportPeriod: period,
    lastReportFiledOn: filedOn,
  });
  await pastMemo();
  const filed = await byAgent(agentId);
  expect(filed.body.statement.message).toMatchObject({
    standing: "active",
    filedAt: formedOn,
    filingStatus: "filed",
    lastFiledPeriod: String(period),
    lastFiledAt: filedOn,
    lastFiledConfirmedBy: "operator",
    nextDue,
  });
  expect(await verifies(filed.body.statement)).toBe(true);
});

test("/transparency lists the active body, with what its statement states and no guardian; after legal-body:revoke it no longer does", async () => {
  const { g, agentId, id, body } = await linkedBody();
  const row = d.legalBodies.findById(id);

  const listed = await ask("/transparency");
  expect(listed.status).toBe(200);
  expect(listed.body.legalBodiesAvailable).toBe(true);
  expect(listed.body.stats).toEqual({
    entities: 0,
    jobsSettled: 0,
    usdcSettledAtomic: "0",
    legalBodies: 1,
  });
  expect(listed.body.legalBodies).toEqual([
    {
      agentId: agentId.toString(),
      publicId: row?.publicId,
      legalBody: body,
      chainId: anvilChain.id,
      legalName: COMPANY_NAME,
      filingNumber: g.filingNumber,
      jurisdiction: "WY",
      entityType: "LLC",
      source: "customer",
      environment: "sandbox",
      standing: "active",
      linkedSince: new Date((row?.pointerSeenAt ?? 0) * 1_000).toISOString(),
      links: { statement: `${STATEMENT_BASE}${agentId}` },
    },
  ]);
  expect(listed.text.toLowerCase()).not.toContain(g.address.slice(2).toLowerCase());

  revokeLegalBody(id);
  await moveTime(PAST_TRANSPARENCY_CACHE_SECONDS);
  const after = await ask("/transparency");
  expect(after.body.legalBodiesAvailable).toBe(true);
  expect(after.body.legalBodies).toEqual([]);
  expect(after.body.stats.legalBodies).toBe(0);
});
