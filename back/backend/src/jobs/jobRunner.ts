import { ApiError } from "../api/errors";
import type { JobRepository } from "./jobRepository";
import type { JobRecord, JobStatus } from "./types";

export type RunJobFn = (input: {
  jobKey: string;
  entityKey: string;
  tenantId?: string;
  budget: bigint;
  description: string;
}) => Promise<JobRecord>;

// `completed` is a settled (irreversible) state — never clobber it to `failed` on a late throw.
// `listInFlight` (NOT IN reputed/failed) still includes `completed`, so reconcile retries its
// best-effort sweep/reputation steps.
const TERMINAL: JobStatus[] = ["completed", "reputed", "failed"];

/** Drives the resumable job saga in-process: immediate pending record + background run. */
export class JobRunner {
  private readonly inFlight = new Set<string>();
  private readonly pending: Promise<unknown>[] = [];

  constructor(private readonly deps: { jobs: JobRepository; runJob: RunJobFn }) {}

  start(p: {
    jobKey: string;
    entityKey: string;
    tenantId?: string;
    budget: bigint;
    description: string;
    clientAddress: string;
    evaluatorAddress: string;
    providerAddress: string;
  }): { jobKey: string; status: JobStatus } {
    if (this.inFlight.has(p.jobKey) || this.deps.jobs.findByKey(p.jobKey))
      throw new ApiError("conflict", 409, `job already exists for "${p.jobKey}"`);

    const initial: JobRecord = {
      jobKey: p.jobKey,
      jobId: null,
      entityKey: p.entityKey,
      ownerTenantId: p.tenantId,
      status: "pending",
      clientAddress: p.clientAddress as JobRecord["clientAddress"],
      evaluatorAddress: p.evaluatorAddress as JobRecord["evaluatorAddress"],
      providerAddress: p.providerAddress as JobRecord["providerAddress"],
      budgetAmount: p.budget.toString(),
      description: p.description,
      deliverableHash: null,
      deliverablePath: null,
      createTxHash: null,
      fundTxHash: null,
      submitTxHash: null,
      completeTxHash: null,
      sweepTxHash: null,
      reputationTxHash: null,
      error: null,
    };
    this.deps.jobs.upsert(initial);
    this.run(p.jobKey, () =>
      this.deps.runJob({
        jobKey: p.jobKey,
        entityKey: p.entityKey,
        tenantId: p.tenantId,
        budget: p.budget,
        description: p.description,
      }),
    );
    return { jobKey: p.jobKey, status: "pending" };
  }

  /** Resume non-terminal records after a restart. */
  reconcileInFlight(): number {
    let resumed = 0;
    for (const rec of this.deps.jobs.listInFlight()) {
      if (this.inFlight.has(rec.jobKey)) continue;
      this.run(rec.jobKey, () =>
        this.deps.runJob({
          jobKey: rec.jobKey,
          entityKey: rec.entityKey,
          tenantId: rec.ownerTenantId,
          budget: BigInt(rec.budgetAmount),
          description: rec.description,
        }),
      );
      resumed++;
    }
    return resumed;
  }

  /** Await all background work (tests/shutdown). */
  async settled(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  private run(jobKey: string, fn: () => Promise<unknown>) {
    this.inFlight.add(jobKey);
    const task = (async () => {
      // Yield to the current synchronous frame so callers can observe the `pending` record
      // before the saga mutates it. This matches real async behaviour (network/chain calls).
      await Promise.resolve();
      try {
        await fn();
      } catch (e) {
        const cur = this.deps.jobs.findByKey(jobKey);
        if (cur && !TERMINAL.includes(cur.status))
          this.deps.jobs.upsert({
            ...cur,
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
      } finally {
        this.inFlight.delete(jobKey);
      }
    })();
    this.pending.push(task);
  }
}
