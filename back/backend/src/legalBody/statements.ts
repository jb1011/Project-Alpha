import {
  type Address,
  type Hex,
  type LocalAccount,
  isAddress,
  isAddressEqual,
  zeroAddress,
} from "viem";
import type {
  AgentSnapshot,
  BodySnapshot,
  CodeKind,
  StatementChainPort,
} from "../adapters/arc/legalBodyChain";
import { type WorldIdDeps, realHumanState } from "../api/routes/worldId";
import { opsLog } from "../observability/opsLog";
import type { CompanyCheckRepository } from "../persistence/companyCheckRepository";
import type { CompanyDeclarationRepository } from "../persistence/companyDeclarationRepository";
import type { CompanyRepository } from "../persistence/companyRepository";
import type {
  BindingState,
  Deployment,
  LegalBodyPublicFinders,
  LegalBodyRecord,
  LegalBodyRepository,
} from "../persistence/legalBodyRepository";
import type {
  LegalBodyStatementRepository,
  StatementEvidence,
} from "../persistence/legalBodyStatementRepository";
import { wyomingDate } from "../util/wyomingCalendar";
import { type Attestation, deriveAttestationState, publicCompanyNames } from "./attestation";
import { type FilingFacts, filingFacts } from "./filings";
import { CUSTOMER_PROVIDER } from "./provider";
import {
  type LegalBodyStatement,
  type SignedStatementJson,
  StatementIntegrityError,
  assembleStatement,
  claimsHash,
  signStatement,
} from "./publicStatement";
import type { Standing } from "./standing";

/**
 * THE STATEMENT SERVICE: what Novi states, signed, about the legal body of an agent, found by the
 * agent's id or by an address, read fresh on every call. The public routes and the transparency
 * list are thin callers of it.
 *
 * NOTHING IS SIGNED THAT WAS NOT OBSERVED. Every chain fact of a statement is read at one block, by
 * one snapshot of the chain port (which believes no stale head), and the code reads are pinned to
 * that block. A chain read or a signature that fails answers `unknown`: nothing is signed and
 * nothing is logged. A database read that fails throws, and the caller answers that it could not
 * check. No failure is ever turned into an answer about the body.
 *
 * ONLY A BODY WITH A PUBLIC ROW IS STATED: a row of this chain and factory, in `deployed`,
 * `linked`, `broken` or `superseded`, that was linked once or that the chain links now. A body the
 * chain links with no such row gets no statement, and an ops line.
 *
 * BY ADDRESS, THE DATABASE IS NEVER BELIEVED ALONE: an address is answered for an agent only when
 * the agent's wallet, read fresh, is that address, and again at the statement's own block.
 *
 * Every list read is bounded, and an agent or an address with no candidate row costs no chain read.
 *
 * Ops lines carry ids, enums and error NAMES only: never a name of a person or a company, a filing
 * number, an address, or an error's text, which can quote any of them.
 */

