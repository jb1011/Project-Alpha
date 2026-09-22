/**
 * A FAKE NODE WHOSE ALLOWANCE BEHAVES LIKE AN ERC-20 ALLOWANCE, AND WHOSE RECEIPTS CARRY A STATUS.
 *
 * The 2026-09-22 incident is not reproducible against a node that answers `status: 0x1` to
 * everything, because the whole defect was that a transaction was MINED AND REVERTED and the code
 * read only its hash. So this node runs the three rules that produced it:
 *
 *  - `approve` SETS the allowance. It does not add. Two jobs approving 0.5 USDC each leave 0.5
 *    USDC of allowance between them, not 1.
 *  - `fund` pulls the job's budget through that allowance and REVERTS when it is not there — with
 *    a receipt, at `status: 0x0`, exactly as the chain answered. Nothing throws at broadcast.
 *  - every send gets a receipt keyed by its hash, carrying the status that send actually produced.
 *
 * It also keeps a nonce ledger per address and refuses a nonce it has already taken, like the
 * node in `adapters/arc/jobAdapter.lockWindow.test.ts` whose shape this follows — so a test can
 * read the ORDER of what reached the chain out of `actions`, and the numbering out of `sends`.
 *
 * No network, no anvil: a viem `custom` transport, real `privateKeyToAccount` signers above it.
 */
import Database from "better-sqlite3";
import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  defineChain,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { iErc8183JobAbi } from "../../src/abis/generated";
import { JobAdapter } from "../../src/adapters/arc/jobAdapter";
import type { ReputationAdapter } from "../../src/adapters/arc/reputationAdapter";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { JobRunner } from "../../src/jobs/jobRunner";
import { type RunJobDeps, runJob as runJobSaga } from "../../src/jobs/runJob";
import type { JobWorker } from "../../src/jobs/worker";
import { withKeyedLock } from "../../src/payments/keyedMutex";
import { migrate } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { FAKE_PROVIDER_ADDRESS, makeFakeDocStore, seedBoundEntity } from "./runJobDeps";

/** The two ERC-20 entry points this node implements, as `jobAdapter.ts` calls them. */
const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const fakeChain = defineChain({
  id: 31_337,
  name: "fake",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://node.invalid"] } },
});

/** A 32-byte word — how a node returns a `uint256` or a `bool`. */
const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

/** One state-changing call the node executed, in the order it executed them. */
export interface NodeAction {
  call: "approve" | "fund" | "createJob" | "complete" | "other";
  from: Address;
  status: "success" | "reverted";
}

export interface UsdcJobNodeOptions {
  usdc: Address;
  jobContract: Address;
  /** What a `fund` pulls. The provider's on-chain `setBudget` is faked off-chain in these tests. */
  budget: bigint;
  /** Mine the next `approve` as REVERTED: the allowance is never set. */
  revertApprove?: boolean;
  /**
   * What an `approve` actually SETS, whatever it asked for — a mis-set allowance, the state the
   * fund's own read of the chain is there to catch before anything is sent.
   */
  approveSets?: bigint;
  /**
   * Zero the allowance in the instant between the fund's pre-flight and its inclusion — the
   * incident's shape, and the one thing only a receipt can report. The steal happens once.
   */
  stealAllowanceOnFund?: boolean;
}

