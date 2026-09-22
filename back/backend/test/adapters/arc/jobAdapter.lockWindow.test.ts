/**
 * WHAT THE JOB KEYS PUT ON THE WIRE, AND WHEN — measured through real viem clients, real local
 * accounts and a transport that behaves like a node: it counts nonces per address and REFUSES a
 * nonce it has already accepted.
 *
 * The twin of `arcAdapter.lockWindow.test.ts`, for the other two keys that sign in this process.
 * Three questions, and the fake node is what makes them answerable:
 *  - the WINDOW: exactly two RPCs happen while a job key's lock is held — read the pending nonce,
 *    hand over the signed bytes. The pre-flight, the gas and the fees are before it; the receipt
 *    wait is after it, or one stuck transaction stops every job this key has.
 *  - the NONCES: concurrent sends from one key are numbered consecutively, and the node's duplicate
 *    rejection is the proof — it is the same refusal a real node answers with, and the defect used
 *    to trigger it.
 *  - the BYTES: to, calldata, value, gas, nonce, chain id and both fee fields, decoded and asserted
 *    exactly. These are the numbers the unlocked `writeContract` path produced, so moving the send
 *    under the lock has to leave them alone.
 *
 * And one property that only two keys can show: a job send and a platform send DO NOT block each
 * other. The lock is keyed by signer address, so two keys are two nonce spaces — a fund stuck
 * mid-broadcast must not hold up a job.
 */
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, expect, test, vi } from "vitest";
import { iErc8183JobAbi, reputationRegistryAbi } from "../../../src/abis/generated";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import { JobAdapter } from "../../../src/adapters/arc/jobAdapter";
import { ReputationAdapter } from "../../../src/adapters/arc/reputationAdapter";
import { resetSenderNonces, senderLockHeld } from "../../../src/adapters/arc/senderLock";

/** anvil's published test keys — accounts #1, #2 and #3. No secret here. */
const jobClient = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const evaluator = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const platform = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);

const JOB_CONTRACT = "0x0000000000000000000000000000000000000004" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000005" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const PROVIDER = "0x00000000000000000000000000000000000000d1" as Address;
const SEED_TO = "0x00000000000000000000000000000000000000dd" as Address;
const REASON = `0x${"00".repeat(32)}` as Hex;
const FEEDBACK = `0x${"ab".repeat(32)}` as Hex;

const chain = defineChain({
  id: 31_337,
  name: "fake",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://node.invalid"] } },
});

const TRUE_WORD = `0x${"0".repeat(63)}1` as Hex;
/** THE WINDOW: two calls, in this order, and nothing else. */
const THE_WINDOW = ["eth_getTransactionCount", "eth_sendRawTransaction"];

const signers = [jobClient.address, evaluator.address, platform.address] as Address[];

/**
 * One fake node behind every client here, so the two adapters share a chain the way they share one.
 *
 * `holdPlatformSend` is the only asymmetry: a platform broadcast parks inside its own lock until the
 * test releases it, which is how "a stuck fund does not stop a job" is measured rather than argued.
 */
