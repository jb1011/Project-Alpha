/**
 * A JOB THAT FUNDED AND THEN DIED GETS ITS ESCROW BACK.
 *
 * Since #145 a funding that did not happen is recorded as a failure, which closed the hole where
 * money was booked that had never moved. The opposite hole stayed open: a fund that DID happen,
 * followed by a step that failed, left the budget sitting in the contract's escrow and the row at
 * `failed` — terminal, correct about the saga, and silent about the money. Nothing we shipped
 * could retrieve it.
 *
 * The contract has two ways to send it back, and which one is open depends on facts only the
 * chain has: the evaluator may reject a Funded or Submitted job, and anyone may expire one once
 * its deadline has passed. So the recovery READS THE CHAIN FIRST and decides from the status it
 * finds — never from our row, which knows nothing about where the money is.
 *
 * These tests run the REAL saga and the REAL adapter over the fake node
 * (`helpers/jobFundHarness.ts`), whose `reject` and `claimRefund` enforce the same roles,
 * statuses and deadline the deployed contract does, and then ask two questions: what was sent,
 * and what was written down.
 */
import type { Address } from "viem";
import { beforeEach, expect, test } from "vitest";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import {
  BUDGET,
  DEFAULT_EXPIRES_AT,
  OPENING_BALANCE,
  SUBMIT_REVERT_TX_HASH,
  evaluatorAccount,
  jobClientAccount,
  jobFundHarness,
} from "../helpers/jobFundHarness";

beforeEach(() => resetSenderNonces());

/** What `ChainTxRevertedError` says, which is what the runner stores for a reverted step. */
const revertedMessage = (step: string, txHash: string) =>
  `${step} reverted on chain (${txHash}) — the transaction was mined and its effects were rolled back`;

const calls = (h: ReturnType<typeof jobFundHarness>) =>
  h.node.actions.map((a) => `${a.call}:${a.status}`);

test("a submit that reverts is refunded by the evaluator, and the client gets its budget back", async () => {
  const h = jobFundHarness({ failAt: "submit" });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 3n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  // Three transactions: the two that funded the escrow, and the one that gave it back.
  expect(calls(h)).toEqual(["approve:success", "fund:success", "reject:success"]);
  const fundHash = h.node.sends[1]!.hash;
  const rejectHash = h.node.sends[2]!.hash;
  // The reject is the EVALUATOR's — the client cannot reject a funded job on chain.
  expect(h.node.sendsFrom(evaluatorAccount.address).map((s) => s.hash)).toEqual([rejectHash]);

  // THE MONEY. The escrow is empty and the client is whole again.
  expect(h.node.escrowOf(3n)).toBe(0n);
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
  expect(h.node.chainJob(3n)!.status).toBe(4); // Rejected

  const row = h.jobs.findByKey("t:k")!;
  // The saga still failed, and the row still says so: the refund is a property of the row, not a
  // status of its own, and nothing here pretends the job worked.
  expect(row.status).toBe("failed");
  expect(row.escrowState).toBe("refunded");
  expect(row.refundTxHash).toBe(rejectHash);
  // THE ORIGINAL FAILURE IS WHAT THE ROW STORES. A recovery that overwrote this would have
  // erased the only record of why the job died.
  expect(row.error).toBe(revertedMessage("submit", SUBMIT_REVERT_TX_HASH));

  // The trail reads in the order it happened: the step that died, then what we did about the
  // money — and the dead step keeps the hash an operator can look up.
  expect(h.eventsFor("t:k")).toEqual([
    { step: "fund", status: "funded", tx_hash: fundHash },
    { step: "submit", status: "failed", tx_hash: SUBMIT_REVERT_TX_HASH },
    { step: "refund", status: "refunded", tx_hash: rejectHash },
  ]);
  expect(h.recoveries).toEqual([{ outcome: "refunded", via: "reject", txHash: rejectHash }]);
});

