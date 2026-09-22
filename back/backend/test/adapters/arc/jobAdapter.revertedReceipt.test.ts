/**
 * EVERY RECEIPT THESE TWO ADAPTERS WAIT FOR IS READ, NOT JUST AWAITED.
 *
 * `waitForTransactionReceipt` resolves for a transaction that REVERTED — viem hands back a receipt
 * whose `status` is `"reverted"` and throws nothing. Both adapters awaited one and then returned
 * the hash as if it had worked, so every caller above them recorded a success: on 2026-09-22 that
 * booked half a USDC of escrow that had never left the wallet.
 *
 * The table below is the guard, and a new send has to be ADDED to it to be watched: a site that
 * never appears here is a site whose receipt can go back to being ignored without a test noticing.
 * `approveAndFund` gets its own pair of cases because its failure is named for the job and the
 * step, which is what the saga turns into the sentence a founder reads.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import { JobAdapter } from "../../../src/adapters/arc/jobAdapter";
import { ReputationAdapter } from "../../../src/adapters/arc/reputationAdapter";
import { resetSenderNonces } from "../../../src/adapters/arc/senderLock";

const CLIENT = "0x00000000000000000000000000000000000000c1" as Address;
const EVALUATOR = "0x00000000000000000000000000000000000000e1" as Address;
const PROVIDER = "0x00000000000000000000000000000000000000d1" as Address;
const TREASURY = "0x00000000000000000000000000000000000000dd" as Address;
const JOB_CONTRACT = "0x0000000000000000000000000000000000000004" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000005" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const REASON = `0x${"00".repeat(32)}` as Hex;
const DELIVERABLE = `0x${"11".repeat(32)}` as Hex;
const FEEDBACK = `0x${"ab".repeat(32)}` as Hex;

/** The hash the n-th broadcast of a run comes back as — distinct, so a message can name one. */
const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/**
 * Adapters over a node that mines everything and reverts everything: one receipt shape, every
 * send path, so the only thing a case can differ in is what the adapter does about it.
 */
function makeAdapters(opts: { receipts?: ("success" | "reverted")[] } = {}) {
  let broadcasts = 0;
  let receiptsRead = 0;
  /** The status the n-th receipt carries; the last entry answers every later read. */
  const statusOf = () => {
    const seq = opts.receipts ?? ["reverted"];
    return seq[Math.min(receiptsRead++, seq.length - 1)]!;
  };
  const wallet = (address: Address) =>
    ({
      account: {
        address,
        source: "privateKey",
        signTransaction: vi.fn(async () => "0xsigned" as Hex),
      },
      chain: { id: 31_337 },
      prepareTransactionRequest: vi.fn(async (r: Record<string, unknown>) => ({ ...r })),
      // The remote-signer path (`setBudget`, `submit`, `transferUsdc`): the caller's wallet signs
      // and broadcasts in one call.
      writeContract: vi.fn(async () => hashOf(++broadcasts)),
    }) as unknown as WalletClient;

  const publicClient = {
    simulateContract: vi.fn(async () => ({ result: 3n, request: { marker: "sim-request" } })),
    // An allowance that covers anything, so the only refusal in this file is the receipt's.
    readContract: vi.fn(async () => 2n ** 255n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: statusOf(), logs: [] })),
  } as unknown as PublicClient;

  const sendClient = {
    getTransactionCount: vi.fn(async () => 0),
    sendRawTransaction: vi.fn(async () => hashOf(++broadcasts)),
  };

  const clientWallet = wallet(CLIENT);
  const evaluatorWallet = wallet(EVALUATOR);
  return {
    job: new JobAdapter({
      publicClient,
      clientWallet,
      evaluatorWallet,
      sendClient,
      jobContract: JOB_CONTRACT,
    }),
    reputation: new ReputationAdapter({
      publicClient,
      recorderWallet: evaluatorWallet,
      sendClient,
      registry: REGISTRY,
    }),
    providerWallet: wallet(PROVIDER),
    /** Every broadcast that reached the node, so a test can prove a second one never did. */
    broadcasts: () => sendClient.sendRawTransaction.mock.calls.length,
  };
}

type Adapters = ReturnType<typeof makeAdapters>;

/** Every receipt these adapters wait for, and the step its refusal names. */
const receiptSites: { name: string; step: string; run: (a: Adapters) => Promise<unknown> }[] = [
  {
    name: "createJob",
    step: "createJob",
    run: (a) =>
      a.job.createJob({
        provider: PROVIDER,
        evaluator: EVALUATOR,
        expiredAt: 9_999_999_999n,
        description: "demo",
      }),
  },
  {
    name: "setBudget",
    step: "setBudget",
    run: (a) => a.job.setBudget(3n, 500_000n, a.providerWallet),
  },
  { name: "submit", step: "submit", run: (a) => a.job.submit(3n, DELIVERABLE, a.providerWallet) },
  { name: "complete", step: "complete", run: (a) => a.job.complete(3n, REASON) },
  {
    name: "transferUsdc",
    step: "transferUsdc",
    run: (a) => a.job.transferUsdc(a.providerWallet, USDC, TREASURY, 250_000n),
  },
  {
    name: "the reputation record",
    step: "giveFeedback",
    run: (a) => a.reputation.record({ agentId: 7n, value: 100, feedbackHash: FEEDBACK }),
  },
];

beforeEach(() => resetSenderNonces());

test.each(receiptSites)(
  "$name refuses a reverted receipt and names its step",
  async ({ step, run }) => {
    await expect(run(makeAdapters())).rejects.toThrow(
      `${step} reverted on chain (${hashOf(1)}) — the transaction was mined and its effects were rolled back`,
    );
  },
);

test("a reverted approve names the approve step and the job, and sends no fund", async () => {
  const a = makeAdapters();
  await expect(a.job.approveAndFund(3n, USDC, 500_000n)).rejects.toThrow(
    `the escrow funding for job 3 failed at the approve step (${hashOf(1)}): the transaction reverted on chain. The job was not funded and nothing was charged.`,
  );
  // The approve, and nothing after it: an allowance that was never set is the end of the step.
  expect(a.broadcasts()).toBe(1);
});

test("a reverted fund names the fund step and the job", async () => {
  // The approve is mined and successful; only the second receipt reverts — the incident's order.
  const a = makeAdapters({ receipts: ["success", "reverted"] });
  await expect(a.job.approveAndFund(3n, USDC, 500_000n)).rejects.toThrow(
    `the escrow funding for job 3 failed at the fund step (${hashOf(2)}): the transaction reverted on chain. The job was not funded and nothing was charged.`,
  );
});
