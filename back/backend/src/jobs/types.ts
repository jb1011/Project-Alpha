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
  error?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}