test("a submit we could not confirm is recorded as unconfirmed, not as a failure", async () => {
  // "It reverted" and "it was sent and we cannot read it" are opposite claims about the chain,
  // and the trail must not flatten one into the other: the hash of an unconfirmed submit is the
  // thing an operator looks up before anyone touches the job again (`receipts.ts`, #145's rule
  // for the funding step, applied to the step after it).
  const h = jobFundHarness({ failAt: "submit-unconfirmed" });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 12n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  const [fundHash] = h.node.hashesOf("fund");
  const [rejectHash] = h.node.hashesOf("reject");
  expect(h.eventsFor("t:k")).toEqual([
    { step: "fund", status: "funded", tx_hash: fundHash },
    { step: "submit", status: "unconfirmed", tx_hash: SUBMIT_REVERT_TX_HASH },
    { step: "refund", status: "refunded", tx_hash: rejectHash },
  ]);
  // The escrow still comes back: whether that submit lands or not, the client's money is not
  // meant to stay in the contract, and the reject is valid against Funded and Submitted alike.
  expect(h.jobs.findByKey("t:k")!.escrowState).toBe("refunded");
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
});

test("a complete that reverts is refunded the same way, from the Submitted job", async () => {
  const h = jobFundHarness({ failAt: "complete" });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 3n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  expect(calls(h)).toEqual([
    "approve:success",
    "fund:success",
    "complete:reverted",
    "reject:success",
  ]);
  const fundHash = h.node.sends[1]!.hash;
  const completeHash = h.node.sends[2]!.hash;
  const rejectHash = h.node.sends[3]!.hash;

  expect(h.node.escrowOf(3n)).toBe(0n);
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
  // The provider was never paid: a reverted complete released nothing.
  expect(h.node.chainJob(3n)!.status).toBe(4);

  const row = h.jobs.findByKey("t:k")!;
  expect(row.status).toBe("failed");
  expect(row.escrowState).toBe("refunded");
  expect(row.refundTxHash).toBe(rejectHash);
  expect(row.error).toBe(revertedMessage("complete", completeHash));

  expect(h.eventsFor("t:k")).toEqual([
    { step: "fund", status: "funded", tx_hash: fundHash },
    { step: "submit", status: "submitted", tx_hash: `0x${"cc".repeat(32)}` },
    { step: "complete", status: "failed", tx_hash: completeHash },
    { step: "refund", status: "refunded", tx_hash: rejectHash },
  ]);
});

test("with no evaluator key the escrow waits for its deadline, and the next boot claims it", async () => {
  // The deployment with no `JOB_EVALUATOR_PRIVATE_KEY`: the evaluator IS the client, so "the
  // evaluator rejects" is not a thing the contract will accept. The only refund left is the
  // permissionless expiry one, and it is not open yet.
  let nowSec = 1_000;
  const h = jobFundHarness({
    evaluator: false,
    failAt: "submit",
    now: () => nowSec,
  });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 4n, expiredAt: 5_000n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  // NOTHING WAS SENT. A reject we are not entitled to would have been a reverted transaction and
  // a gas bill, and `claimRefund` before the deadline is the same.
  expect(calls(h)).toEqual(["approve:success", "fund:success"]);
  const fundHash = h.node.sends[1]!.hash;
  expect(h.node.escrowOf(4n)).toBe(BUDGET);
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE - BUDGET);

  const waiting = h.jobs.findByKey("t:k")!;
  expect(waiting.status).toBe("failed");
  // Recorded as still in the contract, which is what makes it findable at the next boot.
  expect(waiting.escrowState).toBe("escrowed");
  expect(waiting.refundTxHash).toBe(null);
  expect(h.recoveries).toEqual([{ outcome: "waiting-expiry", expiredAt: 5_000n }]);
  expect(h.jobs.listEscrowedUnrefunded().map((r) => r.jobKey)).toEqual(["t:k"]);

  // Past the deadline, the boot reconcile walks the same row and takes the other path.
  nowSec = 5_001;
  h.runner.reconcileInFlight();
  await h.runner.settled();

  expect(calls(h)).toEqual(["approve:success", "fund:success", "claimRefund:success"]);
  const claimHash = h.node.sends[2]!.hash;
  // Sent by the CLIENT: the key that paid the escrow is the one the contract pays back.
  expect(h.node.sendsFrom(jobClientAccount.address).map((s) => s.hash)).toEqual([
    h.node.sends[0]!.hash,
    fundHash,
    claimHash,
  ]);
  expect(h.node.escrowOf(4n)).toBe(0n);
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
  expect(h.node.chainJob(4n)!.status).toBe(5); // Expired

  const refunded = h.jobs.findByKey("t:k")!;
  expect(refunded.escrowState).toBe("refunded");
  expect(refunded.refundTxHash).toBe(claimHash);
  expect(refunded.error).toBe(revertedMessage("submit", SUBMIT_REVERT_TX_HASH));
  expect(h.eventsFor("t:k")).toEqual([
    { step: "fund", status: "funded", tx_hash: fundHash },
    { step: "submit", status: "failed", tx_hash: SUBMIT_REVERT_TX_HASH },
    { step: "refund", status: "refunded", tx_hash: claimHash },
  ]);
  expect(h.recoveries).toEqual([
    { outcome: "waiting-expiry", expiredAt: 5_000n },
    { outcome: "refunded", via: "claimRefund", txHash: claimHash },
  ]);
  // Nothing is owed any more, so the boot after this one finds no work.
  expect(h.jobs.listEscrowedUnrefunded()).toEqual([]);
});

