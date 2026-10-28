import { KLEROS_DEPLOYMENTS, klerosCaseUrl } from "../adapters/kleros/deployments";
import type { ByAgentAnswer } from "../api/routes/legalBodyStatements";
import { arcTestnet } from "../chains";
import type { Config } from "../config/env";
import type { Address, Hex } from "../types";
import type { KlerosChainOnRow, PilotCaseRecord, PilotMode, PilotStatus } from "./types";

/**
 * THE PUBLIC VIEW OF A PILOT CASE: what a stranger may read of one `pilot_cases` row, served by
 * `GET /pilot/cases` as test data.
 *
 * Built field by field from the row, never by spreading it, so a column added to the table is not
 * served until it is added here. Left out on purpose: the row's `error` text (it can quote a URL
 * or an exception), every file path (the deliverable, the evidence, the two stored answers), the
 * Dispute Service's local dispute id, the policy URI, and the Kleros-side transaction hashes. A
 * reader gets the job's Arc transactions with their explorer links, the Court interface link of
 * the dispute, and the two parties with the link to their legal bodies.
 *
 * Every step after `created` lands in a later command, so each block is null until its step has
 * written its columns: a fresh row and a settled one take the same shape.
 */

export interface TxView {
  hash: Hex;
  url: string;
}

export interface PartyView {
  address: Address;
  agentId: string;
  /** The legal name the party's signed statement stated at filing; null without one. */
  legalName: string | null;
  /** The standing that statement stated at filing; null without one. */
  standingAtFiling: string | null;
  /** The public lookup of the party's legal body, by agent. */
  lookupUrl: string;
}

export interface PilotCaseView {
  caseId: string;
  label: string;
  mode: PilotMode;
  status: PilotStatus;
  chainId: number;
  jobContract: Address;
  jobId: string | null;
  buyer: PartyView;
  seller: PartyView;
  refereeAddress: Address;
  budgetUsdc: string;
  description: string;
  expiredAt: number;
  tx: { create: TxView | null; fund: TxView | null; submit: TxView | null; settle: TxView | null };
  kleros: {
    chain: KlerosChainOnRow;
    courtId: number | null;
    courtLabel: string;
    coreDisputeId: string | null;
    caseUrl: string | null;
    status: string | null;
    ruling: string | null;
    tied: boolean | null;
    roundCount: number | null;
    rulingLabel: string | null;
    readAt: number | null;
  } | null;
  evidence: { name: string; sha256: Hex; attachmentUri: string | null } | null;
  settlement: {
    action: string;
    reason: Hex | null;
    outcome: string | null;
    at: number | null;
  } | null;
  contest: { reason: string; reply: string | null; at: number } | null;
  updatedAt: string;
}

/** The public words for a rehearsal: no court was asked. */
const REHEARSAL_COURT_LABEL = "rehearsal (no court)";

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/**
 * The base of the job's transaction links: the configured Arc explorer, else Arc testnet's own,
 * without a trailing slash. `loadConfig` always sets `arcExplorerUrl`; a Config built by hand may
 * not, and gets the chain definition's explorer, as config does.
 */
export function pilotExplorerBase(cfg: Config): string {
  const url = cfg.arcExplorerUrl ?? arcTestnet.blockExplorers?.default.url;
  if (!url) throw new Error("no Arc explorer: ARC_EXPLORER_URL is unset and the chain names none");
  return withoutTrailingSlash(url);
}

/**
 * The base of the parties' lookup links: the pilot's own lookup base where the pilot block is set
 * (it is where the pilot read the two answers), else the API's public origin, else the metadata
 * base, without a trailing slash.
 */
export function pilotLookupBase(cfg: Config): string {
  return withoutTrailingSlash(
    cfg.pilot ? cfg.pilot.lookupBase : (cfg.publicApiUrl ?? cfg.metadataBaseUrl),
  );
}

/** The Court's public name for a case's Kleros chain: the deployment's label, or the rehearsal's
 *  words for the fake. */
export function courtLabelOf(chain: KlerosChainOnRow): string {
  if (chain === "fake") return REHEARSAL_COURT_LABEL;
  const deployment = Object.values(KLEROS_DEPLOYMENTS).find((d) => d.chain === chain);
  if (!deployment) throw new Error(`no Kleros deployment for chain ${JSON.stringify(chain)}`);
  return deployment.label;
}

/**
 * The budget in USDC (six decimals) with two decimals, as the pilot's whole-cent budgets read
 * ("2.00"). A budget finer than a cent keeps every significant decimal ("2.001"): rounding it
 * would show a number the escrow does not hold. Anything but a decimal string is refused.
 */