export interface LegalBodyStatementDeps {
  repo: LegalBodyRepository & LegalBodyPublicFinders;
  statements: LegalBodyStatementRepository;
  companies: CompanyRepository;
  checks: CompanyCheckRepository;
  declarations: CompanyDeclarationRepository;
  world: WorldIdDeps | undefined;
  chain: StatementChainPort;
  deployment: Deployment;
  identityRegistry: Address;
  environment: "sandbox" | "production";
  /** The attestor: the account of the deployment's attestation key, and of no other role. */
  signer: LocalAccount;
  /** The public lookup's shared read budget, the same instance. The routes spend it; this module
   *  does not. */
  readBudget: { take(): boolean };
  network: "testnet" | "mainnet";
  /** `statementBase` ends with "/legal-bodies/by-agent/". */
  links: { transparency: string; statementBase: string };
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

export type StatementOutcome =
  | { kind: "none" }
  | {
      kind: "unknown";
      agentId: string | null;
      stage: "snapshot" | "code" | "sign";
      errorName: string;
    }
  | {
      kind: "statement";
      agentId: string;
      legalBodyId: string;
      publicId: string;
      standing: Standing;
      statement: SignedStatementJson;
    };

/** The stage of a statement that reads the chain, or signs. */
type Stage = "snapshot" | "code" | "sign";

/** The most rows of one agent a statement chooses from: the body on its way, then the latest
 *  linked stretches, the current one first (the order of `listPublicByAgent`). */
const ROWS_PER_AGENT = 4;
/** The most candidate agents an address is checked for. */
const IDS_PER_ADDRESS = 5;
/** The most of them a statement is made for. */
const STATED_PER_ADDRESS = 3;
/** The states of a row a public answer can be about: those in which its body's creation is
 *  recorded (the table's CHECKs). */
const PUBLIC_STATES: readonly BindingState[] = ["deployed", "linked", "broken", "superseded"];

const UINT256_MAX = 2n ** 256n - 1n;
/** A decimal of at most 78 digits, with no sign, no space and no leading zero. */
const CANONICAL_AGENT_ID = /^(0|[1-9][0-9]{0,77})$/;

/** The route's rule and the service's: `^(0|[1-9][0-9]{0,77})$` and at most 2^256 − 1. */
export function isCanonicalAgentId(value: string): boolean {
  return (
    typeof value === "string" && CANONICAL_AGENT_ID.test(value) && BigInt(value) <= UINT256_MAX
  );
}

/** A chain read, or the signature, that failed, with the error behind it as its `cause`: the
 *  statement ends unsigned, as `unknown`. */
class StageFailed extends Error {
  constructor(
    readonly stage: Stage,
    cause: unknown,
  ) {
    super(`legal-body statement: the ${stage} stage failed`, { cause });
    this.name = "StageFailed";
  }
}

/** A row no statement is made about: the chain disagrees with it, or it is not one this
 *  deployment states. The statement ends unsigned, as `none`. `problem` is a code, never a value. */
class RowRefused extends Error {
  constructor(
    readonly legalBodyId: string,
    readonly problem: string,
  ) {
    super(`legal-body statement refused: ${problem}`);
    this.name = "RowRefused";
  }
}

/** A snapshot that does not hold exactly the agent and the bodies asked for: a failed read. */
class IncompleteSnapshotError extends Error {
  constructor() {
    super("the statement snapshot does not hold the agent and the bodies asked for");
    this.name = "IncompleteSnapshotError";
  }
}

/** `run`, any failure of it a failure of `stage`. */
async function attempt<T>(stage: Stage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new StageFailed(stage, e);
  }
}

/** The one thing of an error an ops line or an answer carries: its message can quote a node's URL,
 *  a key inside it, or an address. */
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : "not_an_error");

function unavailable(agentId: string | null, stage: Stage, failure: unknown): StatementOutcome {
  const errorName = nameOf(failure);
  opsLog("legal_body_statement_unavailable", { stage, errorName });
  return { kind: "unknown", agentId, stage, errorName };
}

/** A row in a public state, with the fields the table's CHECKs require there. */
type PublicRow = LegalBodyRecord & {
  bodyAddress: Address;
  agentId: string;
  identityOwner: Address;
  oaManifestHash: Hex;
  oaManifestVersion: number;
};

/** The row, narrowed; refused as `row_incomplete` when a field the CHECKs require is missing
 *  (unreachable while they hold). */
function publicRow(r: LegalBodyRecord): PublicRow {
  const { bodyAddress, agentId, identityOwner, oaManifestHash, oaManifestVersion } = r;
  if (
    bodyAddress === null ||
    agentId === null ||
    identityOwner === null ||
    oaManifestHash === null ||
    oaManifestVersion === null
  )
    throw new RowRefused(r.legalBodyId, "row_incomplete");
  return { ...r, bodyAddress, agentId, identityOwner, oaManifestHash, oaManifestVersion };
}

/** A row of this chain and factory in a public state. */
function isPublicRowOf(d: Deployment, r: LegalBodyRecord): boolean {
  return (
    r.chainId === d.chainId &&
    isAddressEqual(r.factory, d.factory) &&
    PUBLIC_STATES.includes(r.bindingState)
  );
}

/** The agent and the bodies, read at one block. The answer must hold exactly that agent and those
 *  bodies, in order; anything else is a failed read. */
function snapshotOf(
  chain: StatementChainPort,
  agentId: string,
  bodies: readonly Address[],
): Promise<{ blockNumber: bigint; agent: AgentSnapshot }> {
  return attempt("snapshot", async () => {
    const snap = await chain.readStatementSnapshot([{ agentId: BigInt(agentId), bodies }]);
    const agent = snap.agents[0];
    if (
      snap.agents.length !== 1 ||
      agent === undefined ||
      agent.agentId !== BigInt(agentId) ||
      agent.bodies.length !== bodies.length ||
      !agent.bodies.every((b, i) => isAddressEqual(b.body, bodies[i] as Address))
    )
      throw new IncompleteSnapshotError();
    return { blockNumber: snap.blockNumber, agent };
  });
}

