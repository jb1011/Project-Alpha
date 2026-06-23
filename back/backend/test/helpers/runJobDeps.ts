/**
 * Fake-deps harness for runJob saga tests (Tasks 6.1, 6.2, 6.3).
 *
 * Exports:
 *   makeRunJobDeps(opts) → RunJobDeps  — full fake dependency graph
 *   seedBoundEntity(entities, entityKey) → EntityRecord  — insert a bound entity fixture
 */

import type Database from "better-sqlite3";
import type { Address, Hex, WalletClient } from "viem";
import type { JobAdapter, JobResult } from "../../src/adapters/arc/jobAdapter";
import type { ReputationAdapter } from "../../src/adapters/arc/reputationAdapter";
import type { JobRepository } from "../../src/jobs/jobRepository";
import type { RunJobDeps } from "../../src/jobs/runJob";
import type { JobWorker } from "../../src/jobs/worker";
import { TrivialWorker } from "../../src/jobs/worker";
import type { DocumentStore } from "../../src/persistence/documentStore";
import type { EntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

// ---------------------------------------------------------------------------
// Fixed deterministic addresses used across all saga tests
// ---------------------------------------------------------------------------
export const FAKE_CLIENT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
export const FAKE_EVALUATOR_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
export const FAKE_PROVIDER_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
export const FAKE_TREASURY_ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
export const FAKE_AGENT_ID = "656785";
export const FAKE_TURNKEY_SUB_ORG_ID = "test-sub-org-id";

function fakeTxHash(label: string): Hex {
  const hex = Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64);
  return `0x${hex}` as Hex;
}

// ---------------------------------------------------------------------------
// Fake JobAdapter — typed object implementing the JobAdapter shape directly
// ---------------------------------------------------------------------------
class FakeJobAdapter {
  get jobContract(): Address {
    return "0x0000000000000000000000000000000000000001" as Address;
  }
  async createJob(_p: {
    provider: Address;
    evaluator: Address;
    expiredAt: bigint;
    description: string;
    hook?: Address;
  }): Promise<{ jobId: bigint; txHash: Hex }> {
    return { jobId: 0n, txHash: fakeTxHash("createJob") };
  }
  async setBudget(_jobId: bigint, _amount: bigint, _providerWallet: WalletClient): Promise<Hex> {
    return fakeTxHash("setBudget");
  }
  async approveAndFund(_jobId: bigint, _usdc: Address, _amount: bigint): Promise<Hex> {
    return fakeTxHash("approveAndFund");
  }
  async submit(_jobId: bigint, _deliverable: Hex, _providerWallet: WalletClient): Promise<Hex> {
    return fakeTxHash("submit");
  }
  async complete(_jobId: bigint, _reason: Hex): Promise<Hex> {
    return fakeTxHash("complete");
  }
  async usdcBalanceOf(_usdc: Address, _owner: Address): Promise<bigint> {
    // Return a fixed balance larger than SWEEP_GAS_RESERVE so sweepAmount = balance - reserve.
    // Tests that need to inspect the exact sweep amount can override this method.
    return 500_000n; // same as the default budget fixture
  }
  async transferUsdc(
    _wallet: WalletClient,
    _usdc: Address,
    _to: Address,
    _amount: bigint,
  ): Promise<Hex> {
    return fakeTxHash("sweep");
  }
  async getJob(_jobId: bigint): Promise<JobResult> {
    return {
      id: 0n,
      client: FAKE_CLIENT_ADDRESS,
      provider: FAKE_PROVIDER_ADDRESS,
      evaluator: FAKE_EVALUATOR_ADDRESS,
      description: "stub",
      budget: 0n,
      expiredAt: 9_999_999_999n,
      status: 1,
      hook: "0x0000000000000000000000000000000000000000" as Address,
    };
  }
  async jobCounter(): Promise<bigint> {
    return 0n;
  }
  clientAddress(): Address {
    return FAKE_CLIENT_ADDRESS;
  }
  evaluatorAddress(): Address {
    return FAKE_EVALUATOR_ADDRESS;
  }
}

function makeFakeJobAdapter(): JobAdapter {
  return new FakeJobAdapter() as unknown as JobAdapter;
}

