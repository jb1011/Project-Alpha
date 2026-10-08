import { type Address, type Hex, getAddress, keccak256, toHex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  BodySnapshot,
  CodeKind,
  SnapshotRequest,
  StatementChainPort,
  StatementSnapshot,
} from "../../src/adapters/arc/legalBodyChain";
import type { LegalBodyStatementDeps } from "../../src/legalBody/statements";
import type { NewCompanyCheck } from "../../src/persistence/companyCheckRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqliteLegalBodyStatementRepository } from "../../src/persistence/legalBodyStatementRepository";
import {
  ACTION,
  ANVIL_ACCOUNT_2,
  CHAIN_ID,
  FACTORY,
  recordHuman,
  worldFor,
} from "./customerCompanyFixtures";
import {
  type LegalBodyStores,
  REGISTRY,
  customerCompany,
  openLegalBodyStores,
} from "./legalBodyFixtures";

/**
 * The fixtures every test of the public legal-body statement shares: the stores over one test
 * database, the statement log among them; a fixed clock; a customer company with a verified human
 * and no check; an operator's passed check whose formation date and last annual report the test
 * chooses; a legal-body row brought into a public state through the repository's own moves; a fake
 * chain that answers one block's facts from tables a test edits; and the statement service's
 * dependencies over all of them.
 *
 * THE CLOCK IS FIXED. The shared `customerCompany()` records a passed check formed on 2024-02-29,
 * whose annual reports are past due beyond grace on any day after 2026-04-02, the real clock's
 * included: a statement over it reads `unknown`. A test here appends a check of its own, dated
 * against `CLOCK_MS`.
 *
 * Every key is one of anvil's published test accounts, never a real wallet; every other address is
 * a placeholder; every name, company and filing number is an invention.
 */

/** 2026-10-07T18:00:00Z, noon in Wyoming (UTC-6 in October): the statement service's clock. */
export const CLOCK_MS = Date.parse("2026-10-07T18:00:00.000Z");
/** The same instant in unix seconds: the `issuedAt` of a statement made on the clock. */
export const CLOCK_S = CLOCK_MS / 1000;

/** anvil's published account 0: the test attestor, which signs every statement here. */
export const TEST_ATTESTOR = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
/** The guardian of every company and body here, unless told otherwise: anvil's account 2. */
export const TENANT: Address = ANVIL_ACCOUNT_2.address;
/** The identity owner every row records, unless told otherwise: a placeholder. */
export const OWNER: Address = getAddress("0x00000000000000000000000000000000000a0001");
/** The operating agreement every row freezes, unless told otherwise. */
export const OA_HASH: Hex = `0x${"ab".repeat(32)}`;
/** The head the fake chain reads at: ten seconds before the clock. */
export const SNAPSHOT_HEAD = { number: 4_242n, timestamp: BigInt(CLOCK_S - 10) };
/** The formation date of a passed check unless told otherwise: the first report is due on
 *  2027-01-01, so nothing is due on the clock's day. */
export const FORMED_ON = "2026-01-15";

/** The stores the statement service reads, the statement log among them, over one database. */
export interface StatementStores extends LegalBodyStores {
  statements: SqliteLegalBodyStatementRepository;
}

/** The stores over a new, migrated in-memory database. */
export function openStatementStores(): StatementStores {
  const db = openDatabase(":memory:");
  migrate(db);
  return { ...openLegalBodyStores(db), statements: new SqliteLegalBodyStatementRepository(db) };
}

/**
 * A customer company of the tenant, `ready` unless told otherwise, with no check: the test appends
 * the one it needs. The tenant's World ID verification is recorded with it (once per tenant),
 * unless `human` is false.
 */
export function readyCompany(
  s: LegalBodyStores,
  o: { status?: "draft" | "ready"; tenant?: Address; human?: boolean } = {},
): string {
  const tenant = o.tenant ?? TENANT;
  const companyId = customerCompany(s, tenant, { checks: [], status: o.status ?? "ready" });
  if (o.human !== false && s.store.findByTenant(tenant, ACTION) === undefined)
    recordHuman(s.store, tenant, `nullifier-${tenant.toLowerCase()}`, CLOCK_MS - 60_000);
  return companyId;
}

/**
 * An operator's passed check of the company, to append: made an hour before the clock, formed on
 * FORMED_ON unless told otherwise, with the last annual report the registry showed when one is
 * given. The registry fields are inventions.
 */
