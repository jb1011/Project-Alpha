import type Database from "better-sqlite3";
import { type Address, type Hex, getAddress, keccak256, toHex } from "viem";
import { vi } from "vitest";
import type { LegalBodyChainPort } from "../../src/adapters/arc/legalBodyChain";
import { signSession } from "../../src/auth/session";
import type { LinkChainPort } from "../../src/legalBody/checkLink";
import { CUSTOMER_COMPANY_PLACEHOLDER } from "../../src/legalBody/customerCompany";
import {
  type LegalBodyLink,
  buildLinkTypedData,
  linkTypedDataWire,
  offChainLinkDigest,
} from "../../src/legalBody/link";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { CUSTOMER_PROVIDER } from "../../src/legalBody/provider";
import {
  type CompanyCheckRepository,
  type CompanyCheckResult,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import {
  type CompanyDeclarationRepository,
  SqliteCompanyDeclarationRepository,
} from "../../src/persistence/companyDeclarationRepository";
import {
  type CompanyRepository,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import {
  type LegalBodyRecord,
  SqliteLegalBodyRepository,
} from "../../src/persistence/legalBodyRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  type Signer,
  worldFor,
} from "./customerCompanyFixtures";
import { MemoryDocumentStore } from "./formationFakes";

/**
 * The fixtures every test of the legal-body order doors shares: the stores over one test database,
 * the doors' dependencies on a sandbox deployment, a customer company its operator checked, a
 * chain on which a link is valid, a signed link, and the pieces of a request to the API.
 *
 * Every key is one of anvil's published test accounts, never a real wallet, and every name,
 * company and filing number is an invention.
 */

/** Placeholders: the identity registry the agreement names, a factory of another deployment, and
 *  a body address. */
export const REGISTRY = getAddress("0x0000000000000000000000000000000000008004");
export const OTHER_FACTORY = getAddress("0x00000000000000000000000000000000000fac71");
export const BODY = getAddress("0x00000000000000000000000000000000000b0d1e");
export const DAY_MS = 24 * 60 * 60 * 1000;
/** A 32-byte hash made of one repeated hex digit. */
export const H = (c: string) => `0x${c.repeat(64)}` as Hex;

/** The stores the order doors read and write, over one test database. */
export interface LegalBodyStores {
  db: Database.Database;
  companies: SqliteCompanyRepository;
  declarations: SqliteCompanyDeclarationRepository;
  checks: SqliteCompanyCheckRepository;
  store: SqliteWorldStore;
  repo: SqliteLegalBodyRepository;
  docStore: MemoryDocumentStore;
}

export function openLegalBodyStores(
  db: Database.Database,
  docStore = new MemoryDocumentStore(),
): LegalBodyStores {
  return {
    db,
    companies: new SqliteCompanyRepository(db),
    declarations: new SqliteCompanyDeclarationRepository(db),
    checks: new SqliteCompanyCheckRepository(db),
    store: new SqliteWorldStore(db),
    repo: new SqliteLegalBodyRepository(db),
    docStore,
  };
}

/** A chain port every member of which throws: for doors that never read the chain. */
export const noChain = new Proxy({} as LegalBodyChainPort, {
  get: (_target, member) => {
    throw new Error(`the chain was asked for ${String(member)}`);
  },
});

/** The order deps of a sandbox deployment (the agreement's wording is a draft, which only a
 *  sandbox serves), with room in every throttle. The chain is whatever `over` gives. */
export function legalBodyOrderDeps(
  s: LegalBodyStores,
  over: Partial<LegalBodyOrderDeps> = {},
): LegalBodyOrderDeps {
  return {
    repo: s.repo,
    companies: s.companies,
    declarations: s.declarations,
    checks: s.checks,
    world: worldFor(s.store),
    chain: noChain,
    docStore: s.docStore,
    deployment: { chainId: CHAIN_ID, factory: FACTORY },
    identityRegistry: REGISTRY,
    environment: "sandbox",
    amendmentDelaySeconds: 172_800,
    maxOpenPerTenant: 3,
    maxOrdersPerTenantPerDay: 10,
    maxCreatesPerTenantPerDay: 5,
    maxCreatesPerDay: 100,
    doorBudget: { take: () => true },
    tenantBucket: () => ({ take: () => true }),
    identityBucket: () => ({ take: () => true }),
    transaction: (fn) => s.repo.transaction(fn),
    ...over,
  };
}

/** Appends a check with this result, as the operator records one. */
export function appendCheck(
  checks: CompanyCheckRepository,
  companyId: string,
  result: CompanyCheckResult,
): void {
  const common = {
    companyId,
    result,
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: Math.floor(Date.now() / 1000),
  };
  checks.append(
    result === "passed"
      ? {
          ...common,
          registryName: "Example Holdings LLC",
          registryFilingId: "TEST-0001",
          registryStatus: "Active",
          formationDate: "2024-02-29",
          registeredAgent: "Example Registered Agent LLC",
          existenceEvidenceSha256: `0x${"e1".repeat(32)}`,
          controlEvidenceSha256: `0x${"c1".repeat(32)}`,
          controlEvidenceKind: "ein_letter",
          reasonCode: null,
          reason: null,
        }
      : {
          ...common,
          registryName: null,
          registryFilingId: null,
          registryStatus: null,
          formationDate: null,
          registeredAgent: null,
          existenceEvidenceSha256: null,
          controlEvidenceSha256: null,
          controlEvidenceKind: null,
          reasonCode: result === "failed" ? "filing_not_found" : null,
          reason: "Recorded for a test.",
        },
  );
}

/**
 * A company of `owner`, with the checks given (one pass unless told otherwise). A customer company
 * carries its declaration, written straight to its table: the statement and its signature are
 * placeholders, since only the company's name and filing number are read by the order doors.
 */
export function customerCompany(
  s: {
    companies: CompanyRepository;
    declarations: CompanyDeclarationRepository;
    checks: CompanyCheckRepository;
  },
  owner: Address,
  opts: {
    checks?: CompanyCheckResult[];
    companyName?: string;
    filingNumber?: string;
    provider?: string;
    status?: "draft" | "ready";
    humanNullifier?: string;
  } = {},
): string {
  const provider = opts.provider ?? CUSTOMER_PROVIDER;
  const companyName = opts.companyName ?? "Example Holdings LLC";
  const filingNumber = opts.filingNumber ?? "TEST-0001";
  const companyId = s.companies.create({
    tenantId: owner,
    status: opts.status ?? "ready",
    provider,
    environment: "sandbox",
    synthetic: true,
    nameOptions: [{ name: companyName, entityTypeEnding: "", position: 1 }],
    businessPurpose: CUSTOMER_COMPANY_PLACEHOLDER,
    industryLabel: CUSTOMER_COMPANY_PLACEHOLDER,
    intakeSynthesized: false,
  });
  if (provider === CUSTOMER_PROVIDER)
    s.declarations.insert({
      companyId,
      tenantId: owner,
      humanNullifier: opts.humanNullifier ?? `nullifier-${companyId}`,
      declarantName: "Novi Sandbox Declarant",
      declarantTitle: "Manager",
      statementText: "An invented statement, written for a test.",
      statementHash: keccak256(toHex(`statement:${companyId}`)),
      statementDigest: keccak256(toHex(`digest:${companyId}`)),
      signature: "0x01",
      companyName,
      jurisdiction: "WY",
      filingNumber,
      wordingVersion: "2026-10-draft-1",
      chainId: CHAIN_ID,
      factory: FACTORY,
      issuedAt: Math.floor(Date.now() / 1000),
      synthetic: true,
    });
  for (const result of opts.checks ?? ["passed"]) appendCheck(s.checks, companyId, result);
  return companyId;
}

/** A transport failure as a node client throws one: a numeric status and the node's URL. */
export class TransportFailure extends Error {
  readonly status = 429;
  constructor() {
    super("HTTP request failed. URL: https://rpc.example/v2/key-in-path Status: 429");
    this.name = "HttpRequestError";
  }
}

// ── A chain on which a link is valid ────────────────────────────────────────────────────────

/** The identity owner of every fake chain unless told otherwise: anvil's published account #4. */
export const IDENTITY_OWNER = ANVIL_ACCOUNT_4;
/** The head a fake chain reads: its number pins the reads, its timestamp is chain time. */
export const LINK_HEAD = { number: 7_777n, timestamp: 1_800_000_000n };
/** The gas limit a fake chain's simulation answers. */
export const LINK_GAS_LIMIT = 362_500n;

/** The members of a fake chain the link door reads, each a mock a test can steer. */
export function fakeLinkChainMembers() {
  return {
    chainId: CHAIN_ID,
    factory: FACTORY,
    head: vi.fn<LinkChainPort["head"]>(async () => LINK_HEAD),
    identityOwner: vi.fn<LinkChainPort["identityOwner"]>(async () => IDENTITY_OWNER.address),
    hasCode: vi.fn<LinkChainPort["hasCode"]>(async () => false),
    linkDigest: vi.fn<LinkChainPort["linkDigest"]>(async (l) =>
      offChainLinkDigest({ chainId: CHAIN_ID, factory: FACTORY, link: l }),
    ),
    // One body per digest, as the factory derives it: two links that differ in anything (their
    // deadline included) predict two bodies.
    predictLegalBody: vi.fn<LinkChainPort["predictLegalBody"]>(async (digest) =>
      getAddress(`0x${digest.slice(-40)}`),
    ),
    bodyCreator: vi.fn<LinkChainPort["bodyCreator"]>(async () => undefined),
    estimateCreate: vi.fn<LinkChainPort["estimateCreate"]>(async () => LINK_GAS_LIMIT),
  } satisfies LinkChainPort;
}
export type FakeLinkChainMembers = ReturnType<typeof fakeLinkChainMembers>;

/** The members above as the doors' chain port. Any other member throws when it is read, so a door
 *  that reaches past the link's reads fails loudly. */
export function asChainPort(members: FakeLinkChainMembers): LegalBodyChainPort {
  return new Proxy(members, {
    get: (target, member) => {
      if (typeof member !== "string" || member === "then") return undefined;
      if (Object.hasOwn(target, member)) return target[member as keyof FakeLinkChainMembers];
      throw new Error(`the chain was asked for ${member}`);
    },
  }) as unknown as LegalBodyChainPort;
}

/** The link an order's draft is linked with: its agreement, its delay, its guardian. */
export function linkFor(
  row: LegalBodyRecord,
  p: { agentId?: bigint; deadline?: bigint } = {},
): LegalBodyLink {
  if (row.oaManifestHash === null) throw new Error(`order ${row.legalBodyId} has no agreement`);
  return {
    agentId: p.agentId ?? 42n,
    guardian: row.guardian,
    amendmentDelay: BigInt(row.amendmentDelay),
    operatingAgreementHash: row.oaManifestHash,
    deadline: p.deadline ?? LINK_HEAD.timestamp + 3_600n,
  };
}

/** The link's wire message and the identity owner's signature of it. */
export async function signedLink(
  link: LegalBodyLink,
  signer: Signer = IDENTITY_OWNER,
): Promise<{ message: Record<string, string>; signature: Hex }> {
  const p = { chainId: CHAIN_ID, factory: FACTORY, link };
  return {
    message: linkTypedDataWire(p).message,
    signature: (await signer.signTypedData(buildLinkTypedData(p))) as Hex,
  };
}

// ── A request to the API ────────────────────────────────────────────────────────────────────

export const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";

export async function sessionOf(who: Signer): Promise<string> {
  const { token } = await signSession(who.address, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

/** What `call` needs of an app: Hono's `request`. */
export interface RequestTarget {
  request(path: string, init: RequestInit): Response | Promise<Response>;
}

export async function call(
  app: RequestTarget,
  method: "GET" | "POST",
  path: string,
  token: string | undefined,
  body?: string | object,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: a JSON answer, read field by field
export type Json = any;

/** The answer's status and JSON body, and its raw text, to show what it does not carry. */
export async function answerOf(
  res: Response,
): Promise<{ status: number; body: Json; text: string }> {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
