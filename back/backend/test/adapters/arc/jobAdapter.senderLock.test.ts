/**
 * THE GUARD, for the keys the JOB path signs with: the job client and the evaluator/recorder.
 *
 * #142 closed this for the platform key (`arcAdapter.senderLock.test.ts`, whose shape this file
 * copies). The job side kept sending through `walletClient.writeContract`, which signs AND
 * broadcasts in one call and reads its own nonce on the way — so two jobs started in the same
 * moment, or a job step racing another, signed the same number and one of the two transactions was
 * rejected or replaced.
 *
 * The wallet clients handed to the adapters here REFUSE three things, and each refusal is one way
 * the defect comes back:
 *  - a send that reaches `writeContract` at all — that is the unlocked path, whatever it carries;
 *  - a signature or a broadcast taken without this signer's lock held;
 *  - a transaction with no explicit nonce, which is a nonce viem read outside our ledger, where the
 *    floor that protects us from a stale node answer can never see it.
 *
 * So this file fails for any job/recorder send that forgets the chokepoint, including one added
 * later. No chain: the node is a counter per address, the receipt is a resolved promise.
 *
 * ⚠ NOT COVERED, deliberately: `setBudget`, `submit` and `transferUsdc` take the wallet from their
 * CALLER (the per-agent Turnkey enclave, or Circle). Those accounts sign over a network, and a
 * remote signature inside the lock is the one thing `senderLock.ts` forbids putting there. They
 * are a different key space with a different fix, and they are out of this file's scope.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import { JobAdapter } from "../../../src/adapters/arc/jobAdapter";
import { ReputationAdapter } from "../../../src/adapters/arc/reputationAdapter";
import { resetSenderNonces, senderLockHeld } from "../../../src/adapters/arc/senderLock";

const CLIENT = "0x00000000000000000000000000000000000000c1" as Address;
const EVALUATOR = "0x00000000000000000000000000000000000000e1" as Address;
const PROVIDER = "0x00000000000000000000000000000000000000d1" as Address;
const JOB_CONTRACT = "0x0000000000000000000000000000000000000004" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000005" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const FEEDBACK = `0x${"ab".repeat(32)}` as Hex;
const REASON = `0x${"00".repeat(32)}` as Hex;

/** Every send the fake wallets accept, in the order the node saw them. */
type Sent = { signer: Address; via: "signTransaction" | "sendRawTransaction"; nonce: number };

function makeAdapters() {
  const sent: Sent[] = [];
  /** Was the lock held while the slow half (gas, fees, chain id) ran? It must not be. */
  const preparedInLock: boolean[] = [];
  /** The node's pending count, per address: one nonce space per key, as the chain has it. */
  const pending = new Map<string, number>();
  /** The transaction signed most recently — what the raw bytes handed over next would carry. */
  let lastSigned: { signer: Address; nonce: number } | undefined;

  const accept = (signer: Address, via: Sent["via"], nonce: unknown): Hex => {
    if (!senderLockHeld(signer)) throw new Error(`${via} from ${signer} happened unlocked`);
    if (typeof nonce !== "number")
      throw new Error(`${via} carried no explicit nonce (viem would pick its own)`);
    sent.push({ signer, via, nonce });
    return `0x${(nonce + 1).toString(16).padStart(64, "0")}` as Hex;
  };

  const wallet = (address: Address) =>
    ({
      account: {
        address,
        // Signing is offline and inside the lock — and it is where the nonce becomes part of the
        // transaction, so this is one of the two places the invariant has to hold.
        signTransaction: vi.fn(async (r: { nonce?: number }) => {
          const hash = accept(address, "signTransaction", r.nonce);
          lastSigned = { signer: address, nonce: r.nonce as number };
          return hash;
        }),
      },
      chain: { id: 31_337 },
      // The UNLOCKED half: gas, fees and the chain id are node round trips, and every other send
      // from this key would queue behind them.
      prepareTransactionRequest: vi.fn(async (r: Record<string, unknown>) => {
        preparedInLock.push(senderLockHeld(address));
        return { ...r, marker: "prepared" };
      }),
      // THE OLD PATH. `writeContract` signs and broadcasts in one call and numbers the transaction
      // itself, so reaching it is the defect — there is nothing to inspect afterwards.
      writeContract: vi.fn(async () => {
        throw new Error(
          `writeContract reached the wallet client for ${address}: this send skipped the lock and left its nonce to viem`,
        );
      }),
    }) as unknown as WalletClient;

  const clientWallet = wallet(CLIENT);
  const evaluatorWallet = wallet(EVALUATOR);

  /** Was the lock still held while a receipt was awaited? It must never be. */
  const receiptWaitsInLock: (Address | undefined)[] = [];
  const publicClient = {
    // `result` is the jobId createJob reads back; `request` is what the old path forwarded.
    simulateContract: vi.fn(async () => ({ result: 3n, request: { marker: "sim-request" } })),
    waitForTransactionReceipt: vi.fn(async () => {
      receiptWaitsInLock.push(
        [CLIENT, EVALUATOR].find((a) => senderLockHeld(a)) as Address | undefined,
      );
      return { status: "success", logs: [] };
    }),
  } as unknown as PublicClient;

  /** The bounded client (`clients.ts`): the two calls that happen inside the lock, and no others. */
  const sendClient = {
    getTransactionCount: vi.fn(async ({ address }: { address: Address; blockTag: "pending" }) => {
      if (!senderLockHeld(address)) throw new Error(`the nonce for ${address} was read unlocked`);
      return pending.get(address.toLowerCase()) ?? 0;
    }),
    sendRawTransaction: vi.fn(async () => {
      const signed = lastSigned!;
      const hash = accept(signed.signer, "sendRawTransaction", signed.nonce);
      pending.set(signed.signer.toLowerCase(), signed.nonce + 1);
      return hash;
    }),
  };

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
    sent,
    preparedInLock,
    receiptWaitsInLock,
    broadcasts: () => sent.filter((s) => s.via === "sendRawTransaction"),
  };
}

