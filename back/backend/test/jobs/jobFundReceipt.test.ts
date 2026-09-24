/**
 * A REVERTED ESCROW FUNDING IS NOT A FUNDED JOB.
 *
 * 2026-09-22, Arc testnet: two `run_job` calls landed four transactions from one job client key —
 * approve A, approve B, fund A, fund B. An ERC-20 `approve` SETS the allowance, so B's overwrote
 * A's; A's `fund` then spent the whole of it and B's `fund` was mined with `status: 0x0`. Nothing
 * threw. `approveAndFund` returned that hash, the saga booked 0.5 USDC as money that had left,
 * wrote the row `funded`, and the next step died with a custody-provider estimation error because
 * the contract, correctly, would not accept a deliverable for a job nobody had funded.
 *
 * No money moved. The outflow ledger and the job row both said otherwise, and the fix is not in
 * the racing: it is that a hash was believed without its receipt. So these tests fund through the
 * REAL saga and the REAL adapter over a node whose `fund` reverts (`helpers/jobFundHarness.ts`),
 * and ask what was written down.
 */
import { beforeEach, expect, test } from "vitest";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import {
  OPENING_BALANCE,
  evaluatorAccount,
  jobClientAccount,
  jobFundHarness,
} from "../helpers/jobFundHarness";

beforeEach(() => resetSenderNonces());

test("a fund that reverts leaves the job failed, unfunded, and books no outflow", async () => {
  // The allowance disappears between the fund's pre-flight and its inclusion — the incident's
  // shape, and the only thing a receipt can report.
  const h = jobFundHarness({ stealAllowanceOnFund: true });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 7n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  // Two transactions reached the chain: the approve took, the fund was mined and rolled back.
  expect(h.node.actions).toEqual([
    { call: "approve", from: jobClientAccount.address, status: "success" },
    { call: "fund", from: jobClientAccount.address, status: "reverted" },
  ]);
  const fundHash = h.node.sends[1]!.hash;

  const row = h.jobs.findByKey("t:k")!;
  expect(row.status).toBe("failed");
  expect(row.fundTxHash).toBe(null);
  expect(row.error).toBe(
    `the escrow funding for job 7 failed at the fund step (${fundHash}): the transaction reverted on chain. The job was not funded and nothing was charged.`,
  );

  // Nothing left the client wallet, so nothing is booked against the outflow ceiling.
  expect(h.outflows).toEqual([]);
  // …and the trail says `fund`/`failed` with the hash an operator can look up, never `funded`.
  expect(h.eventsFor("t:k")).toEqual([{ step: "fund", status: "failed", tx_hash: fundHash }]);
  // The escrow is empty: the contract never took the budget.
  expect(h.node.escrowOf(7n)).toBe(0n);
});

test("a reverted approve fails the same way, and the fund is never sent", async () => {
  const h = jobFundHarness({ revertApprove: true });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 8n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  // One transaction, and no second one: an approve that did not take is the end of the step.
  expect(h.node.actions).toEqual([
    { call: "approve", from: jobClientAccount.address, status: "reverted" },
  ]);
  const approveHash = h.node.sends[0]!.hash;

  const row = h.jobs.findByKey("t:k")!;
  expect(row.status).toBe("failed");
  expect(row.fundTxHash).toBe(null);
  expect(row.error).toBe(
    `the escrow funding for job 8 failed at the approve step (${approveHash}): the transaction reverted on chain. The job was not funded and nothing was charged.`,
  );
  expect(h.outflows).toEqual([]);
  expect(h.eventsFor("t:k")).toEqual([{ step: "fund", status: "failed", tx_hash: approveHash }]);
  // The provider's own step ran first and is not undone by this: it is the client's money that
  // never moved, and the on-chain job simply expires.
  expect(h.providerCalls).toEqual(["setBudget"]);
});

test("a funding that succeeds is booked once, and the row carries the fund hash", async () => {
  // The other half of the rule: nothing about a SUCCESSFUL receipt changes.
  const h = jobFundHarness();
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 9n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  // The approve and the fund both took, unchanged — and then the harness's worker throws, which
  // is a post-funding failure, so the escrow recovery gives the budget back (the escrow assertions
  // below follow it through). That is the shipped saga: `jobs/composition.ts` always wires it.
  expect(h.node.actions).toEqual([
    { call: "approve", from: jobClientAccount.address, status: "success" },
    { call: "fund", from: jobClientAccount.address, status: "success" },
    { call: "reject", from: evaluatorAccount.address, status: "success" },
  ]);
  const fundHash = h.node.sends[1]!.hash;
  const rejectHash = h.node.sends[2]!.hash;

  const row = h.jobs.findByKey("t:k")!;
  expect(row.fundTxHash).toBe(fundHash);
  expect(h.outflows).toEqual([{ path: "job_fund", amountAtomic: 500_000n, ref: fundHash }]);
  expect(h.eventsFor("t:k")).toEqual([
    { step: "fund", status: "funded", tx_hash: fundHash },
    { step: "submit", status: "failed", tx_hash: null },
    { step: "refund", status: "refunded", tx_hash: rejectHash },
  ]);
  // The fund DID fill the escrow — the reject is what emptied it again, and the client's balance
  // is the round trip: BUDGET out on the fund, BUDGET back on the refund.
  expect(h.node.escrowOf(9n)).toBe(0n);
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
  expect(row.escrowState).toBe("refunded");
  expect(row.refundTxHash).toBe(rejectHash);
  // The budget was pulled through the allowance, which is therefore spent.
  expect(h.node.allowanceOf(jobClientAccount.address, h.adapter.jobContract)).toBe(0n);
});
