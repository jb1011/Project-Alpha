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
import { jobClientAccount, jobFundHarness } from "../helpers/jobFundHarness";

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
  expect(h.node.actions.map((a) => `${a.call}:${a.status}`)).toEqual([
    "approve:success",
    "fund:success",
    "approve:success",
    "fund:success",
  ]);
  // Four sends from the one client key, numbered consecutively: the send lock still owns the
  // nonces, and the allowance lock did not cost a single extra transaction.
  expect(h.node.sends).toHaveLength(4);
  expect(h.node.sendsFrom(jobClientAccount.address).map((s) => s.nonce)).toEqual([0, 1, 2, 3]);

  // Both jobs funded, and each contract escrow holds its own budget.
  expect(h.jobs.findByKey("t:a")!.status).toBe("funded");
  expect(h.jobs.findByKey("t:b")!.status).toBe("funded");
  expect(h.node.escrowOf(1n)).toBe(500_000n);
  expect(h.node.escrowOf(2n)).toBe(500_000n);
  // The allowance is spent to the last unit: each fund pulled exactly what its approve granted.
  expect(h.node.allowanceOf(jobClientAccount.address, h.adapter.jobContract)).toBe(0n);

  // Booked twice, once per transfer that actually happened, against the two fund hashes.
  expect(h.outflows).toEqual([
    { path: "job_fund", amountAtomic: 500_000n, ref: h.node.sends[1]!.hash },
    { path: "job_fund", amountAtomic: 500_000n, ref: h.node.sends[3]!.hash },
  ]);
  // …and each row carries the hash of the fund that filled ITS escrow.
  expect([h.jobs.findByKey("t:a")!.fundTxHash, h.jobs.findByKey("t:b")!.fundTxHash].sort()).toEqual(
    [h.node.sends[1]!.hash, h.node.sends[3]!.hash].sort(),
  );
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