export function usdcJobNode(opts: UsdcJobNodeOptions) {
  const allowances = new Map<string, bigint>();
  const escrow = new Map<string, bigint>();
  /** What a node's `pending` count actually counts: transactions it has accepted, per address. */
  const acceptedCount = new Map<string, number>();
  /** `${address}:${nonce}` — a repeat is the collision the send lock exists to prevent. */
  const claimed = new Set<string>();
  const receipts = new Map<string, "0x1" | "0x0">();
  const actions: NodeAction[] = [];
  const sends: { hash: Hex; from: Address; nonce: number; to: Address }[] = [];
  let jobCounter = 0n;
  let stolen = false;

  const pairKey = (owner: string, spender: string) =>
    `${owner.toLowerCase()}:${spender.toLowerCase()}`;
  const allowanceOf = (owner: string, spender: string): bigint =>
    allowances.get(pairKey(owner, spender)) ?? 0n;

  const decode = (data: Hex | undefined) => {
    if (!data || data === "0x") return undefined;
    for (const abi of [erc20Abi, iErc8183JobAbi] as const) {
      try {
        return decodeFunctionData({ abi, data });
      } catch {
        // Not this ABI — try the next one.
      }
    }
    return undefined;
  };

  /** The read side: what `eth_call` answers, and the revert a pre-flight is supposed to catch. */
  const call = (to: Address | undefined, data: Hex | undefined): Hex => {
    const decoded = decode(data);
    const target = (to ?? "0x").toLowerCase();
    if (target === opts.usdc.toLowerCase()) {
      if (decoded?.functionName === "approve") return word(1n);
      if (decoded?.functionName === "allowance") {
        const [owner, spender] = decoded.args as [Address, Address];
        return word(allowanceOf(owner, spender));
      }
    }
    if (target === opts.jobContract.toLowerCase()) {
      if (decoded?.functionName === "createJob") return word(jobCounter + 1n);
      // `fund`, `setBudget`, `submit` and `complete` all return nothing. The fund pre-flight
      // passes while the allowance is there, which is exactly why it proves nothing about the
      // receipt: the incident's allowance disappeared after it.
      return "0x";
    }
    return "0x";
  };

  /** The write side: the state transition, and the status the receipt will carry. */
  const execute = (from: Address, to: Address, data: Hex | undefined): NodeAction => {
    const decoded = decode(data);
    if (to.toLowerCase() === opts.usdc.toLowerCase() && decoded?.functionName === "approve") {
      const [spender, amount] = decoded.args as [Address, bigint];
      if (opts.revertApprove) return { call: "approve", from, status: "reverted" };
      // SETS, never adds — the rule the two concurrent jobs fell over.
      allowances.set(pairKey(from, spender), opts.approveSets ?? amount);
      return { call: "approve", from, status: "success" };
    }
    if (to.toLowerCase() !== opts.jobContract.toLowerCase())
      return { call: "other", from, status: "success" };
    if (decoded?.functionName === "createJob") {
      jobCounter += 1n;
      return { call: "createJob", from, status: "success" };
    }
    if (decoded?.functionName === "fund") {
      const [jobId] = decoded.args as [bigint, Hex];
      if (opts.stealAllowanceOnFund && !stolen) {
        stolen = true;
        allowances.set(pairKey(from, opts.jobContract), 0n);
      }
      if (allowanceOf(from, opts.jobContract) < opts.budget)
        return { call: "fund", from, status: "reverted" };
      allowances.set(
        pairKey(from, opts.jobContract),
        allowanceOf(from, opts.jobContract) - opts.budget,
      );
      escrow.set(jobId.toString(), (escrow.get(jobId.toString()) ?? 0n) + opts.budget);
      return { call: "fund", from, status: "success" };
    }
    if (decoded?.functionName === "complete") return { call: "complete", from, status: "success" };
    return { call: "other", from, status: "success" };
  };

  const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      // viem probes this once per client; this message is the one it looks for, so it stops asking.
      case "eth_fillTransaction":
        throw new Error("eth_fillTransaction is not available");
      case "eth_blockNumber":
        return "0x1";
      case "eth_getBlockByNumber":
        return { number: "0x1", baseFeePerGas: "0x1", timestamp: "0x1", transactions: [] };
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_estimateGas":
        return "0xdbba0";
      case "eth_call": {
        const [{ to, data }] = params as [{ to?: Address; data?: Hex }];
        return call(to, data);
      }
      case "eth_getTransactionCount": {
        const address = ((params as string[])[0] ?? "").toLowerCase();
        return `0x${(acceptedCount.get(address) ?? 0).toString(16)}`;
      }
      case "eth_sendRawTransaction": {
        const raw = (params as Hex[])[0]!;
        const from = (await recoverTransactionAddress({
          serializedTransaction: raw as `0x02${string}`,
        })) as Address;
        const tx = parseTransaction(raw);
        const nonce = tx.nonce!;
        const slot = `${from.toLowerCase()}:${nonce}`;
        // The real refusal, in the real words.
        if (claimed.has(slot))
          throw new Error(`nonce too low: address ${from} already used nonce ${nonce}`);
        claimed.add(slot);
        acceptedCount.set(from.toLowerCase(), nonce + 1);
        const action = execute(from, tx.to as Address, tx.data);
        actions.push(action);
        const hash = keccak256(raw);
        receipts.set(hash, action.status === "success" ? "0x1" : "0x0");
        sends.push({ hash, from, nonce, to: tx.to as Address });
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const hash = (params as Hex[])[0]!;
        return {
          transactionHash: hash,
          status: receipts.get(hash) ?? "0x1",
          blockNumber: "0x1",
          blockHash: `0x${"11".repeat(32)}`,
          transactionIndex: "0x0",
          from: `0x${"00".repeat(20)}`,
          to: opts.jobContract,
          cumulativeGasUsed: "0x1",
          gasUsed: "0x1",
          logs: [],
          logsBloom: `0x${"0".repeat(512)}`,
          type: "0x2",
          effectiveGasPrice: "0x1",
          contractAddress: null,
        };
      }
      default:
        throw new Error(`unexpected RPC call ${method}`);
    }
  };

  const transport = custom({ request: request as never }, { retryCount: 0 });
  const publicClient = createPublicClient({ chain: fakeChain, transport }) as PublicClient;
  const sendClient = createPublicClient({ chain: fakeChain, transport }) as PublicClient;

  return {
    publicClient,
    sendClient,
    walletFor: (account: PrivateKeyAccount) =>
      createWalletClient({ account, chain: fakeChain, transport }),
    /** Every state-changing call the node executed, in execution order. */
    actions,
    /** Every transaction the node accepted: hash, signer and nonce, in acceptance order. */
    sends,
    /** What `sender` put on the wire, in order. */
    sendsFrom: (sender: Address) =>
      sends.filter((s) => s.from.toLowerCase() === sender.toLowerCase()),
    allowanceOf,
    escrowOf: (jobId: bigint) => escrow.get(jobId.toString()) ?? 0n,
  };
}