type Adapters = ReturnType<typeof makeAdapters>;

/** Every send these two adapters make from a key this deployment configures. */
const sendPaths: {
  name: string;
  signer: Address;
  /** How many transactions the call puts on the wire. */
  sends: number;
  run: (a: Adapters) => Promise<unknown>;
}[] = [
  {
    name: "createJob",
    signer: CLIENT,
    sends: 1,
    run: (a) =>
      a.job.createJob({
        provider: PROVIDER,
        evaluator: EVALUATOR,
        expiredAt: 9_999_999_999n,
        description: "demo",
      }),
  },
  {
    name: "approveAndFund",
    signer: CLIENT,
    sends: 2,
    run: (a) => a.job.approveAndFund(3n, USDC, 500_000n),
  },
  { name: "complete", signer: EVALUATOR, sends: 1, run: (a) => a.job.complete(3n, REASON) },
  {
    name: "record",
    signer: EVALUATOR,
    sends: 1,
    run: (a) => a.reputation.record({ agentId: 7n, value: 100, feedbackHash: FEEDBACK }),
  },
];

beforeEach(() => resetSenderNonces());

test.each(sendPaths)(
  "$name sends under $signer's lock, with an explicit nonce",
  async ({ signer, sends, run }) => {
    const a = makeAdapters();
    await run(a);
    // One signature and one broadcast per transaction, both under the lock, in that order.
    expect(a.sent.map((s) => s.via)).toEqual(
      Array.from({ length: sends }, () => ["signTransaction", "sendRawTransaction"]).flat(),
    );
    // …every one of them from the key this call belongs to…
    expect(new Set(a.sent.map((s) => s.signer.toLowerCase()))).toEqual(
      new Set([signer.toLowerCase()]),
    );
    // …numbered consecutively from the node's count…
    expect(a.broadcasts().map((s) => s.nonce)).toEqual(Array.from({ length: sends }, (_, i) => i));
    // …and the slow half happened before the lock was taken, every time.
    expect(a.preparedInLock).toEqual(Array.from({ length: sends }, () => false));
  },
);

test("concurrent job-client sends get distinct consecutive nonces", async () => {
  // The defect at the level it was reported: the node answers the same count to every reader until
  // one of our transactions mines. Four sends from one key, four nonces.
  const a = makeAdapters();
  await Promise.all([
    a.job.createJob({
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: 9_999_999_999n,
      description: "one",
    }),
    a.job.approveAndFund(3n, USDC, 1n),
    a.job.createJob({
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: 9_999_999_999n,
      description: "two",
    }),
  ]);
  const nonces = a.broadcasts().map((s) => s.nonce);
  expect(nonces).toEqual([0, 1, 2, 3]);
  expect(new Set(nonces).size).toBe(4);
});

test("the evaluator's two send paths share ONE nonce ledger", async () => {
  // `complete` and the reputation `record` are signed by the same key (see `jobs/composition.ts`:
  // the recorder IS the evaluator wallet when one is configured). One key is one nonce space, and
  // the lock is keyed by address, so they serialise against each other without anyone arranging it.
  const a = makeAdapters();
  await Promise.all([
    a.job.complete(3n, REASON),
    a.reputation.record({ agentId: 7n, value: 100, feedbackHash: FEEDBACK }),
  ]);
  expect(a.broadcasts().map((s) => s.nonce)).toEqual([0, 1]);
  expect(a.broadcasts().every((s) => s.signer.toLowerCase() === EVALUATOR.toLowerCase())).toBe(
    true,
  );
});

test.each(sendPaths)("$name waits for its receipt OUTSIDE the lock", async ({ sends, run }) => {
  // A lock held across a receipt wait would stop every other send from that key for as long as the
  // chain takes — and forever on a transaction the mempool dropped.
  const a = makeAdapters();
  await run(a);
  expect(a.receiptWaitsInLock).toEqual(Array.from({ length: sends }, () => undefined));
});