/**
 * The statement about the agent's legal body, read fresh.
 *
 *  1. An agent id that is not canonical (`isCanonicalAgentId`): `none`.
 *  2. The agent's public rows of this deployment, at most 4. None: `none`, with no chain read. A
 *     row missing a field its state requires is refused (`row_incomplete`).
 *  3. One snapshot: the agent and every candidate's body, at one block.
 *  4. The row: when the chain links a body, the candidate holding it; failing that, the row of
 *     this deployment recorded for that body in a public state, whose body is read again in a
 *     snapshot of its own so every fact is of one block; failing that, `none` and an ops line.
 *     When the chain links nothing, the most recent linked stretch: the first candidate ever
 *     linked, or `none`. A body never linked is stated only while the chain links it.
 *  5. The codes at the body's creator and at the agent's wallet, at the snapshot's block (no read
 *     for the zero wallet, one for a wallet that is the creator). A body the factory records no
 *     creator for is refused (`not_ours`) before anything more is read.
 *  6. The recorded facts, each row read once (`recordedFacts`).
 *  7. The statement, assembled and signed. A row the chain disagrees with, or a company this
 *     deployment does not state, is refused, unsigned: `none` and an ops line.
 *  8. The log: one row per distinct set of claims. A failed write is an ops line, and the
 *     statement still stands: the signature proves what was signed.
 *
 * A chain read or a signature that fails answers `unknown`, unsigned and unlogged. A database read
 * that fails throws.
 */
export async function statementForAgent(
  deps: LegalBodyStatementDeps,
  agentId: string,
): Promise<StatementOutcome> {
  if (!isCanonicalAgentId(agentId)) return { kind: "none" };
  try {
    return await stateAgent(deps, agentId);
  } catch (e) {
    if (e instanceof StageFailed) return unavailable(agentId, e.stage, e.cause);
    if (e instanceof RowRefused) {
      opsLog("legal_body_statement_integrity", { legalBodyId: e.legalBodyId, problem: e.problem });
      return { kind: "none" };
    }
    throw e;
  }
}

/** Steps 2 to 4 of `statementForAgent`: the row, and the one block its chain facts are read at. */
async function stateAgent(
  deps: LegalBodyStatementDeps,
  agentId: string,
): Promise<StatementOutcome> {
  const listed = deps.repo.listPublicByAgent(deps.deployment, agentId, ROWS_PER_AGENT);
  if (listed.length === 0) return { kind: "none" };
  const candidates = listed.map(publicRow);

  let { blockNumber, agent } = await snapshotOf(
    deps.chain,
    agentId,
    candidates.map((r) => r.bodyAddress),
  );
  let row: PublicRow | undefined;
  const linked = agent.linked;
  if (linked !== undefined) {
    // By the address the chain links, never by a place in the listing.
    row = candidates.find((r) => isAddressEqual(r.bodyAddress, linked));
    if (row === undefined) {
      // The owner can point back at an older body before the binding check has recorded it.
      const recorded = deps.repo.findByBodyAddress(deps.deployment.chainId, linked);
      if (recorded === undefined || !isPublicRowOf(deps.deployment, recorded)) {
        opsLog("legal_body_statement_unlisted_body", { agentId });
        return { kind: "none" };
      }
      row = publicRow(recorded);
      ({ blockNumber, agent } = await snapshotOf(deps.chain, agentId, [linked]));
    }
  } else {
    row = candidates.find((r) => r.pointerSeenAt !== null);
    if (row === undefined) return { kind: "none" };
  }
  const bodyAddress = row.bodyAddress;
  const body = agent.bodies.find((b) => isAddressEqual(b.body, bodyAddress));
  // Unreachable: the snapshot that answered holds the row's body.
  if (body === undefined) throw new StageFailed("snapshot", new IncompleteSnapshotError());
  return stateRow(deps, agentId, row, { blockNumber, agent, body });
}