export type UsdcJobNode = ReturnType<typeof usdcJobNode>;

// ---------------------------------------------------------------------------
// THE SAGA, WIRED THE WAY THE COMPOSITION ROOT WIRES IT
//
// Real `runJob`, real `JobAdapter`, real local signers, real SQLite — over the node above. The
// per-ENTITY lock is copied from `jobs/composition.ts` deliberately: it is the serialisation the
// product actually has, and the incident is what two DIFFERENT entities do underneath it.
//
// The provider-signed steps (`setBudget`, `submit`, the sweep) are faked: they are signed by the
// per-agent enclave or by Circle, which is a different key space with a different fix.
// ---------------------------------------------------------------------------

/** anvil's published test keys — accounts #1 and #2. They sign nothing outside these tests. */
export const jobClientAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
export const evaluatorAccount = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);

export const USDC = "0x3600000000000000000000000000000000000000" as Address;
export const JOB_CONTRACT = "0x0000000000000000000000000000000000000004" as Address;
/** 0.5 USDC — the budget both jobs in the incident carried. */
export const BUDGET = 500_000n;

/** One booked outflow, as `payments/outflowMeter.ts` records it. */
export interface BookedOutflow {
  path: "job_fund";
  amountAtomic: bigint;
  ref: string | null;
}

