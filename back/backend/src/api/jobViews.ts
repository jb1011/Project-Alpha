import type { EscrowState } from "../jobs/types";
import type { Address, Hex, JobRecord, JobStatus } from "../jobs/types";

/** Secret-free projection of a JobRecord for API responses. */
export interface JobView {
  jobKey: string;
  jobId: string | null;
  entityKey: string;
  ownerTenantId?: string;
  status: JobStatus;
  clientAddress: Address;
  evaluatorAddress: Address;
  providerAddress: Address;
  budgetAmount: string;
  description: string;
  deliverableHash: string | null;
  deliverablePath: string | null;
  createTxHash: Hex | null;
  fundTxHash: Hex | null;
  submitTxHash: Hex | null;
  completeTxHash: Hex | null;
  sweepTxHash: Hex | null;
  reputationTxHash: Hex | null;
  /** Where this job's escrow ended up, and the transaction that sent it back if it was ours.
   *  Served to every caller: a refund nobody can see is one an operator has to go and find. */
  refundTxHash: Hex | null;
  escrowState: EscrowState | null;
  error: string | null;
}

export function toJobView(r: JobRecord): JobView {
  return {
    jobKey: r.jobKey,
    jobId: r.jobId,
    entityKey: r.entityKey,
    ownerTenantId: r.ownerTenantId,
    status: r.status,
    clientAddress: r.clientAddress,
    evaluatorAddress: r.evaluatorAddress,
    providerAddress: r.providerAddress,
    budgetAmount: r.budgetAmount,
    description: r.description,
    deliverableHash: r.deliverableHash,
    deliverablePath: r.deliverablePath,
    createTxHash: r.createTxHash,
    fundTxHash: r.fundTxHash,
    submitTxHash: r.submitTxHash,
    completeTxHash: r.completeTxHash,
    sweepTxHash: r.sweepTxHash,
    reputationTxHash: r.reputationTxHash,
    refundTxHash: r.refundTxHash,
    escrowState: r.escrowState,
    error: r.error ?? null,
  };
}
