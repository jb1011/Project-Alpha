/**
 * ONE ALLOWANCE UNIT PER CLIENT KEY: approve A, fund A, approve B, fund B.
 *
 * An ERC-20 allowance is one number per (owner, spender) pair, and `approve` SETS it. Two jobs
 * funding at once from one job client key are therefore not two independent transfers — they are
 * two writers to one number. On 2026-09-22 they interleaved as approve A, approve B, fund A,
 * fund B: B's approve overwrote A's, A's fund spent all of it, and B's fund reverted.
 *
 * `runJob` is serialised per ENTITY (`jobs/composition.ts`), which is the right lock for the
 * agent's operator key and no lock at all for this: the two jobs were on two different entities
 * and shared one client key. So the approve and the fund are one unit, keyed by the CLIENT
 * ADDRESS — a different key from the per-signer send lock (`sender:<address>` in
 * `adapters/arc/senderLock.ts`), which still serialises the individual broadcasts inside it.
 *
 * Real saga, real adapter, real local signer, real SQLite, over the allowance-keeping node in
 * `helpers/jobFundHarness.ts`. Only the provider-signed steps are faked.
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

test("two concurrent jobs on two entities take the one allowance in turn, and both fund", async () => {
  const h = jobFundHarness();
  h.seedCreatedJob({ jobKey: "t:a", entityKey: "t:agent-a", jobId: 1n });
  h.seedCreatedJob({ jobKey: "t:b", entityKey: "t:agent-b", jobId: 2n });

  // Fired together, exactly as the two `run_job` calls were. Each saga stops after its funding
  // step (the harness's worker throws there), so what is asserted is the escrow and nothing else.
  await Promise.allSettled([
    h.runJob({ jobKey: "t:a", entityKey: "t:agent-a" }),
    h.runJob({ jobKey: "t:b", entityKey: "t:agent-b" }),
  ]);

  // THE SEQUENCE. Not approve, approve, fund, fund — and no revert anywhere.
  //
  // Filtered to the FUNDING calls, because each saga also gets its escrow back once the harness's
  // worker throws, and the two rejects race each other: A's refund is sent while B is still
  // inside the allowance unit, so their position in this list is not a fact about the product.
  // Their count is, and it is asserted right below.
  expect(
    h.node.actions.filter((a) => a.call !== "reject").map((a) => `${a.call}:${a.status}`),
  ).toEqual(["approve:success", "fund:success", "approve:success", "fund:success"]);
  expect(h.node.actions.filter((a) => a.call === "reject").map((a) => a.status)).toEqual([
    "success",
    "success",
  ]);
  // Four sends from the one client key, numbered consecutively: the send lock still owns the
  // nonces, and the allowance lock did not cost a single extra transaction. The two refunds are
  // the EVALUATOR's key, which is its own nonce space.
  expect(h.node.sendsFrom(jobClientAccount.address)).toHaveLength(4);
  expect(h.node.sendsFrom(jobClientAccount.address).map((s) => s.nonce)).toEqual([0, 1, 2, 3]);
  expect(h.node.sendsFrom(evaluatorAccount.address).map((s) => s.nonce)).toEqual([0, 1]);
  expect(h.node.sends).toHaveLength(6);

  // Both jobs funded — and then refunded, because nothing here gets past the worker. Each escrow
  // was filled by its own fund (the sequence above) and emptied by its own reject, and the
  // client's balance is the round trip: two budgets out, two budgets back.
  expect(h.jobs.findByKey("t:a")!.status).toBe("funded");
  expect(h.jobs.findByKey("t:b")!.status).toBe("funded");
  expect(h.jobs.findByKey("t:a")!.escrowState).toBe("refunded");
  expect(h.jobs.findByKey("t:b")!.escrowState).toBe("refunded");
  expect(h.node.escrowOf(1n)).toBe(0n);
  expect(h.node.escrowOf(2n)).toBe(0n);
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
  // The allowance is spent to the last unit: each fund pulled exactly what its approve granted.
  expect(h.node.allowanceOf(jobClientAccount.address, h.adapter.jobContract)).toBe(0n);

  // Booked twice, once per transfer that actually happened, against the two fund hashes — named
  // as the funds they are, not as positions in a list the refunds also appear in.
  const [fundA, fundB] = h.node.hashesOf("fund");
  expect(h.outflows).toEqual([
    { path: "job_fund", amountAtomic: 500_000n, ref: fundA },
    { path: "job_fund", amountAtomic: 500_000n, ref: fundB },
  ]);
  // …and each row carries the hash of the fund that filled ITS escrow.
  expect([h.jobs.findByKey("t:a")!.fundTxHash, h.jobs.findByKey("t:b")!.fundTxHash].sort()).toEqual(
    [fundA, fundB].sort(),
  );
  // Nothing was booked BACK: the outflow meter has no reversal, and a refund deliberately leaves
  // the rolling brake more conservative than the truth rather than inventing a credit.
  expect(h.outflows).toHaveLength(2);
});

test("an allowance that does not cover the budget stops the fund before it is sent", async () => {
  // Belt and braces: the approve is mined and successful, but the allowance it left is short.
  // Read from the chain before the fund goes out, that is a refusal, not a revert.
  const h = jobFundHarness({ approveSets: 499_999n });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 5n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  expect(h.node.actions).toEqual([
    { call: "approve", from: jobClientAccount.address, status: "success" },
  ]);
  const approveHash = h.node.sends[0]!.hash;

  const row = h.jobs.findByKey("t:k")!;
  expect(row.status).toBe("failed");
  expect(row.fundTxHash).toBe(null);
  expect(row.error).toBe(
    `the escrow funding for job 5 failed at the approve step (${approveHash}): the USDC allowance no longer covers the budget. The job was not funded and nothing was charged.`,
  );
  expect(h.outflows).toEqual([]);
  expect(h.eventsFor("t:k")).toEqual([{ step: "fund", status: "failed", tx_hash: approveHash }]);
  expect(h.node.escrowOf(5n)).toBe(0n);
});
