/**
 * The pilot case, as the `pilot_cases` table holds it (design 2026-10-22 section 5.2).
 *
 * This module depends on nothing. `PilotMode` is declared here rather than imported from the
 * config's `PilotKlerosMode`: the two unions are identical by construction, and config does not
 * depend on `pilot/`.
 */

/** The status machine, in the order of the CHECK list. Forward only; the side exits are
 *  `filing_unknown`, `evidence_unknown` and `failed`. */
export const PILOT_STATUSES = [
  "created",
  "funded",
  "submitted",
  "contested",
  "filing",
  "filed",
  "ruled",
  "settling",
  "settled",
  "filing_unknown",
  "evidence_unknown",
  "failed",
] as const;
export type PilotStatus = (typeof PILOT_STATUSES)[number];

export const PILOT_MODES = ["rehearsal", "testnet", "live"] as const;
export type PilotMode = (typeof PILOT_MODES)[number];

/** The Kleros deployment a case's dispute lives on. `fake` is the rehearsal's, so a rehearsal
 *  dispute id can never be read against a real deployment. */
export type KlerosChainOnRow = "arbitrum-sepolia-testnet" | "arbitrum-one" | "fake";

/**
 * One row of `pilot_cases`, every column in camelCase. Big integers (job id, agent ids, budget)
 * are decimal strings; unix seconds are numbers; `createdAt` and `updatedAt` are SQLite
 * `CURRENT_TIMESTAMP` text. No field holds a key, a bearer token or a file's bytes: a
 * deliverable or an evidence file is referred to by path and hash.
 */
export interface PilotCaseRecord {
  caseId: string;
  label: string;
  mode: PilotMode;
  status: PilotStatus;
  chainId: number;
  jobContract: string;
  jobId: string | null;
  buyerAddress: string;
  buyerAgentId: string;
  sellerAddress: string;
  sellerAgentId: string;
  refereeAddress: string;
  budgetAtomic: string;
  description: string;
  expiredAt: number;
  deliverablePath: string | null;
  deliverableHash: string | null;
  deliverableExtension: string | null;
  createTxHash: string | null;
  fundTxHash: string | null;
  submitTxHash: string | null;
  createdBlockTime: number | null;
  fundedBlockTime: number | null;
  submittedBlockTime: number | null;
  contestReason: string | null;
  contestReply: string | null;
  contestedAt: number | null;
  buyerRecordPath: string | null;
  sellerRecordPath: string | null;
  evidencePath: string | null;
  evidenceSha256: string | null;
  evidenceName: string | null;
  klerosChain: KlerosChainOnRow | null;
  klerosCourtId: number | null;
  klerosPolicyUri: string | null;
  attachmentUri: string | null;
  attachmentCid: string | null;
  filingStartedAt: number | null;
  coreDisputeId: string | null;
  localDisputeId: string | null;
  createDisputeTx: string | null;
  filedAt: number | null;
  evidenceTx: string | null;
  evidenceStatus: string | null;
  rulingStatus: string | null;
  rulingValue: string | null;
  /** 0 or 1, as the INTEGER column holds it. */
  rulingTied: number | null;
  rulingRoundCount: number | null;
  rulingLabel: string | null;
  rulingReadAt: number | null;
  rulingDeadline: string | null;
  settleAction: "complete" | "reject" | "claimRefund" | "none" | null;
  settleReason: string | null;
  settleTxHash: string | null;
  settledAt: number | null;
  escrowOutcome: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewPilotCase = Pick<
  PilotCaseRecord,
  | "caseId"
  | "label"
  | "mode"
  | "chainId"
  | "jobContract"
  | "buyerAddress"
  | "buyerAgentId"
  | "sellerAddress"
  | "sellerAgentId"
  | "refereeAddress"
  | "budgetAtomic"
  | "description"
  | "expiredAt"
  | "deliverablePath"
  | "deliverableHash"
  | "deliverableExtension"
>;
