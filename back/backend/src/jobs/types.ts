import type { Address, Hex } from "viem";

export type { Address, Hex };

/** Job lifecycle status values. Forward order: pending < created < funded < submitted < completed < reputed. `failed` is a terminal-error state. */
export type JobStatus =
  | "pending"
  | "created"
  | "funded"
  | "submitted"
  | "completed"
  | "reputed"
  | "failed";

/**
 * WHERE A JOB'S ESCROW ENDED UP — a property of the row, never a status of its own.
 *
 * `none`     the chain never held anything for this job (it died at or before Open).
 * `escrowed` the budget IS in the contract right now, and we have not got it back yet.
 * `refunded` it went back to the client — by our reject/claimRefund, or by somebody else's.
 * `released` the provider was paid. There is nothing to refund; the job earned it.
 *
 * `null` means nobody has read the chain for this row yet, which is every row written before the
 * column existed — and the reason the recovery walk treats `null` and `escrowed` alike.
 */
export type EscrowState = "none" | "escrowed" | "refunded" | "released";

/** One persisted job record. */
export interface JobRecord {
  jobKey: string;
  jobId: string | null;
  entityKey: string;
  ownerTenantId?: string;
  status: JobStatus;
  clientAddress: Address;
  evaluatorAddress: Address;
  providerAddress: Address;
  budgetAmount: string; // bigint serialized as decimal string
  description: string;
  deliverableHash: string | null;
  deliverablePath: string | null;
  createTxHash: Hex | null;
  fundTxHash: Hex | null;
  submitTxHash: Hex | null;
  completeTxHash: Hex | null;
  sweepTxHash: Hex | null;
  reputationTxHash: Hex | null;
  /** The transaction that sent the escrow back, when it was OURS. Null when somebody else's
   *  claimRefund got there first, or when no refund was needed. */
  refundTxHash: Hex | null;
  escrowState: EscrowState | null;
  error?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}
