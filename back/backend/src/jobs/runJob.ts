/**
 * runJob — idempotent saga that advances a job through its full lifecycle.
 *
 * Full saga:
 *   Step 0:   upsert a pending JobRecord (if none exists)
 *   Step 1:   createJob on-chain → status "created"
 *   Step 2:   provider setBudget + client approveAndFund → status "funded"
 *   Step 3:   worker produces deliverable + provider submits → status "submitted"
 *   Step 4:   evaluator complete → USDC released to provider → status "completed"
 *   Step 4.5: (optional, best-effort) sweep operator's actual USDC balance to treasury
 *   Step 5:   record on-chain reputation → status "reputed"
 *             (best-effort: failure stays "completed", retryable on next call)
 */

import type { Address, Hex } from "viem";
import type { JobAdapter } from "../adapters/arc/jobAdapter";
import type { ReputationAdapter } from "../adapters/arc/reputationAdapter";
import { providerOf, requireCircleWallets } from "../payments/provider";
import type { DocumentStore } from "../persistence/documentStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { EntityRecord } from "../types";
import type { JobRepository } from "./jobRepository";
import type { JobRecord } from "./types";
import type { JobWorker } from "./worker";

/**
 * The provider-signed on-chain job actions (Tier-0 audit item 4): everything the saga does AS the
 * agent's operator, abstracted over the custody provider. `turnkey` wraps the enclave-backed viem
 * wallet; `circle` routes through Circle contractExecution (async submit → poll). The evaluator-
 * and client-signed steps (createJob, approveAndFund, complete) stay on the JobAdapter — they are
 * platform keys, untouched by the custody choice.
 */
export interface ProviderJobOps {
  setBudget(jobId: bigint, amount: bigint): Promise<Hex>;
  submit(jobId: bigint, deliverable: Hex): Promise<Hex>;
  /** The job-earnings sweep (operator → treasury) survives on BOTH paths — `complete` still pays
   *  the operator (EOA or SCA). Only POCKET sweeps died fleet-wide. */
  sweepToTreasury(usdc: Address, treasury: Address, amount: bigint): Promise<Hex>;
}