function node(opts: { holdPlatformSend?: boolean } = {}) {
  const calls: { method: string; lockedFor?: Address }[] = [];
  const sent: Hex[] = [];
  /** Accepted transactions per address — what a node's `pending` count actually counts. */
  const accepted = new Map<string, number>();
  /** `${address}:${nonce}` for every nonce the node has taken. A repeat is the defect. */
  const claimed = new Set<string>();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    calls.push({ method, lockedFor: signers.find((s) => senderLockHeld(s)) });
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      // viem probes this once per client before falling back to the individual calls; the message
      // is the one it looks for, so it stops asking.
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
      case "eth_call":
        return TRUE_WORD;
      case "eth_getTransactionCount": {
        const address = ((params as string[])[0] ?? "").toLowerCase();
        return `0x${(accepted.get(address) ?? 0).toString(16)}`;
      }
      case "eth_sendRawTransaction": {
        const raw = (params as Hex[])[0]!;
        // Who signed these bytes — the node's own question, and the only honest way to key a
        // per-address nonce ledger when several keys share one transport.
        const from = (
          await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })
        ).toLowerCase();
        if (opts.holdPlatformSend && from === platform.address.toLowerCase()) await gate;
        const nonce = parseTransaction(raw).nonce!;
        // The real refusal, in the real words: a node that already has this nonce from this sender
        // does not take a second transaction for it.
        if (claimed.has(`${from}:${nonce}`))
          throw new Error(`nonce too low: address ${from} already used nonce ${nonce}`);
        claimed.add(`${from}:${nonce}`);
        accepted.set(from, nonce + 1);
        sent.push(raw);
        return keccak256(raw);
      }
      case "eth_getTransactionReceipt": {
        const hash = (params as Hex[])[0]!;
        return {
          transactionHash: hash,
          status: "0x1",
          blockNumber: "0x1",
          blockHash: `0x${"11".repeat(32)}`,
          transactionIndex: "0x0",
          from: jobClient.address,
          to: JOB_CONTRACT,
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
  });

  const transport = custom({ request: request as never }, { retryCount: 0 });
  const publicClient = createPublicClient({ chain, transport });
  const sendClient = createPublicClient({ chain, transport });
  const job = new JobAdapter({
    publicClient,
    clientWallet: createWalletClient({ account: jobClient, chain, transport }),
    evaluatorWallet: createWalletClient({ account: evaluator, chain, transport }),
    sendClient,
    jobContract: JOB_CONTRACT,
  });
  const reputation = new ReputationAdapter({
    publicClient,
    recorderWallet: createWalletClient({ account: evaluator, chain, transport }),
    sendClient,
    registry: REGISTRY,
  });
  const arc = new ArcAdapter({
    publicClient,
    managerWallet: createWalletClient({ account: platform, chain, transport }),
    sendClient,
    chainId: chain.id,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });

  return {
    job,
    reputation,
    arc,
    calls,
    sent,
    /** The RPC methods issued while THIS signer's lock was held, in order. */
    inLock: (signer: Address) =>
      calls.filter((c) => c.lockedFor?.toLowerCase() === signer.toLowerCase()).map((c) => c.method),
    /** Every send that went out, decoded. */
    txs: () => sent.map((raw) => parseTransaction(raw)),
    releasePlatformSend: () => release?.(),
  };
}

type Node = ReturnType<typeof node>;

const createJob = (n: Node) =>
  n.job.createJob({
    provider: PROVIDER,
    evaluator: evaluator.address as Address,
    expiredAt: 9_999_999_999n,
    description: "demo",
  });

/** Every send the two job adapters make from a key configured in this process. */
const kinds: {
  name: string;
  signer: Address;
  sends: number;
  run: (n: Node) => Promise<unknown>;
}[] = [
  { name: "createJob", signer: jobClient.address as Address, sends: 1, run: createJob },
  {
    name: "approveAndFund",
    signer: jobClient.address as Address,
    sends: 2,
    run: (n) => n.job.approveAndFund(3n, USDC, 500_000n),
  },
  {
    name: "complete",
    signer: evaluator.address as Address,
    sends: 1,
    run: (n) => n.job.complete(3n, REASON),
  },
  {
    name: "record",
    signer: evaluator.address as Address,
    sends: 1,
    run: (n) => n.reputation.record({ agentId: 7n, value: 100, feedbackHash: FEEDBACK }),
  },
];

beforeEach(() => resetSenderNonces());

test.each(kinds)(
  "$name holds the lock for exactly the nonce read and the raw send",
  async ({ signer, sends, run }) => {
    const n = node();
    await run(n);
    expect(n.inLock(signer)).toEqual(Array.from({ length: sends }, () => THE_WINDOW).flat());
    // The pre-flight that decides whether anything is sent at all, and the gas and fee estimation,
    // all happened with no lock held by anybody.
    for (const method of ["eth_call", "eth_estimateGas", "eth_getBlockByNumber"])
      expect(n.calls.filter((c) => c.method === method).every((c) => !c.lockedFor)).toBe(true);
    // Nothing else is signed by anybody else.
    expect(n.txs()).toHaveLength(sends);
  },
);

test("concurrent job-client sends are numbered consecutively — the node rejects nothing", async () => {
  // Five sends from one key against a node whose count only moves when it accepts a transaction.
  // Unlocked, they all read the same 0 and four of the five are refused `nonce too low`.
  const n = node();
  await Promise.all([
    createJob(n),
    n.job.approveAndFund(3n, USDC, 1n),
    createJob(n),
    n.job.approveAndFund(4n, USDC, 2n),
  ]);
  const nonces = n.txs().map((t) => t.nonce);
  expect(nonces).toEqual([0, 1, 2, 3, 4, 5]);
  expect(new Set(nonces).size).toBe(6);
});