test("an evaluator key that is not THIS job's evaluator waits for the expiry instead", async () => {
  // The rotation case, and the reason "do we hold an evaluator key" is the wrong question: a job
  // created BEFORE the key was configured carries the client as its evaluator, and the contract
  // refuses a reject from anyone else. Sending one anyway would be a reverted transaction and a
  // gas bill on every boot, for ever, while the expiry path sat there unused.
  let nowSec = 1_000;
  const h = jobFundHarness({ failAt: "submit", now: () => nowSec });
  h.seedCreatedJob({
    jobKey: "t:k",
    entityKey: "t:agent",
    jobId: 11n,
    expiredAt: 5_000n,
    // Our evaluator key exists (the harness configures one by default) and is NOT this one.
    evaluator: jobClientAccount.address as Address,
  });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  expect(calls(h)).toEqual(["approve:success", "fund:success"]);
  expect(h.node.sendsFrom(evaluatorAccount.address)).toEqual([]);
  expect(h.recoveries).toEqual([{ outcome: "waiting-expiry", expiredAt: 5_000n }]);
  expect(h.jobs.findByKey("t:k")!.escrowState).toBe("escrowed");
  expect(h.node.escrowOf(11n)).toBe(BUDGET);

  // Past the deadline it takes the permissionless path, as if no evaluator key existed at all.
  nowSec = 5_001;
  h.runner.reconcileInFlight();
  await h.runner.settled();

  expect(calls(h)).toEqual(["approve:success", "fund:success", "claimRefund:success"]);
  const claimHash = h.node.sends[2]!.hash;
  expect(h.jobs.findByKey("t:k")!.refundTxHash).toBe(claimHash);
  expect(h.jobs.findByKey("t:k")!.escrowState).toBe("refunded");
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
  expect(h.node.chainJob(11n)!.status).toBe(5); // Expired
});

test("a second refund of a job WE refunded keeps our hash, and sends nothing", async () => {
  // The MCP tool's description says it is safe to call twice, and it is — but the row has to
  // survive the second call. `refund_tx_hash = null` means "somebody else refunded this" in this
  // module's own vocabulary, so writing it over our own hash turns the row into a lie about a job
  // whose money is already home, and nothing ever puts it back: the row is no longer in
  // `listEscrowedUnrefunded()`.
  const h = jobFundHarness({ failAt: "submit" });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 13n });

  h.runner.reconcileInFlight();
  await h.runner.settled();
  const [rejectHash] = h.node.hashesOf("reject");
  const sendsAfterFirst = h.node.sends.length;
  expect(h.jobs.findByKey("t:k")!.refundTxHash).toBe(rejectHash);

  // The second call reads the chain, finds Rejected, and has nothing to do.
  expect(await h.refundJob("t:k")).toEqual({ outcome: "refunded-elsewhere" });

  expect(h.node.sends).toHaveLength(sendsAfterFirst);
  const row = h.jobs.findByKey("t:k")!;
  expect(row.escrowState).toBe("refunded");
  expect(row.refundTxHash).toBe(rejectHash);
  // …and a third call does not erode it either.
  await h.refundJob("t:k");
  expect(h.jobs.findByKey("t:k")!.refundTxHash).toBe(rejectHash);
});

