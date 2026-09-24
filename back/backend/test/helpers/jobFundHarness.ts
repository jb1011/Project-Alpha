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
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { iErc8183JobAbi } from "../../src/abis/generated";
import { JobAdapter } from "../../src/adapters/arc/jobAdapter";
import type { ReputationAdapter } from "../../src/adapters/arc/reputationAdapter";
import { ChainTxRevertedError } from "../../src/errors";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { JobRunner } from "../../src/jobs/jobRunner";
import { type RecoverOutcome, recoverEscrow } from "../../src/jobs/refund";
import { type RunJobDeps, runJob as runJobSaga } from "../../src/jobs/runJob";
import { type JobWorker, TrivialWorker } from "../../src/jobs/worker";
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
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const fakeChain = defineChain({
  id: 31_337,
  name: "fake",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://node.invalid"] } },
});

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** A 32-byte word — how a node returns a `uint256` or a `bool`. */
const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

/** One state-changing call the node executed, in the order it executed them. */
export interface NodeAction {
  call: "approve" | "fund" | "createJob" | "complete" | "reject" | "claimRefund" | "other";
  from: Address;
  status: "success" | "reverted";
}

/**
 * ONE JOB AS THE CONTRACT HOLDS IT — the record a refund decision is actually made from.
 *
 * `getJob` used to answer nothing here (the node returned `0x` for every job-contract read), which
 * was enough while every test stopped at the funding boundary. It is not enough for a refund: the
 * whole point of the recovery is that the CHAIN says where the money is, so the node has to keep
 * a status, a budget and a deadline, and move them the way the contract moves them.
 */
interface ChainJob {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
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
  /**
   * Accept the first `approve` (or `fund`) and then never produce its receipt — the transaction is
   * on the chain and we cannot read what it did. Withheld ONCE, so a later job still gets answers.
   */
  withholdReceipt?: "approve" | "fund";
  /**
   * The chain's clock, in SECONDS — what the node answers as the block timestamp and what
   * `claimRefund` measures `expiredAt` against. A function, so a test can warp past an expiry
   * between two calls instead of rebuilding the node.
   */
  now?: () => number;
  /** Mine the FIRST `reject` as reverted: the escrow stays where it is, with a receipt to prove
   *  it. Once, like {withholdReceipt}, so the next attempt can be the one that works. */
  revertReject?: boolean;
  /** Mine every `complete` as REVERTED — the second way a funded job dies after its money moved. */
  revertComplete?: boolean;
}