// ---------------------------------------------------------------------------
// Public interface — exported so Tasks 6.2/6.3 can extend via pick/omit
// ---------------------------------------------------------------------------
export interface RunJobDeps {
  /** Idempotency key for this job (unique per business operation). */
  jobKey: string;
  /** Idempotency key of the provider entity (agent legal body). */
  entityKey: string;
  /** Optional owning tenant (controller wallet address). */
  tenantId?: string;
  /** USDC amount to escrow (in USDC's smallest unit, 6 decimals). */
  budget: bigint;
  /** S5: platform client-wallet outflow brake — check before job creation, record on fund. */
  outflows?: {
    check(amountAtomic: bigint): void;
    record(path: "job_fund", amountAtomic: bigint, ref: string | null): void;
  };
  /** Human-readable job description stored on-chain and in the DB. */
  description: string;
  /** USDC token contract address on the target chain. */
  usdc: Address;
  /** Persistent job record store. */
  jobs: JobRepository;
  /** Persistent entity record store (used to look up provider entity). */
  entities: EntityRepository;
  /** ERC-8183 job adapter (on-chain interactions). */
  job: JobAdapter;
  /** Arc reputation registry adapter. */
  reputation: ReputationAdapter;
  /** Produces the deliverable content for a funded job. */
  worker: JobWorker;
  /** Stores deliverable documents off-chain. */
  docStore: DocumentStore;
  /**
   * Build the provider-signed job ops for this entity + job (custody-provider dispatched).
   * Called lazily in Steps 2/3/4.5 — the steps that MUST be signed by the provider/operator.
   * `jobKey` feeds the circle path's deterministic idempotency seeds.
   */
  providerOpsFor: (entity: EntityRecord, jobKey: string) => ProviderJobOps;
  /** If true, sweep USDC to treasury after the job completes (Step 5, Task 6.3). */
  sweepToTreasury: boolean;
  /** Seconds until the on-chain job expires (default: 3600 = 1 hour). */
  expiryWindowSec?: number;
  /** Override current unix timestamp (seconds); useful in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Main saga
// ---------------------------------------------------------------------------
export async function runJob(d: RunJobDeps): Promise<JobRecord> {
  // --- Guard: entity must exist and be in a runnable state ---
  const entity = d.entities.findByIdempotencyKey(d.entityKey);
  if (!entity) {
    throw new Error(`runJob: entity ${d.entityKey} not found`);
  }
  if (entity.status !== "bound" && entity.status !== "funded") {
    throw new Error(`runJob: entity ${d.entityKey} is not a bound agent (status=${entity.status})`);
  }
  if (!entity.operator || !entity.agentId) {
    throw new Error(
      `entity ${d.entityKey} is not a fully-onboarded agent (missing operator/agentId)`,
    );
  }
  // Provider-aware onboarding guard (Tier-0 audit item 4): the turnkey path needs its sub-org,
  // the circle path its Circle wallet ids — requiring turnkey fields of a circle agent was one of
  // the two chokepoints that broke the compatibility guarantee.
  if (providerOf(entity) === "turnkey") {
    if (!entity.turnkeySubOrgId)
      throw new Error(
        `entity ${d.entityKey} is not a fully-onboarded agent (missing turnkeySubOrgId)`,
      );
  } else {
    requireCircleWallets(entity);
  }

  // Tier-0 audit fix (spec 2026-08-03, finding 2): the on-chain job pins its provider at
  // creation, but every later step signs with the LIVE entity operator. If the operator was
  // rotated mid-job (migration), resuming would revert on-chain (msg.sender != job.provider) —
  // or worse, `complete` would release earnings to the retired key after its drain. Refuse
  // loudly; the migration runbook requires job quiescence before rotation.
  const existing0 = d.jobs.findByKey(d.jobKey);
  if (
    existing0?.providerAddress &&
    entity.operator &&
    existing0.providerAddress.toLowerCase() !== entity.operator.toLowerCase()
  ) {
    throw new Error(
      `job ${d.jobKey} was created under provider ${existing0.providerAddress} but the entity's operator was rotated to ${entity.operator} — refusing to resume (drain/complete jobs before rotating)`,
    );
  }

  // --- Step 0: upsert pending record if none exists ---
  let rec = d.jobs.findByKey(d.jobKey);
  if (!rec) {
    rec = {
      jobKey: d.jobKey,
      jobId: null,
      entityKey: d.entityKey,
      ownerTenantId: d.tenantId,
      status: "pending",
      // clientAddress/evaluatorAddress are filled in Step 1 from the adapter
      clientAddress: "0x" as Address,
      evaluatorAddress: "0x" as Address,
      providerAddress: entity.operator,
      budgetAmount: d.budget.toString(),
      description: d.description,
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
    d.jobs.upsert(rec);
  }

  // --- Step 1: createJob on-chain (status: pending → created) ---
  if (rec.status === "pending") {
    const nowSec = d.now ? d.now() : Math.floor(Date.now() / 1000);
    const expiredAt = BigInt(nowSec + (d.expiryWindowSec ?? 3600));

    d.outflows?.check(d.budget); // S5: refuse before anything goes on-chain
    const { jobId, txHash: createTxHash } = await d.job.createJob({
      provider: entity.operator as Address,
      evaluator: d.job.evaluatorAddress(),
      expiredAt,
      description: d.description,
    });

    const updated: JobRecord = {
      ...rec,
      status: "created",
      jobId: jobId.toString(),
      createTxHash,
      clientAddress: d.job.clientAddress(),
      evaluatorAddress: d.job.evaluatorAddress(),
    };

    d.jobs.transaction(() => {
      d.jobs.upsert(updated);
      d.jobs.recordEvent(
        d.jobKey,
        "createJob",
        "created",
        createTxHash,
        JSON.stringify({ jobId: jobId.toString() }),
      );
    });

    rec = updated;
  }

  // --- Step 2: setBudget (provider-signed) + approveAndFund (client-signed) → funded ---
  if (rec.status === "created") {
    // setBudget MUST be signed by the provider (the contract enforces msg.sender == job.provider);
    // providerOpsFor dispatches on the entity's custody provider.
    const ops = d.providerOpsFor(entity, d.jobKey);

    await ops.setBudget(BigInt(rec.jobId!), d.budget);
    const fundTxHash = await d.job.approveAndFund(BigInt(rec.jobId!), d.usdc, d.budget);
    d.outflows?.record("job_fund", d.budget, fundTxHash);

    const updated: JobRecord = {
      ...rec,
      status: "funded",
      fundTxHash,
    };

    d.jobs.transaction(() => {
      d.jobs.upsert(updated);
      d.jobs.recordEvent(d.jobKey, "fund", "funded", fundTxHash, null);
    });

    rec = updated;
  }

  // --- Step 3: work + submit (provider = the agent's enclave operator) ---
  if (rec.status === "funded") {
    const { content, deliverableHash } = await d.worker.produceDeliverable({
      jobKey: d.jobKey,
      description: d.description,
    });
    const put = d.docStore.put(`job-${d.jobKey}.txt`, content);
    const submitTx = await d
      .providerOpsFor(entity, d.jobKey)
      .submit(BigInt(rec.jobId!), deliverableHash);

    const submitted: JobRecord = {
      ...rec,
      status: "submitted",
      deliverableHash,
      deliverablePath: put.path,
      submitTxHash: submitTx,
    };
    d.jobs.transaction(() => {
      d.jobs.upsert(submitted);
      d.jobs.recordEvent(d.jobKey, "submit", "submitted", submitTx, null);
    });
    rec = submitted;
  }

  // --- Step 4: evaluator complete → USDC released to provider ---
  if (rec.status === "submitted") {
    const completeTx = await d.job.complete(BigInt(rec.jobId!), `0x${"00".repeat(32)}` as Hex);

    const completed: JobRecord = {
      ...rec,
      status: "completed",
      completeTxHash: completeTx,
    };
    d.jobs.transaction(() => {
      d.jobs.upsert(completed);
      d.jobs.recordEvent(d.jobKey, "complete", "completed", completeTx, null);
    });
    rec = completed;
  }

  // --- Step 4.5 (optional): sweep earnings operator → treasury (best-effort, never blocks Step 5) ---
  if (rec.status === "completed" && d.sweepToTreasury && !rec.sweepTxHash && entity.treasury) {
    try {
      // Read the operator's actual current USDC balance rather than the static budget.
      // After paying for setBudget/submit gas in USDC, the operator balance is strictly
      // less than `budget`; using the static amount would always revert on-chain.
      const bal = await d.job.usdcBalanceOf(d.usdc, entity.operator as Address);
      // Keep a small gas reserve so the sweep tx itself can pay its own USDC gas. (On the circle
      // path Gas Station sponsors the fee, so the reserve is merely conservative, not load-bearing.)
      const SWEEP_GAS_RESERVE = 10_000n; // 0.01 USDC
      const sweepAmount = bal > SWEEP_GAS_RESERVE ? bal - SWEEP_GAS_RESERVE : 0n;
      if (sweepAmount > 0n) {
        const sweepTx = await d
          .providerOpsFor(entity, d.jobKey)
          .sweepToTreasury(d.usdc, entity.treasury as Address, sweepAmount);
        rec = { ...rec, sweepTxHash: sweepTx };
        d.jobs.transaction(() => {
          d.jobs.upsert(rec!);
          d.jobs.recordEvent(d.jobKey, "sweep", "completed", sweepTx, null);
        });
      } else {
        // Balance too low to sweep after reserving gas — skip, leave sweepTxHash null.
        rec = { ...rec, error: "sweep skipped: operator balance ≤ gas reserve" };
        d.jobs.upsert(rec);
      }
    } catch (e) {
      // Sweep failure is retryable — status stays `completed`, fall through to Step 5.
      rec = { ...rec, error: `sweep pending: ${(e as Error).message}` };
      d.jobs.upsert(rec);
    }
  }

  // --- Step 5: reputation (best-effort; never unwinds settlement) ---
  if (rec.status === "completed") {
    try {
      const repTx = await d.reputation.record({
        agentId: BigInt(entity.agentId!),
        value: 5,
        feedbackHash: rec.deliverableHash as Hex,
      });
      rec = { ...rec, status: "reputed", reputationTxHash: repTx, error: null };
      d.jobs.transaction(() => {
        d.jobs.upsert(rec!);
        d.jobs.recordEvent(d.jobKey, "reputation", "reputed", repTx, null);
      });
    } catch (e) {
      rec = { ...rec, error: `reputation pending: ${(e as Error).message}` };
      d.jobs.upsert(rec); // stays 'completed' — retryable
    }
  }

  return rec;
}