// ---------------------------------------------------------------------------
// Fake ReputationAdapter
// ---------------------------------------------------------------------------
class FakeReputationAdapter {
  async record(_p: {
    agentId: bigint;
    value: number;
    feedbackHash: Hex;
    feedbackURI?: string;
    tag1?: string;
  }): Promise<Hex> {
    return fakeTxHash("reputation");
  }
}

function makeFakeReputationAdapter(): ReputationAdapter {
  return new FakeReputationAdapter() as unknown as ReputationAdapter;
}

// ---------------------------------------------------------------------------
// Tiny in-memory DocumentStore
// ---------------------------------------------------------------------------
function makeFakeDocStore(): DocumentStore {
  const store = new Map<string, string>();
  return {
    put(name: string, contents: string) {
      store.set(name, contents);
      return { id: name, path: `/tmp/fake-docs/${name}`, uri: `file:///tmp/fake-docs/${name}` };
    },
    get(id: string): string {
      const v = store.get(id);
      if (v === undefined) throw new Error(`docStore: not found: ${id}`);
      return v;
    },
  };
}

// ---------------------------------------------------------------------------
// Dummy WalletClient (satisfies type; never actually signs in unit tests)
// ---------------------------------------------------------------------------
function makeDummyWallet(): WalletClient {
  return { account: { address: FAKE_PROVIDER_ADDRESS } } as unknown as WalletClient;
}

// ---------------------------------------------------------------------------
// makeRunJobDeps
// ---------------------------------------------------------------------------
export interface MakeRunJobDepsOpts {
  db: Database.Database;
  jobs: JobRepository;
  entities: EntityRepository;
  jobKey?: string;
  entityKey?: string;
  budget?: bigint;
  description?: string;
  usdc?: Address;
  sweepToTreasury?: boolean;
  expiryWindowSec?: number;
  now?: () => number;
  /** Override the fake job adapter (e.g. to inject spies). */
  job?: JobAdapter;
  /** Override the fake reputation adapter. */
  reputation?: ReputationAdapter;
  /** Override the worker. */
  worker?: JobWorker;
}

export function makeRunJobDeps(opts: MakeRunJobDepsOpts): RunJobDeps {
  return {
    jobKey: opts.jobKey ?? "t:k",
    entityKey: opts.entityKey ?? "t:agent",
    tenantId: undefined,
    budget: opts.budget ?? 500_000n,
    description: opts.description ?? "test job description",
    usdc: opts.usdc ?? ("0x0000000000000000000000000000000000000002" as Address),
    jobs: opts.jobs,
    entities: opts.entities,
    job: opts.job ?? makeFakeJobAdapter(),
    reputation: opts.reputation ?? makeFakeReputationAdapter(),
    worker: opts.worker ?? new TrivialWorker(),
    docStore: makeFakeDocStore(),
    providerWalletFor: async (_e) => makeDummyWallet(),
    sweepToTreasury: opts.sweepToTreasury ?? false,
    expiryWindowSec: opts.expiryWindowSec,
    now: opts.now,
  };
}

// ---------------------------------------------------------------------------
// seedBoundEntity — insert a bound entity fixture carrying all fields the saga needs
// ---------------------------------------------------------------------------
export function seedBoundEntity(entities: EntityRepository, entityKey: string): EntityRecord {
  const rec: EntityRecord = {
    idempotencyKey: entityKey,
    name: "Test Agent LLC",
    status: "bound",
    manager: FAKE_CLIENT_ADDRESS,
    guardian: FAKE_CLIENT_ADDRESS,
    operator: FAKE_PROVIDER_ADDRESS,
    amendmentDelay: "0",
    ein: "12-3456789",
    formationDate: 1_700_000_000,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: FAKE_AGENT_ID,
    proxy: null,
    treasury: FAKE_TREASURY_ADDRESS,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    turnkeySubOrgId: FAKE_TURNKEY_SUB_ORG_ID,
    turnkeyWalletId: "test-wallet-id",
    ownerTenantId: undefined,
    error: null,
    specJson: null,
  };
  entities.upsert(rec);
  return rec;
}