/** Steps 5 to 8 of `statementForAgent`, for the chosen row. */
async function stateRow(
  deps: LegalBodyStatementDeps,
  agentId: string,
  row: PublicRow,
  observed: { blockNumber: bigint; agent: AgentSnapshot; body: BodySnapshot },
): Promise<StatementOutcome> {
  const { blockNumber, agent, body } = observed;
  const creator = body.creator;
  if (creator === undefined) throw new RowRefused(row.legalBodyId, "not_ours");
  const wallet = agent.agentWallet;
  const { ownerCode, walletCode } = await attempt("code", async () => {
    const ownerCode = await deps.chain.codeKind(creator, blockNumber);
    const walletCode: CodeKind = isAddressEqual(wallet, zeroAddress)
      ? "none"
      : isAddressEqual(wallet, creator)
        ? ownerCode
        : await deps.chain.codeKind(wallet, blockNumber);
    return { ownerCode, walletCode };
  });

  const facts = recordedFacts(deps, row);
  const statement = assembled(deps, row, { ...observed, ownerCode, walletCode }, facts);
  const signed = await attempt("sign", () => signStatement(statement, deps.signer));

  try {
    deps.statements.appendIfChanged({
      legalBodyId: row.legalBodyId,
      chainId: deps.chain.chainId,
      factory: deps.chain.factory,
      agentId,
      agentWallet: wallet,
      attestor: deps.signer.address,
      standing: statement.standing,
      claimsHash: claimsHash(statement),
      observedAtBlock: Number(blockNumber),
      issuedAt: facts.issuedAt,
      evidence: facts.evidence,
    });
  } catch (e) {
    opsLog("legal_body_statement_log_failed", {
      legalBodyId: row.legalBodyId,
      errorName: nameOf(e),
    });
  }
  opsLog("legal_body_statement", {
    agentId,
    standing: statement.standing,
    bindingState: statement.bindingState,
  });
  return {
    kind: "statement",
    agentId,
    legalBodyId: row.legalBodyId,
    publicId: row.publicId,
    standing: statement.standing,
    statement: signed,
  };
}

/** What the deployment recorded about a row: its company, its body and its guardian. */
interface RecordedFacts {
  provider: string;
  attestation: Attestation;
  names: { legalName: string; filingNumber: string } | null;
  filing: FilingFacts;
  guardianHumanVerified: boolean;
  /** Unix seconds: the statement's issue, the day the filing facts are counted on. */
  issuedAt: number;
  /** The ids and values the claims rest on, for the log. */
  evidence: StatementEvidence;
}

/**
 * The recorded facts of a row, EACH ROW READ ONCE, in this order, so the attestation, the names
 * and the filing facts all rest on the same reads:
 *  - the company: refused when missing (`company_missing`), or when it is not a customer's own
 *    (`unsupported_provider`), before anything more is read;
 *  - its latest check;
 *  - the body's events: the first `revoked` one, if any;
 *  - the attestation, from those reads, as the attestation's own rule derives it for a customer's
 *    company (never filed through formation; paid once the company is `ready`);
 *  - the names a public surface may show, from the declaration and that same check;
 *  - the filing facts on the Wyoming date of the issue, from the formation date and the last
 *    annual report of the latest check when it is a pass;
 *  - whether the guardian is a verified human. A failed read of it throws: it says nothing about
 *    the guardian.
 * A database read that fails throws.
 */
function recordedFacts(deps: LegalBodyStatementDeps, row: PublicRow): RecordedFacts {
  const company = deps.companies.find(row.companyId);
  if (company === undefined) throw new RowRefused(row.legalBodyId, "company_missing");
  if (company.provider !== CUSTOMER_PROVIDER)
    throw new RowRefused(row.legalBodyId, "unsupported_provider");
  const latest = deps.checks.latest(row.companyId);
  const revocation = deps.repo.listEvents(row.legalBodyId).find((e) => e.kind === "revoked");
  const revocationEventId = revocation?.id ?? null;
  const attestation = deriveAttestationState({
    provider: company.provider,
    latestCheck: latest,
    formationFiled: false,
    paid: company.status === "ready",
    bodyRevoked: revocationEventId !== null,
  });
  const names = publicCompanyNames(deps.declarations.find(row.companyId), latest);
  const passed = latest?.result === "passed" ? latest : undefined;
  const lastReport =
    passed?.lastReportPeriod === undefined
      ? null
      : { period: passed.lastReportPeriod, filedOn: passed.lastReportFiledOn ?? null };
  const issuedAt = Math.floor((deps.now ?? Date.now)() / 1000);
  const filing = filingFacts({
    formationDate: passed?.formationDate ?? null,
    lastReport,
    today: wyomingDate(issuedAt),
  });
  const guardianHumanVerified = realHumanState(deps.world, row.tenantId, deps.environment).ok;
  return {
    provider: company.provider,
    attestation,
    names,
    filing,
    guardianHumanVerified,
    issuedAt,
    evidence: {
      checkId: passed?.checkId ?? null,
      revocationEventId,
      companyStatus: company.status,
      humanVerified: guardianHumanVerified,
    },
  };
}