export function budgetUsdcOf(atomic: string): string {
  if (!/^[0-9]+$/.test(atomic)) throw new Error("the budget is not a decimal number");
  const value = BigInt(atomic);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  const significant = fraction.replace(/0+$/, "");
  return `${value / 1_000_000n}.${significant.length <= 2 ? fraction.slice(0, 2) : significant}`;
}

/** The Court interface page of a dispute; null for the fake, before an id, and for an id that is
 *  not a decimal number (no link is ever built from one). */
function caseUrlOf(chain: KlerosChainOnRow, coreDisputeId: string | null): string | null {
  if (chain === "fake" || coreDisputeId === null) return null;
  try {
    return klerosCaseUrl(chain, coreDisputeId);
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A lookup answer by agent as the pilot stored it at filing, read back; null for anything that is
 * not one (not JSON, not an object, or without the fields the view reads), so a damaged file is
 * served as absent rather than as an error.
 */
export function parseStoredAnswer(text: string): ByAgentAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (
    typeof parsed.agentId !== "string" ||
    typeof parsed.legalBody !== "boolean" ||
    typeof parsed.checkedAt !== "string"
  )
    return null;
  const statement = parsed.statement;
  if (statement !== undefined && statement !== null) {
    if (!isObject(statement) || !isObject(statement.message)) return null;
    const { legalName, standing } = statement.message;
    if (typeof legalName !== "string" || typeof standing !== "string") return null;
  }
  return parsed as ByAgentAnswer;
}

/** The signed statement's message of an answer, when it carries one. */
function messageOf(answer: ByAgentAnswer | undefined) {
  return answer?.legalBody === true && answer.statement ? answer.statement.message : undefined;
}

function partyOf(
  address: string,
  agentId: string,
  answer: ByAgentAnswer | undefined,
  lookupBase: string,
): PartyView {
  const message = messageOf(answer);
  return {
    address: address as Address,
    agentId,
    // A statement whose names may not be shown carries "": that is no name, not an empty one.
    legalName: message?.legalName ? message.legalName : null,
    standingAtFiling: message?.standing ?? null,
    lookupUrl: `${lookupBase}/legal-bodies/by-agent/${agentId}`,
  };
}

/** The public view of one row. Pure: the stored answers are read by the caller. */
export function toPilotCaseView(
  row: PilotCaseRecord,
  opts: {
    explorerBase: string;
    lookupBase: string;
    records?: { buyer?: ByAgentAnswer; seller?: ByAgentAnswer };
  },
): PilotCaseView {
  const explorerBase = withoutTrailingSlash(opts.explorerBase);
  const lookupBase = withoutTrailingSlash(opts.lookupBase);
  const tx = (hash: string | null): TxView | null =>
    hash === null ? null : { hash: hash as Hex, url: `${explorerBase}/tx/${hash}` };
  const chain = row.klerosChain;
  return {
    caseId: row.caseId,
    label: row.label,
    mode: row.mode,
    status: row.status,
    chainId: row.chainId,
    jobContract: row.jobContract as Address,
    jobId: row.jobId,
    buyer: partyOf(row.buyerAddress, row.buyerAgentId, opts.records?.buyer, lookupBase),
    seller: partyOf(row.sellerAddress, row.sellerAgentId, opts.records?.seller, lookupBase),
    refereeAddress: row.refereeAddress as Address,
    budgetUsdc: budgetUsdcOf(row.budgetAtomic),
    description: row.description,
    expiredAt: row.expiredAt,
    tx: {
      create: tx(row.createTxHash),
      fund: tx(row.fundTxHash),
      submit: tx(row.submitTxHash),
      settle: tx(row.settleTxHash),
    },
    // The deployment is written by the `contested` to `filing` advance, so a row before it has
    // no dispute to show.
    kleros:
      chain === null
        ? null
        : {
            chain,
            courtId: row.klerosCourtId,
            courtLabel: courtLabelOf(chain),
            coreDisputeId: row.coreDisputeId,
            caseUrl: caseUrlOf(chain, row.coreDisputeId),
            status: row.rulingStatus,
            ruling: row.rulingValue,
            tied: row.rulingTied === null ? null : row.rulingTied === 1,
            roundCount: row.rulingRoundCount,
            rulingLabel: row.rulingLabel,
            readAt: row.rulingReadAt,
          },
    evidence:
      row.evidenceName === null || row.evidenceSha256 === null
        ? null
        : {
            name: row.evidenceName,
            sha256: row.evidenceSha256 as Hex,
            attachmentUri: row.attachmentUri,
          },
    settlement:
      row.settleAction === null
        ? null
        : {
            action: row.settleAction,
            reason: row.settleReason as Hex | null,
            outcome: row.escrowOutcome,
            at: row.settledAt,
          },
    contest:
      row.contestReason === null || row.contestedAt === null
        ? null
        : { reason: row.contestReason, reply: row.contestReply, at: row.contestedAt },
    updatedAt: row.updatedAt,
  };
}