test("a refund that dies at the pre-flight still lands on the trail", async () => {
  // THE USUAL SHAPE OF A REVERT ON A REAL CHAIN. `prepareTransactionRequest` estimates gas before
  // anything is signed, so a reject the contract would refuse throws there — with no hash, and as
  // a viem error rather than one of ours. Rethrowing it silently left the job's own trail empty
  // and the ops log as the only record.
  const h = jobFundHarness({ failAt: "submit", rejectPreflightFails: true });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 14n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  // Nothing was signed: the estimate refused before a transaction existed.
  expect(h.node.hashesOf("reject")).toEqual([]);
  const [fundHash] = h.node.hashesOf("fund");
  expect(h.eventsFor("t:k")).toEqual([
    { step: "fund", status: "funded", tx_hash: fundHash },
    { step: "submit", status: "failed", tx_hash: SUBMIT_REVERT_TX_HASH },
    { step: "refund", status: "failed", tx_hash: null },
  ]);
  const row = h.jobs.findByKey("t:k")!;
  // The money is still in the contract and the row says so, so the next boot tries again.
  expect(row.escrowState).toBe("escrowed");
  expect(row.refundTxHash).toBe(null);
  expect(h.node.escrowOf(14n)).toBe(BUDGET);
  expect(h.jobs.listEscrowedUnrefunded().map((r) => r.jobKey)).toEqual(["t:k"]);
  // The ORIGINAL failure is still the row's error — a refund that could not even be attempted
  // does not get to explain why the job died.
  expect(row.error).toBe(revertedMessage("submit", SUBMIT_REVERT_TX_HASH));
});

test("a manual refund racing the boot walk sends exactly one refund", async () => {
  // Two doors onto the same money. `recoverEscrow` reads the chain, decides and sends, so two
  // callers inside that window both see Funded and both send a reject: one is mined, the other is
  // burnt gas and a `refund/failed` on the trail that describes nothing real. The lock is per
  // ENTITY and the boot walk already holds it; the manual door has to be on the same key.
  const h = jobFundHarness({});
  h.seedFailedFundedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 15n, chainStatus: 1 });

  // The boot walk and an operator's `refund-job`, in the same moment.
  h.runner.reconcileInFlight();
  await Promise.all([h.runner.settled(), h.refundViaDoor("t:k")]);

  const rejects = h.node.hashesOf("reject");
  expect(rejects).toHaveLength(1);
  expect(h.node.actions.map((a) => `${a.call}:${a.status}`)).toEqual(["reject:success"]);
  expect(h.eventsFor("t:k")).toEqual([
    { step: "refund", status: "refunded", tx_hash: rejects[0]! },
  ]);
  const row = h.jobs.findByKey("t:k")!;
  expect(row.escrowState).toBe("refunded");
  expect(row.refundTxHash).toBe(rejects[0]!);
  expect(h.node.escrowOf(15n)).toBe(0n);
});

test("two manual refunds of one job race no better than one", async () => {
  const h = jobFundHarness({});
  h.seedFailedFundedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 16n, chainStatus: 1 });

  await Promise.all([h.refundViaDoor("t:k"), h.refundViaDoor("t:k")]);

  // The second caller reads the chain AFTER the first has finished, finds Rejected, and sends
  // nothing — which is only true because it waited.
  expect(h.node.hashesOf("reject")).toHaveLength(1);
  expect(h.recoveries.map((r) => r.outcome)).toEqual(["refunded", "refunded-elsewhere"]);
  const row = h.jobs.findByKey("t:k")!;
  expect(row.escrowState).toBe("refunded");
  expect(row.refundTxHash).toBe(h.node.hashesOf("reject")[0]!);
});