/** The statement, unsigned, from one block's chain facts and the row's recorded facts. The chain
 *  and the factory are the chain port's: what was observed. A refusal of the assembly refuses the
 *  row. */
function assembled(
  deps: LegalBodyStatementDeps,
  row: PublicRow,
  chainFacts: {
    blockNumber: bigint;
    agent: AgentSnapshot;
    body: BodySnapshot;
    ownerCode: CodeKind;
    walletCode: CodeKind;
  },
  facts: RecordedFacts,
): LegalBodyStatement {
  try {
    return assembleStatement({
      chainId: deps.chain.chainId,
      identityRegistry: deps.identityRegistry,
      factory: deps.chain.factory,
      row,
      agent: chainFacts.agent,
      body: chainFacts.body,
      observedAtBlock: chainFacts.blockNumber,
      ownerCode: chainFacts.ownerCode,
      walletCode: chainFacts.walletCode,
      provider: facts.provider,
      attestation: facts.attestation,
      names: facts.names,
      filing: facts.filing,
      guardianHumanVerified: facts.guardianHumanVerified,
      environment: deps.environment,
      issuedAt: facts.issuedAt,
    }).statement;
  } catch (e) {
    if (e instanceof StatementIntegrityError) throw new RowRefused(row.legalBodyId, e.problem);
    throw e;
  }
}

/**
 * The statement for an address: the legal body of an agent whose wallet is that address, read
 * fresh. The database only proposes candidates; the chain confirms them.
 *
 *  1. The candidate agents: those whose rows record the address as the identity owner, then those
 *     whose logged statements record it as the agent's wallet; each once, at most 5, in that order.
 *     None: `none`, with no chain read. A value that is not an address reads nothing at all.
 *  2. One snapshot of their wallets. Confirmed: the candidates whose wallet is the address, in any
 *     letter case. A failed read: `unknown`, with no agent id.
 *  3. None confirmed: `none`.
 *  4. A statement for each of the first 3 confirmed, in order, kept only if the wallet it states,
 *     read at its own block, is still the address. An `unknown` ends the loop.
 *  5. The first kept statement that is `active`; else, after an `unknown`, that `unknown`; else the
 *     first kept statement; else `none`.
 *
 * So an `unknown` here can rest on candidates the chain could not confirm: it means "a candidate
 * that could not be checked right now", not a yes. A database read that fails throws.
 */
export async function statementForAddress(
  deps: LegalBodyStatementDeps,
  address: Address,
): Promise<StatementOutcome> {
  if (!isAddress(address, { strict: false })) return { kind: "none" };
  const ids: string[] = [];
  for (const id of [
    ...deps.repo.listAgentIdsByIdentityOwner(deps.deployment, address, IDS_PER_ADDRESS),
    ...deps.statements.agentIdsByWallet(deps.deployment, address, IDS_PER_ADDRESS),
  ])
    if (ids.length < IDS_PER_ADDRESS && !ids.includes(id)) ids.push(id);
  if (ids.length === 0) return { kind: "none" };

  let confirmed: string[];
  try {
    const snap = await deps.chain.readStatementSnapshot(
      ids.map((id) => ({ agentId: BigInt(id), bodies: [] })),
    );
    confirmed = ids.filter((id) => {
      const agent = snap.agents.find((a) => a.agentId === BigInt(id));
      return agent !== undefined && isAddressEqual(agent.agentWallet, address);
    });
  } catch (e) {
    return unavailable(null, "snapshot", e);
  }
  if (confirmed.length === 0) return { kind: "none" };

  const kept: Extract<StatementOutcome, { kind: "statement" }>[] = [];
  let unknown: Extract<StatementOutcome, { kind: "unknown" }> | undefined;
  for (const id of confirmed.slice(0, STATED_PER_ADDRESS)) {
    const out = await statementForAgent(deps, id);
    if (out.kind === "unknown") {
      unknown = out;
      break;
    }
    // Kept only while the wallet, read again at the statement's own block, is still the address:
    // a wallet that moved in between makes it a statement about another wallet.
    if (out.kind === "statement" && isAddressEqual(out.statement.message.agentWallet, address))
      kept.push(out);
  }
  return kept.find((k) => k.standing === "active") ?? unknown ?? kept[0] ?? { kind: "none" };
}