export function passedCheck(
  companyId: string,
  o: {
    formationDate?: string;
    lastReport?: { period: number; filedOn?: string };
    checkedAt?: number;
  } = {},
): NewCompanyCheck {
  return {
    companyId,
    result: "passed",
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: o.checkedAt ?? CLOCK_S - 3_600,
    registryName: "Example Holdings LLC",
    registryFilingId: "TEST-0001",
    registryStatus: "Active",
    formationDate: o.formationDate ?? FORMED_ON,
    registeredAgent: "Example Registered Agent LLC",
    existenceEvidenceSha256: `0x${"e1".repeat(32)}`,
    controlEvidenceSha256: `0x${"c1".repeat(32)}`,
    controlEvidenceKind: "ein_letter",
    reasonCode: null,
    reason: null,
    lastReportPeriod: o.lastReport?.period ?? null,
    lastReportFiledOn: o.lastReport?.filedOn ?? null,
  };
}

/** The four states a public answer can be about. */
export type PublicRowState = "deployed" | "linked" | "broken" | "superseded";

/** The body address of the n-th row made here: a placeholder. */
export const bodyAddressOf = (n: number): Address =>
  getAddress(`0x${(0xb0d1e000 + n).toString(16).padStart(40, "0")}`);

/** Rows made by this module, so each gets its own body, digest and sighting time. */
let made = 0;

/**
 * A legal-body row of the company, for agent 42 unless told otherwise, brought into `state` through
 * the repository's own moves: create, freezeAgreement, reserve, markDeployed, then markLinked, and
 * from there markBroken or supersede.
 *
 * - `linked`, `broken` and `superseded` rows are linked first, at `seenAt` (unix seconds, later for
 *   each row made, so the row made last is the most recent linked stretch); linking a row breaks
 *   the row linked before it for the same agent, as the repository does.
 * - a `superseded` row with `seenAt: null` was set aside from `deployed`, never linked.
 * - a `deployed` row was never linked; at most one per agent can be on its way at a time, so make
 *   it the agent's last row.
 */
export function bodyIn(
  state: PublicRowState,
  s: LegalBodyStores,
  companyId: string,
  o: {
    agentId?: string;
    owner?: Address;
    body?: Address;
    seenAt?: number | null;
    tenant?: Address;
    oaHash?: Hex;
    factory?: Address;
  } = {},
): LegalBodyRecord {
  made += 1;
  const n = made;
  const legalBodyId = s.repo.create({
    tenantId: o.tenant ?? TENANT,
    companyId,
    chainId: CHAIN_ID,
    factory: o.factory ?? FACTORY,
    amendmentDelay: 172_800,
  }).legalBodyId;
  const moved = (ok: boolean, move: string) => {
    if (!ok) throw new Error(`bodyIn: ${move} was not made for row ${n}`);
  };
  moved(s.repo.freezeAgreement(legalBodyId, { hash: o.oaHash ?? OA_HASH, version: 1 }), "freeze");
  const reserved = s.repo.reserve(legalBodyId, {
    agentId: o.agentId ?? "42",
    identityOwner: o.owner ?? OWNER,
    linkDigest: keccak256(toHex(`link:${n}`)),
    linkDeadline: 1_900_000_000,
    linkSignature: "0x01",
    bodyAddress: o.body ?? bodyAddressOf(n),
    observedAtBlock: 1,
    firstCheckAt: CLOCK_MS,
  });
  moved(reserved === "reserved", `reserve (${reserved})`);
  moved(
    s.repo.markDeployed(legalBodyId, {
      txHash: keccak256(toHex(`create:${n}`)),
      deployedAt: 1_790_000_000 + n,
    }),
    "markDeployed",
  );
  if (state === "superseded" && o.seenAt === null)
    moved(s.repo.supersede(legalBodyId, "lb_replacement"), "supersede");
  else if (state !== "deployed") {
    const seenAt = o.seenAt ?? 1_791_000_000 + n * 100;
    moved(s.repo.markLinked(legalBodyId, seenAt).outcome === "linked", "markLinked");
    if (state === "broken" || state === "superseded")
      moved(s.repo.markBroken(legalBodyId, { reason: "not_linked" }), "markBroken");
    if (state === "superseded") moved(s.repo.supersede(legalBodyId, "lb_replacement"), "supersede");
  }
  const row = s.repo.findById(legalBodyId);
  if (row?.bindingState !== state) throw new Error(`bodyIn: row ${n} is not ${state}`);
  return row;
}

// ── A fake chain of statement snapshots ─────────────────────────────────────────────────────

/** One body as the chain holds it. */
export type FakeBody = Omit<BodySnapshot, "body">;

/**
 * A chain that answers statement snapshots and code reads from tables a test edits, and records
 * every read. Like the real one, it answers every requested agent and body in the request's order,
 * at the head's block, and a body it does not hold fails the whole snapshot (reading `status()` of
 * an address that holds no body reverts).
 */
