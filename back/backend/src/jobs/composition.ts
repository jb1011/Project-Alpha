import type Database from "better-sqlite3";
/**
 * Jobs composition root — wires all job-related pieces into a ready-to-use set of deps.
 *
 * buildJobDeps is a PURE factory: no network calls, no Turnkey I/O at construction time.
 * providerWalletFor is only invoked lazily when a job saga actually runs Step 2 (setBudget).
 */
import { http, createWalletClient } from "viem";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClientFor } from "../adapters/arc/clients";
import { JobAdapter } from "../adapters/arc/jobAdapter";
import { ReputationAdapter } from "../adapters/arc/reputationAdapter";
import type { CircleWalletsApi } from "../adapters/circle/circleWallets";
import { buildOperatorWalletClientForEntity } from "../adapters/turnkey/operatorWallet";
import { chainFor } from "../chains";
import type { Config } from "../config/env";
import { withKeyedLock } from "../payments/keyedMutex";
import { buildOutflowMeter } from "../payments/outflowMeter";
import { providerOf, requireCircleWallets } from "../payments/provider";
import type { DocumentStore } from "../persistence/documentStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { EntityRecord } from "../types";
import { circleJobOps } from "./circleJobOps";
import { type JobRepository, SqliteJobRepository } from "./jobRepository";
import { JobRunner, type RunJobFn } from "./jobRunner";
import { type ProviderJobOps, runJob as runJobSaga } from "./runJob";
import { TrivialWorker } from "./worker";

export interface JobDeps {
  jobs: JobRepository;
  jobRunner: JobRunner;
  jobAdapter: JobAdapter;
  reputationAdapter: ReputationAdapter;
  jobClientAddress: Address;
  /** Falls back to jobClientAddress when no distinct evaluator key is configured.
   * NOTE: a distinct evaluator key is required for live runs — complete() on-chain
   * requires a non-client evaluator in the general case. */
  jobEvaluatorAddress: Address;
  runJob: RunJobFn;
}

export function buildJobDeps(
  cfg: Config,
  db: Database.Database,
  entities: EntityRepository,
  docStore: DocumentStore,
  circleApi?: CircleWalletsApi,
): JobDeps {
  const jobs = new SqliteJobRepository(db);
  // S5: job budgets are platform client-wallet outflows — same rolling-window brake as funding.
  const outflows = buildOutflowMeter(db, {
    ceilingAtomic: cfg.platformOutflowCeiling,
    windowMs: cfg.platformOutflowWindowMs,
  });

  // Viem clients — no network calls at construction
  const publicClient = publicClientFor(cfg);
  const chain = chainFor(cfg.chainId, cfg.rpcUrl);
  const transport = http(cfg.rpcUrl);

  const clientWallet = createWalletClient({
    account: privateKeyToAccount(cfg.jobClientPrivateKey),
    chain,
    transport,
  });

  const evaluatorWallet = cfg.jobEvaluatorPrivateKey
    ? createWalletClient({
        account: privateKeyToAccount(cfg.jobEvaluatorPrivateKey),
        chain,
        transport,
      })
    : undefined;

  const jobAdapter = new JobAdapter({
    publicClient,
    clientWallet,
    evaluatorWallet,
    jobContract: cfg.jobContract,
  });

  // Recorder is a non-agent party — prefer the evaluator wallet; fall back to client.
  // Both are valid because giveFeedback is permissionless for non-agent callers.
  const reputationAdapter = new ReputationAdapter({
    publicClient,
    recorderWallet: evaluatorWallet ?? clientWallet,
    registry: cfg.reputationRegistry,
  });

  const worker = new TrivialWorker();

  // Lazy provider dispatch (Tier-0 audit item 4): only called inside the saga (Steps 2/3/4.5),
  // not at boot time. Turnkey wraps the enclave wallet (built once per ops instance, so a
  // multi-step saga run costs one Turnkey API read); circle routes through contractExecution with
  // per-(jobKey, step) deterministic idempotency.
  const providerOpsFor = (entity: EntityRecord, jobKey: string): ProviderJobOps => {
    if (providerOf(entity) === "circle") {
      if (!circleApi)
        throw new Error(
          `entity ${entity.idempotencyKey} is on the circle custody path but no Circle client is configured (CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET)`,
        );
      return circleJobOps({
        api: circleApi,
        operatorWalletId: requireCircleWallets(entity).operatorWalletId,
        jobContract: cfg.jobContract,
        jobKey,
        outflows,
      });
    }
    let walletPromise: ReturnType<typeof buildOperatorWalletClientForEntity> | undefined;
    const wallet = () => {
      walletPromise ??= buildOperatorWalletClientForEntity(cfg, {
        subOrgId: entity.turnkeySubOrgId!,
        operator: entity.operator!,
      });
      return walletPromise;
    };
    return {
      setBudget: async (jobId, amount) => jobAdapter.setBudget(jobId, amount, await wallet()),
      submit: async (jobId, deliverable) => jobAdapter.submit(jobId, deliverable, await wallet()),
      sweepToTreasury: async (usdc, treasury, amount) =>
        jobAdapter.transferUsdc(await wallet(), usdc, treasury, amount),
    };
  };

  const jobClientAddress: Address = clientWallet.account!.address;
  // Fallback: when no distinct evaluator key is set, jobEvaluatorAddress == jobClientAddress.
  // A real distinct evaluator key (JOB_EVALUATOR_PRIVATE_KEY) is required for live on-chain runs.
  const jobEvaluatorAddress: Address = evaluatorWallet?.account?.address ?? jobClientAddress;

  // Per-entity serialization SPANNING funding and jobs (Tier-0 audit item 6): the saga sends as
  // the operator (EOA or SCA — the SCA may only allow one in-flight tx), and the funding bridge
  // uses the same key space, so a concurrent fund_pocket + run_job for one agent queue instead of
  // racing nonces / the SCA queue.
  const runJob: RunJobFn = (input) =>
    withKeyedLock(input.entityKey, () =>
      runJobSaga({
        jobKey: input.jobKey,
        entityKey: input.entityKey,
        tenantId: input.tenantId,
        budget: input.budget,
        outflows,
        description: input.description,
        usdc: cfg.usdc,
        jobs,
        entities,
        job: jobAdapter,
        reputation: reputationAdapter,
        worker,
        docStore,
        providerOpsFor,
        sweepToTreasury: cfg.jobSweepToTreasury,
      }),
    );

  const jobRunner = new JobRunner({ jobs, runJob });

  return {
    jobs,
    jobRunner,
    jobAdapter,
    reputationAdapter,
    jobClientAddress,
    jobEvaluatorAddress,
    runJob,
  };
}