test("a job send and a platform send from a DIFFERENT key do not block each other", async () => {
  // Two keys are two nonce spaces, and the lock is keyed by address — so a platform broadcast that
  // parks inside its own lock (a throttled endpoint, a hung socket) must not hold up a job.
  const n = node({ holdPlatformSend: true });
  const stuck = n.arc.sendNativeAsPlatform(SEED_TO, 10n);
  // Let the platform send reach its broadcast and park there, still holding its own lock.
  await new Promise((r) => setTimeout(r, 5));
  expect(n.inLock(platform.address as Address)).toEqual(THE_WINDOW);
  expect(n.txs()).toHaveLength(0); // parked: the node has taken nothing yet

  await expect(createJob(n)).resolves.toMatchObject({ jobId: 1n });
  expect(n.inLock(jobClient.address as Address)).toEqual(THE_WINDOW);

  n.releasePlatformSend();
  await expect(stuck).resolves.toMatch(/^0x/);
  // Each key started from its own zero: the nonces do not interleave.
  expect(n.txs().map((t) => t.nonce)).toEqual([0, 0]);
});

// ── THE BYTES. Everything a transaction commits to, for every kind, unchanged by the lock ──────

/** The fee fields every send here carries: `eth_maxPriorityFeePerGas` = 1, base fee = 1. */
const FEES = { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
/** viem's `eth_estimateGas` answer above — the estimate, taken outside the lock. */
const ESTIMATED_GAS = 0xdbba0n;

const decoded = (t: ReturnType<Node["txs"]>[number]) => ({
  to: t.to?.toLowerCase(),
  data: t.data,
  value: t.value,
  gas: t.gas,
  nonce: t.nonce,
  chainId: t.chainId,
  maxFeePerGas: t.maxFeePerGas,
  maxPriorityFeePerGas: t.maxPriorityFeePerGas,
});

const base = { value: undefined, gas: ESTIMATED_GAS, chainId: chain.id, ...FEES };

test("createJob signs exactly the transaction the unlocked path signed", async () => {
  const n = node();
  await createJob(n);
  expect(decoded(n.txs()[0]!)).toEqual({
    ...base,
    nonce: 0,
    to: JOB_CONTRACT.toLowerCase(),
    data: encodeFunctionData({
      abi: iErc8183JobAbi,
      functionName: "createJob",
      args: [
        PROVIDER,
        evaluator.address,
        9_999_999_999n,
        "demo",
        "0x0000000000000000000000000000000000000000",
      ],
    }),
  });
});

test("approveAndFund signs exactly the two transactions the unlocked path signed", async () => {
  const n = node();
  await n.job.approveAndFund(3n, USDC, 500_000n);
  const [approve, fund] = n.txs();
  expect(decoded(approve!)).toEqual({
    ...base,
    nonce: 0,
    to: USDC.toLowerCase(),
    data: encodeFunctionData({
      abi: [
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
      ] as const,
      functionName: "approve",
      args: [JOB_CONTRACT, 500_000n],
    }),
  });
  expect(decoded(fund!)).toEqual({
    ...base,
    nonce: 1,
    to: JOB_CONTRACT.toLowerCase(),
    data: encodeFunctionData({ abi: iErc8183JobAbi, functionName: "fund", args: [3n, "0x"] }),
  });
});

test("complete signs exactly the transaction the unlocked path signed", async () => {
  const n = node();
  await n.job.complete(3n, REASON);
  expect(decoded(n.txs()[0]!)).toEqual({
    ...base,
    nonce: 0,
    to: JOB_CONTRACT.toLowerCase(),
    data: encodeFunctionData({
      abi: iErc8183JobAbi,
      functionName: "complete",
      args: [3n, REASON, "0x"],
    }),
  });
});

test("the reputation record signs exactly the transaction the unlocked path signed", async () => {
  const n = node();
  await n.reputation.record({ agentId: 7n, value: 100, feedbackHash: FEEDBACK });
  expect(decoded(n.txs()[0]!)).toEqual({
    ...base,
    nonce: 0,
    to: REGISTRY.toLowerCase(),
    data: encodeFunctionData({
      abi: reputationRegistryAbi,
      functionName: "giveFeedback",
      args: [7n, 100n, 0, "job", "", "", "", FEEDBACK],
    }),
  });
});