export function jobFundHarness(
  opts: { revertApprove?: boolean; stealAllowanceOnFund?: boolean; approveSets?: bigint } = {},
) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  migrate(db);
  const jobs = new SqliteJobRepository(db);
  const entities = new SqliteEntityRepository(db);

  const node = usdcJobNode({
    usdc: USDC,
    jobContract: JOB_CONTRACT,
    budget: BUDGET,
    revertApprove: opts.revertApprove,
    stealAllowanceOnFund: opts.stealAllowanceOnFund,
    approveSets: opts.approveSets,
  });

  const adapter = new JobAdapter({
    publicClient: node.publicClient,
    clientWallet: node.walletFor(jobClientAccount),
    evaluatorWallet: node.walletFor(evaluatorAccount),
    sendClient: node.sendClient,
    jobContract: JOB_CONTRACT,
  });

  const outflows: BookedOutflow[] = [];
  /** Every provider-signed call the saga made, in order — the steps a remote signer owns. */
  const providerCalls: string[] = [];

  const deps = (input: { jobKey: string; entityKey: string }): RunJobDeps => ({
    jobKey: input.jobKey,
    entityKey: input.entityKey,
    budget: BUDGET,
    description: "demo",
    usdc: USDC,
    jobs,
    entities,
    job: adapter,
    reputation: { record: async () => `0x${"ee".repeat(32)}` } as unknown as ReputationAdapter,
    // Stops the saga at the funding boundary, which is what these tests are about: whatever
    // happened to the escrow is already persisted by the time this throws.
    worker: {
      produceDeliverable: async () => {
        throw new Error("stop after fund");
      },
    } as unknown as JobWorker,
    docStore: makeFakeDocStore(),
    outflows: {
      check: () => undefined,
      record: (path, amountAtomic, ref) => {
        outflows.push({ path, amountAtomic, ref });
      },
    },
    providerOpsFor: () => ({
      setBudget: async () => {
        providerCalls.push("setBudget");
        return `0x${"bb".repeat(32)}` as Hex;
      },
      submit: async () => {
        providerCalls.push("submit");
        return `0x${"cc".repeat(32)}` as Hex;
      },
      sweepToTreasury: async () => {
        providerCalls.push("sweep");
        return `0x${"dd".repeat(32)}` as Hex;
      },
    }),
    sweepToTreasury: false,
  });

  /** The composition's `runJob`: the saga, serialised per ENTITY. */
  const runJob = (input: { jobKey: string; entityKey: string }) =>
    withKeyedLock(input.entityKey, () => runJobSaga(deps(input)));

  const runner = new JobRunner({ jobs, runJob: (input) => runJob(input) });

  /** A bound agent plus a job already on-chain at `created`, ready for the funding step. */
  const seedCreatedJob = (p: { jobKey: string; entityKey: string; jobId: bigint }) => {
    seedBoundEntity(entities, p.entityKey, { operator: FAKE_PROVIDER_ADDRESS });
    jobs.upsert({
      jobKey: p.jobKey,
      jobId: p.jobId.toString(),
      entityKey: p.entityKey,
      ownerTenantId: undefined,
      status: "created",
      clientAddress: jobClientAccount.address as Address,
      evaluatorAddress: evaluatorAccount.address as Address,
      providerAddress: FAKE_PROVIDER_ADDRESS,
      budgetAmount: BUDGET.toString(),
      description: "demo",
      deliverableHash: null,
      deliverablePath: null,
      createTxHash: `0x${"aa".repeat(32)}` as Hex,
      fundTxHash: null,
      submitTxHash: null,
      completeTxHash: null,
      sweepTxHash: null,
      reputationTxHash: null,
      error: null,
    });
  };

  /** The persisted trail for one job: step, status and hash, in the order they were written. */
  const eventsFor = (jobKey: string) =>
    db
      .prepare("SELECT step, status, tx_hash FROM job_events WHERE job_key = ? ORDER BY rowid")
      .all(jobKey) as { step: string; status: string; tx_hash: string | null }[];

  return {
    db,
    jobs,
    entities,
    node,
    adapter,
    runJob,
    runner,
    outflows,
    providerCalls,
    seedCreatedJob,
    eventsFor,
  };
}