export class FakeStatementChain implements StatementChainPort {
  readonly chainId: number = CHAIN_ID;
  readonly factory: Address = FACTORY;
  /** The block every read is at. */
  head = { ...SNAPSHOT_HEAD };
  /** Agent id → the body `linkedLegalBody` names; absent: none. */
  readonly linked = new Map<string, Address>();
  /** Agent id → `getAgentWallet`; absent: the zero address. */
  readonly wallets = new Map<string, Address>();
  /** Lower-case body address → the body. */
  readonly bodies = new Map<string, FakeBody>();
  /** Lower-case address → the code it holds; absent: none. */
  readonly codes = new Map<string, CodeKind>();
  /** Every snapshot asked for, in order. */
  readonly snapshots: SnapshotRequest[][] = [];
  /** Every code read, in order. */
  readonly codeReads: { address: Address; blockNumber: bigint }[] = [];
  /** Runs before snapshot `n` (counted from 1) is answered: it may move the chain, or throw to
   *  fail the read. */
  beforeSnapshot: (n: number) => void = () => {};
  /** Runs before each code read: it may throw to fail the read. */
  beforeCodeRead: (address: Address) => void = () => {};

  async readStatementSnapshot(requests: readonly SnapshotRequest[]): Promise<StatementSnapshot> {
    this.snapshots.push(requests.map((r) => ({ agentId: r.agentId, bodies: [...r.bodies] })));
    this.beforeSnapshot(this.snapshots.length);
    return {
      blockNumber: this.head.number,
      blockTimestamp: this.head.timestamp,
      agents: requests.map((r) => ({
        agentId: r.agentId,
        linked: this.linked.get(r.agentId.toString()),
        agentWallet: this.wallets.get(r.agentId.toString()) ?? zeroAddress,
        bodies: r.bodies.map((body) => {
          const held = this.bodies.get(body.toLowerCase());
          if (held === undefined) throw new Error("execution reverted");
          return { body, ...held };
        }),
      })),
    };
  }

  async codeKind(address: Address, blockNumber: bigint): Promise<CodeKind> {
    this.codeReads.push({ address, blockNumber });
    this.beforeCodeRead(address);
    return this.codes.get(address.toLowerCase()) ?? "none";
  }

  /** The row's body is on chain: created by the row's identity owner, for the row's agent, Active,
   *  under the row's frozen agreement, unless told otherwise. */
  addBody(row: LegalBodyRecord, over: Partial<FakeBody> = {}): void {
    const { bodyAddress, agentId, identityOwner, oaManifestHash } = bodyOf(row);
    this.bodies.set(bodyAddress.toLowerCase(), {
      creator: identityOwner,
      status: "active",
      metaAgentId: BigInt(agentId),
      oaHash: oaManifestHash,
      ...over,
    });
  }

  /** The row's body is on chain (see `addBody`), linked to its agent, and the agent's wallet is
   *  `wallet`: the row's identity owner unless told otherwise. */
  link(row: LegalBodyRecord, o: Partial<FakeBody> & { wallet?: Address } = {}): void {
    const { wallet, ...over } = o;
    const { bodyAddress, agentId, identityOwner } = bodyOf(row);
    this.addBody(row, over);
    this.linked.set(agentId, bodyAddress);
    this.wallets.set(agentId, wallet ?? identityOwner);
  }
}

/** The fields a row holds once it has a body. */
function bodyOf(row: LegalBodyRecord): {
  bodyAddress: Address;
  agentId: string;
  identityOwner: Address;
  oaManifestHash: Hex;
} {
  const { bodyAddress, agentId, identityOwner, oaManifestHash } = row;
  if (bodyAddress === null || agentId === null || identityOwner === null || !oaManifestHash)
    throw new Error("FakeStatementChain: the row has no body yet");
  return { bodyAddress, agentId, identityOwner, oaManifestHash };
}

/** The statement service over these stores and this chain: a sandbox deployment, World ID wired
 *  over the stores' World store, the test attestor, and the fixed clock. */
export function statementDeps(
  s: StatementStores,
  chain: StatementChainPort,
  over: Partial<LegalBodyStatementDeps> = {},
): LegalBodyStatementDeps {
  return {
    repo: s.repo,
    statements: s.statements,
    companies: s.companies,
    checks: s.checks,
    declarations: s.declarations,
    world: worldFor(s.store),
    chain,
    deployment: { chainId: CHAIN_ID, factory: FACTORY },
    identityRegistry: REGISTRY,
    environment: "sandbox",
    signer: TEST_ATTESTOR,
    readBudget: { take: () => true },
    network: "testnet",
    links: {
      transparency: "https://www.example.test/transparency",
      statementBase: "https://api.example.test/legal-bodies/by-agent/",
    },
    now: () => CLOCK_MS,
    ...over,
  };
}