export function usdcJobNode(opts: UsdcJobNodeOptions) {
  const allowances = new Map<string, bigint>();
  const escrow = new Map<string, bigint>();
  /** USDC held per address. The client's opening balance is what a refund has to give back. */
  const balances = new Map<string, bigint>();
  /** The job records this contract holds, by id — see {ChainJob}. */
  const chainJobs = new Map<string, ChainJob>();
  const nowSec = () => opts.now?.() ?? 1;
  /** What a node's `pending` count actually counts: transactions it has accepted, per address. */
  const acceptedCount = new Map<string, number>();
  /** `${address}:${nonce}` — a repeat is the collision the send lock exists to prevent. */
  const claimed = new Set<string>();
  const receipts = new Map<string, "0x1" | "0x0">();
  const actions: NodeAction[] = [];
  const sends: { hash: Hex; from: Address; nonce: number; to: Address }[] = [];
  let jobCounter = 0n;
  let stolen = false;
  let withheld = false;
  let rejectReverted = false;

  const pairKey = (owner: string, spender: string) =>
    `${owner.toLowerCase()}:${spender.toLowerCase()}`;
  const allowanceOf = (owner: string, spender: string): bigint =>
    allowances.get(pairKey(owner, spender)) ?? 0n;
  const balanceOf = (owner: string): bigint => balances.get(owner.toLowerCase()) ?? 0n;
  const credit = (owner: string, amount: bigint) =>
    balances.set(owner.toLowerCase(), balanceOf(owner) + amount);
  const debit = (owner: string, amount: bigint) =>
    balances.set(owner.toLowerCase(), balanceOf(owner) - amount);
  const jobOf = (jobId: bigint): ChainJob | undefined => chainJobs.get(jobId.toString());
  /** The escrow's whole movement in one place: out of the contract, back to the client. */
  const repayClient = (j: ChainJob) => {
    escrow.set(j.id.toString(), (escrow.get(j.id.toString()) ?? 0n) - j.budget);
    credit(j.client, j.budget);
  };

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
      if (decoded?.functionName === "balanceOf") {
        const [owner] = decoded.args as [Address];
        return word(balanceOf(owner));
      }
    }
    if (target === opts.jobContract.toLowerCase()) {
      if (decoded?.functionName === "createJob") return word(jobCounter + 1n);
      // THE READ THE REFUND DECISION IS MADE FROM. An unknown id answers the zero job, which is
      // what a contract with no such record answers: status 0, budget 0, nobody's client.
      if (decoded?.functionName === "getJob") {
        const [jobId] = decoded.args as [bigint];
        const j = jobOf(jobId) ?? {
          id: jobId,
          client: ZERO_ADDRESS,
          provider: ZERO_ADDRESS,
          evaluator: ZERO_ADDRESS,
          description: "",
          budget: 0n,
          expiredAt: 0n,
          status: 0,
          hook: ZERO_ADDRESS,
        };
        return encodeFunctionResult({ abi: iErc8183JobAbi, functionName: "getJob", result: j });
      }
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
      const [provider, evaluator, expiredAt, description, hook] = decoded.args as [
        Address,
        Address,
        bigint,
        string,
        Address,
      ];
      chainJobs.set(jobCounter.toString(), {
        id: jobCounter,
        client: from,
        provider,
        evaluator,
        description,
        // The provider's `setBudget` is signed by a remote key and faked off-chain in this
        // harness, so the budget arrives with the job rather than in its own transaction.
        budget: opts.budget,
        expiredAt,
        status: 0,
        hook,
      });
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
      debit(from, opts.budget);
      const funded = jobOf(jobId);
      if (funded) funded.status = 1; // Funded
      return { call: "fund", from, status: "success" };
    }
    if (decoded?.functionName === "complete") {
      if (opts.revertComplete) return { call: "complete", from, status: "reverted" };
      const [jobId] = decoded.args as [bigint, Hex, Hex];
      const j = jobOf(jobId);
      if (j) {
        j.status = 3; // Completed
        escrow.set(j.id.toString(), (escrow.get(j.id.toString()) ?? 0n) - j.budget);
        credit(j.provider, j.budget);
      }
      return { call: "complete", from, status: "success" };
    }
    // ── The two refunds, with the contract's own rules (see `test/mocks/MockERC8183Job.sol`) ──
    if (decoded?.functionName === "reject") {
      if (opts.revertReject && !rejectReverted) {
        rejectReverted = true;
        return { call: "reject", from, status: "reverted" };
      }
      const [jobId] = decoded.args as [bigint, Hex, Hex];
      const j = jobOf(jobId);
      if (!j) return { call: "reject", from, status: "reverted" };
      const sender = from.toLowerCase();
      const isClient = sender === j.client.toLowerCase();
      const isEvaluator = sender === j.evaluator.toLowerCase();
      if (isClient ? j.status !== 0 : !(isEvaluator && (j.status === 1 || j.status === 2)))
        return { call: "reject", from, status: "reverted" };
      const was = j.status;
      j.status = 4; // Rejected
      if (was === 1 || was === 2) repayClient(j);
      return { call: "reject", from, status: "success" };
    }
    if (decoded?.functionName === "claimRefund") {
      const [jobId] = decoded.args as [bigint];
      const j = jobOf(jobId);
      if (!j || (j.status !== 1 && j.status !== 2) || BigInt(nowSec()) <= j.expiredAt)
        return { call: "claimRefund", from, status: "reverted" };
      j.status = 5; // Expired
      repayClient(j);
      return { call: "claimRefund", from, status: "success" };
    }
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
        return {
          number: "0x1",
          baseFeePerGas: "0x1",
          timestamp: `0x${nowSec().toString(16)}`,
          transactions: [],
        };
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
        if (opts.withholdReceipt === action.call && !withheld) withheld = true;
        else receipts.set(hash, action.status === "success" ? "0x1" : "0x0");
        sends.push({ hash, from, nonce, to: tx.to as Address });
        return hash;
      }
      // A node knows nothing about a hash it never accepted, and says so by answering null. The
      // default used to be "success", which is a way to write a green test about a transaction
      // that never existed.
      case "eth_getTransactionByHash":
        return null;
      case "eth_getTransactionReceipt": {
        const hash = (params as Hex[])[0]!;
        const status = receipts.get(hash);
        if (!status) return null;
        return {
          transactionHash: hash,
          status,
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
    balanceOf,
    /** Put USDC in an address's hands — the client's opening balance, before it funds anything. */
    mint: (owner: Address, amount: bigint) => credit(owner, amount),
    /** The chain's own record for one job, or undefined if this contract has never heard of it. */
    chainJob: (jobId: bigint) => jobOf(jobId),
    /**
     * Put one job on the chain directly, for a saga that starts from a row already `created` —
     * or for the row a previous process left behind. A job seeded at Funded or Submitted also
     * gets its MONEY seeded: the escrow holds the budget and the client is that much poorer,
     * because the whole question a refund answers is where that budget is.
     */
    seedChainJob: (j: ChainJob) => {
      chainJobs.set(j.id.toString(), j);
      if (j.id > jobCounter) jobCounter = j.id;
      if (j.status === 1 || j.status === 2) {
        escrow.set(j.id.toString(), (escrow.get(j.id.toString()) ?? 0n) + j.budget);
        debit(j.client, j.budget);
      }
    },
    /** What the provider's remote-signed `submit` does to the chain, without signing anything. */
    markSubmitted: (jobId: bigint) => {
      const j = jobOf(jobId);
      if (j) j.status = 2; // Submitted
    },
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
/** What the job client starts with: enough for several budgets, so a refund is visible as a sum. */
export const OPENING_BALANCE = 10_000_000n;
/** The default on-chain deadline, far past the node's clock: expiry is opt-in, per test. */
export const DEFAULT_EXPIRES_AT = 9_999_999_999n;
/** The hash a reverted provider `submit` reports — a fixed value a test can name. */
export const SUBMIT_REVERT_TX_HASH = `0x${"51".repeat(32)}` as Hex;

/** One booked outflow, as `payments/outflowMeter.ts` records it. */
export interface BookedOutflow {
  path: "job_fund";
  amountAtomic: bigint;
  ref: string | null;
}

export function jobFundHarness(
  opts: {
    revertApprove?: boolean;
    stealAllowanceOnFund?: boolean;
    approveSets?: bigint;
    withholdReceipt?: "approve" | "fund";
    /** The adapter's bound on a receipt wait. Milliseconds, so a timeout test is not a minute. */
    receiptTimeoutMs?: number;
    /**
     * Configure a DISTINCT evaluator key (the default). `false` is the deployment with no
     * `JOB_EVALUATOR_PRIVATE_KEY`, where the evaluator address IS the client's and "the evaluator
     * rejects" is impossible on chain — so the only refund left is the expiry one.
     */
    evaluator?: boolean;
    /**
     * WHERE THE SAGA DIES, AFTER THE MONEY IS ALREADY IN THE ESCROW.
     *  - `worker` (the default) — the deliverable step throws, which is the shape the funding
     *    tests were written against and what keeps them measuring the funding boundary alone.
     *  - `submit` — the provider's remote-signed submit reverts on chain.
     *  - `complete` — submit lands and the evaluator's complete reverts instead.
     */
    failAt?: "worker" | "submit" | "complete";
    /** Mine the FIRST of the recovery's rejects as reverted: the escrow stays put, with a
     *  receipt. The attempt after it is allowed to work, which is what the next boot does. */
    revertReject?: boolean;
    /**
     * WIRE THE ESCROW RECOVERY INTO THE SAGA, as `jobs/composition.ts` always does in production.
     *
     * OFF by default, and deliberately: the funding tests stop their saga with a worker that
     * throws, and a recovery firing there would rewrite what they measure (the escrow after a
     * fund) into something else (the escrow after a refund). The tests that are ABOUT the
     * recovery turn it on; what holds PRODUCTION to wiring it is
     * `test/jobs/composition.test.ts`, not a default in a test helper.
     */
    recoverEscrow?: boolean;
    /** The chain's clock in seconds, shared by the node and the recovery's expiry decision. */
    now?: () => number;
  } = {},
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
    withholdReceipt: opts.withholdReceipt,
    now: opts.now,
    revertReject: opts.revertReject,
    revertComplete: opts.failAt === "complete",
  });
  // The client pays the escrow out of its own USDC, so it has to have some: a refund is measured
  // by this balance coming back.
  node.mint(jobClientAccount.address as Address, OPENING_BALANCE);

  const adapter = new JobAdapter({
    publicClient: node.publicClient,
    clientWallet: node.walletFor(jobClientAccount),
    // No distinct evaluator key = the composition's fallback, where the evaluator is the client.
    evaluatorWallet: opts.evaluator === false ? undefined : node.walletFor(evaluatorAccount),
    sendClient: node.sendClient,
    jobContract: JOB_CONTRACT,
    receiptTimeoutMs: opts.receiptTimeoutMs,
  });
  const evaluatorAddress = (
    opts.evaluator === false ? jobClientAccount.address : evaluatorAccount.address
  ) as Address;
  /** Every outcome the recovery reported, in order — one per call, as the reconcile logs them. */
  const recoveries: RecoverOutcome[] = [];
  const refundJob = async (jobKey: string): Promise<RecoverOutcome> => {
    const outcome = await recoverEscrow({ jobs, job: adapter, now: opts.now }, jobKey);
    recoveries.push(outcome);
    return outcome;
  };

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
    // Stops the saga at the funding boundary, which is what most of these tests are about:
    // whatever happened to the escrow is already persisted by the time this throws. `failAt`
    // moves the failure further down, to the two steps that fail AFTER the money moved.
    worker: (opts.failAt && opts.failAt !== "worker"
      ? new TrivialWorker()
      : {
          produceDeliverable: async () => {
            throw new Error("stop after fund");
          },
        }) as unknown as JobWorker,
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
      submit: async (jobId) => {
        providerCalls.push("submit");
        // The real thing is signed by a remote key (the enclave or Circle) and this harness does
        // not sign it — but it DOES move the chain, so the double moves the chain too. Without
        // that, a refund decision would read Funded for a job the contract has at Submitted.
        if (opts.failAt === "submit")
          throw new ChainTxRevertedError("submit", SUBMIT_REVERT_TX_HASH);
        node.markSubmitted(jobId);
        return `0x${"cc".repeat(32)}` as Hex;
      },
      sweepToTreasury: async () => {
        providerCalls.push("sweep");
        return `0x${"dd".repeat(32)}` as Hex;
      },
    }),
    sweepToTreasury: false,
    recoverEscrow: opts.recoverEscrow ? refundJob : undefined,
  });

  /** The composition's `runJob`: the saga, serialised per ENTITY. */
  const runJob = (input: { jobKey: string; entityKey: string }) =>
    withKeyedLock(input.entityKey, () => runJobSaga(deps(input)));

  const runner = new JobRunner({
    jobs,
    runJob: (input) => runJob(input),
    recoverEscrow: opts.recoverEscrow ? refundJob : undefined,
  });

  /** A bound agent plus a job already on-chain at `created`, ready for the funding step. */
  const seedCreatedJob = (p: {
    jobKey: string;
    entityKey: string;
    jobId: bigint;
    /** When the on-chain job expires, in seconds. Default: far beyond any test's clock. */
    expiredAt?: bigint;
  }) => {
    seedBoundEntity(entities, p.entityKey, { operator: FAKE_PROVIDER_ADDRESS });
    // The contract's side of the same job, at Open with its budget set — the state a real
    // `createJob` + provider `setBudget` leaves behind.
    node.seedChainJob({
      id: p.jobId,
      client: jobClientAccount.address as Address,
      provider: FAKE_PROVIDER_ADDRESS,
      evaluator: evaluatorAddress,
      description: "demo",
      budget: BUDGET,
      expiredAt: p.expiredAt ?? DEFAULT_EXPIRES_AT,
      status: 0,
      hook: ZERO_ADDRESS,
    });
    jobs.upsert({
      jobKey: p.jobKey,
      jobId: p.jobId.toString(),
      entityKey: p.entityKey,
      ownerTenantId: undefined,
      status: "created",
      clientAddress: jobClientAccount.address as Address,
      evaluatorAddress,
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
      refundTxHash: null,
      escrowState: null,
      error: null,
    });
  };

  /**
   * THE ROW A PREVIOUS PROCESS LEFT BEHIND: `failed`, funded, and never refunded.
   *
   * This is what the boot reconcile finds, and the only way to write a test about a chain state
   * our own saga cannot produce in one run — an escrow somebody else already rejected, or a job
   * the evaluator completed after we gave up on it.
   */
  const seedFailedFundedJob = (p: {
    jobKey: string;
    entityKey: string;
    jobId: bigint;
    /** The status the CONTRACT has this job at. Our row says nothing about it. */
    chainStatus: number;
    expiredAt?: bigint;
    error?: string;
  }) => {
    seedBoundEntity(entities, p.entityKey, { operator: FAKE_PROVIDER_ADDRESS });
    node.seedChainJob({
      id: p.jobId,
      client: jobClientAccount.address as Address,
      provider: FAKE_PROVIDER_ADDRESS,
      evaluator: evaluatorAddress,
      description: "demo",
      budget: BUDGET,
      expiredAt: p.expiredAt ?? DEFAULT_EXPIRES_AT,
      status: p.chainStatus,
      hook: ZERO_ADDRESS,
    });
    jobs.upsert({
      jobKey: p.jobKey,
      jobId: p.jobId.toString(),
      entityKey: p.entityKey,
      ownerTenantId: undefined,
      status: "failed",
      clientAddress: jobClientAccount.address as Address,
      evaluatorAddress,
      providerAddress: FAKE_PROVIDER_ADDRESS,
      budgetAmount: BUDGET.toString(),
      description: "demo",
      deliverableHash: null,
      deliverablePath: null,
      createTxHash: `0x${"aa".repeat(32)}` as Hex,
      fundTxHash: `0x${"f7".repeat(32)}` as Hex,
      submitTxHash: null,
      completeTxHash: null,
      sweepTxHash: null,
      reputationTxHash: null,
      refundTxHash: null,
      escrowState: null,
      error: p.error ?? "died after funding",
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
    seedFailedFundedJob,
    eventsFor,
    evaluatorAddress,
    /** Call the recovery by hand — what the MCP tool and the CLI do. */
    refundJob,
    /** Every outcome the recovery reported, in the order it reported them. */
    recoveries,
  };
}
