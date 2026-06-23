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
import { buildOperatorWalletClientForEntity } from "../adapters/turnkey/operatorWallet";
import { chainFor } from "../chains";
import type { Config } from "../config/env";
import type { DocumentStore } from "../persistence/documentStore";
import type { EntityRepository } from "../persistence/entityRepository";
import { type JobRepository, SqliteJobRepository } from "./jobRepository";
import { JobRunner, type RunJobFn } from "./jobRunner";
import { runJob as runJobSaga } from "./runJob";
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
): JobDeps {
  const jobs = new SqliteJobRepository(db);

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

  // Lazy: only called inside the saga (Step 2 / setBudget), not at boot time.
  const providerWalletFor = (e: { subOrgId: string; operator: string }) =>
    buildOperatorWalletClientForEntity(cfg, e);

  const jobClientAddress: Address = clientWallet.account!.address;
  // Fallback: when no distinct evaluator key is set, jobEvaluatorAddress == jobClientAddress.
  // A real distinct evaluator key (JOB_EVALUATOR_PRIVATE_KEY) is required for live on-chain runs.
  const jobEvaluatorAddress: Address = evaluatorWallet?.account?.address ?? jobClientAddress;

  const runJob: RunJobFn = (input) =>
    runJobSaga({
      jobKey: input.jobKey,
      entityKey: input.entityKey,
      tenantId: input.tenantId,
      budget: input.budget,
      description: input.description,
      usdc: cfg.usdc,
      jobs,
      entities,
      job: jobAdapter,
      reputation: reputationAdapter,
      worker,
      docStore,
      providerWalletFor,
      sweepToTreasury: cfg.jobSweepToTreasury,
    });

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