test("a row that already reads refunded never goes back to escrowed", async () => {
  // The loser's write, on its own and with no race to produce it: a caller that read the chain a
  // moment before the winner's reject landed decides `escrowed`, and that decision must not
  // overwrite the fact the winner recorded. Belt to the doors' braces — the lock stops the second
  // transaction, this stops the second WRITE, and `get_job` never reports an escrow still in the
  // contract for a job whose budget is home.
  const winnerHash = `0x${"77".repeat(32)}` as const;
  // Held before the deadline throughout: past it this caller would correctly send a claimRefund
  // (the chain says the escrow is there), and this test is about the WRITE, not the chain.
  const h = jobFundHarness({ evaluator: false, now: () => 1_000 });
  h.seedFailedFundedJob({
    jobKey: "t:k",
    entityKey: "t:agent",
    jobId: 17n,
    chainStatus: 1, // the chain still says Funded to this reader
    expiredAt: 5_000n,
  });
  const winner = h.jobs.findByKey("t:k")!;
  h.jobs.upsert({ ...winner, escrowState: "refunded", refundTxHash: winnerHash });

  // No evaluator key and the deadline has not passed, so this caller's verdict is `escrowed`.
  expect(await h.refundJob("t:k")).toEqual({ outcome: "waiting-expiry", expiredAt: 5_000n });

  const row = h.jobs.findByKey("t:k")!;
  expect(row.escrowState).toBe("refunded");
  expect(row.refundTxHash).toBe(winnerHash);
  // …and it stays out of the boot walk's set, so nothing re-reads the chain for it for ever.
  expect(h.jobs.listEscrowedUnrefunded()).toEqual([]);
  // The same holds for a `released` row, the other end-state.
  h.jobs.upsert({ ...winner, escrowState: "released", refundTxHash: null });
  expect(await h.refundJob("t:k")).toEqual({ outcome: "waiting-expiry", expiredAt: 5_000n });
  expect(h.jobs.findByKey("t:k")!.escrowState).toBe("released");
  // Nothing was sent for either of them: this test is about the WRITE, not the chain.
  expect(h.node.sends).toEqual([]);
});

test("a job the chain says is Completed is released money, and nothing is sent", async () => {
  // The escrow paid the provider after we had already given up on the row. There is nothing to
  // refund, and a reject would only have reverted.
  const h = jobFundHarness({});
  h.seedFailedFundedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 5n, chainStatus: 3 });

  expect(await h.refundJob("t:k")).toEqual({ outcome: "released" });

  expect(h.node.sends).toEqual([]);
  const row = h.jobs.findByKey("t:k")!;
  expect(row.status).toBe("failed");
  expect(row.escrowState).toBe("released");
  expect(row.refundTxHash).toBe(null);
  expect(row.error).toBe("died after funding");
  expect(h.eventsFor("t:k")).toEqual([]);
  expect(h.jobs.listEscrowedUnrefunded()).toEqual([]);
});

test.each([
  { name: "Rejected", chainStatus: 4 },
  { name: "Expired", chainStatus: 5 },
])(
  "a job the chain says is $name was refunded by somebody else, and we claim no hash for it",
  async ({ chainStatus }) => {
    // `claimRefund` is permissionless, so the refund can happen without us: the money is back
    // with the client either way, and the row should say so — with no transaction of ours.
    const h = jobFundHarness({});
    h.seedFailedFundedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 6n, chainStatus });

    expect(await h.refundJob("t:k")).toEqual({ outcome: "refunded-elsewhere" });

    expect(h.node.sends).toEqual([]);
    const row = h.jobs.findByKey("t:k")!;
    expect(row.escrowState).toBe("refunded");
    expect(row.refundTxHash).toBe(null);
    expect(h.eventsFor("t:k")).toEqual([]);
    expect(h.jobs.listEscrowedUnrefunded()).toEqual([]);
  },
);

