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
    error: r.error ?? null,
  };
}