test("a job the chain never heard of has nothing escrowed", async () => {
  // A row whose `jobId` names no job on this contract: the zero record, status Open, no budget.
  // Nothing to send, and nothing owed.
  const h = jobFundHarness({});
  h.seedFailedFundedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 8n, chainStatus: 3 });
  const row = h.jobs.findByKey("t:k")!;
  h.jobs.upsert({ ...row, jobId: "404" });

  expect(await h.refundJob("t:k")).toEqual({ outcome: "nothing-escrowed" });

  expect(h.node.sends).toEqual([]);
  expect(h.jobs.findByKey("t:k")!.escrowState).toBe("none");
  expect(h.jobs.findByKey("t:k")!.refundTxHash).toBe(null);
});

test("a reject that reverts leaves the escrow where it is, and the next boot tries again", async () => {
  // A refund is a transaction like any other: it can be mined and rolled back. Believing its hash
  // would write `refunded` over an escrow that is still full — the 2026-09-22 mistake, one step
  // along. So the state stays `escrowed`, the hash goes on the trail as a failure, and the row
  // remains in the set the boot reconcile walks.
  const h = jobFundHarness({ failAt: "submit", revertReject: true });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 7n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  expect(calls(h)).toEqual(["approve:success", "fund:success", "reject:reverted"]);
  const fundHash = h.node.sends[1]!.hash;
  const failedRejectHash = h.node.sends[2]!.hash;
  expect(h.node.escrowOf(7n)).toBe(BUDGET);
  expect(h.node.chainJob(7n)!.status).toBe(1); // still Funded

  const stuck = h.jobs.findByKey("t:k")!;
  expect(stuck.status).toBe("failed");
  expect(stuck.escrowState).toBe("escrowed");
  expect(stuck.refundTxHash).toBe(null);
  // The ORIGINAL failure, not the refund's: a recovery that could not run must not become the
  // explanation of why the job died.
  expect(stuck.error).toBe(revertedMessage("submit", SUBMIT_REVERT_TX_HASH));
  expect(h.eventsFor("t:k")).toEqual([
    { step: "fund", status: "funded", tx_hash: fundHash },
    { step: "submit", status: "failed", tx_hash: SUBMIT_REVERT_TX_HASH },
    { step: "refund", status: "failed", tx_hash: failedRejectHash },
  ]);
  expect(h.recoveries).toEqual([
    { outcome: "refund-failed", via: "reject", txHash: failedRejectHash },
  ]);

  // The next boot: the node lets this one through, and the row is settled.
  h.runner.reconcileInFlight();
  await h.runner.settled();

  const rejectHash = h.node.sends[3]!.hash;
  expect(calls(h)).toEqual([
    "approve:success",
    "fund:success",
    "reject:reverted",
    "reject:success",
  ]);
  const row = h.jobs.findByKey("t:k")!;
  expect(row.escrowState).toBe("refunded");
  expect(row.refundTxHash).toBe(rejectHash);
  expect(row.error).toBe(revertedMessage("submit", SUBMIT_REVERT_TX_HASH));
  expect(h.node.escrowOf(7n)).toBe(0n);
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
});

test("the deadline the saga puts on a job is the one the recovery waits for", async () => {
  // A sanity check on the two halves meeting: `runJob` sets `expiredAt` from its own clock, and
  // the recovery's "not yet" answer quotes the same number back.
  let nowSec = 2_000;
  const h = jobFundHarness({
    evaluator: false,
    failAt: "submit",
    now: () => nowSec,
  });
  h.seedCreatedJob({
    jobKey: "t:k",
    entityKey: "t:agent",
    jobId: 9n,
    expiredAt: DEFAULT_EXPIRES_AT,
  });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  expect(h.recoveries).toEqual([{ outcome: "waiting-expiry", expiredAt: DEFAULT_EXPIRES_AT }]);
  nowSec = 3_000;
  // Still far from the deadline, so a second walk still sends nothing.
  h.runner.reconcileInFlight();
  await h.runner.settled();
  expect(calls(h)).toEqual(["approve:success", "fund:success"]);
});
