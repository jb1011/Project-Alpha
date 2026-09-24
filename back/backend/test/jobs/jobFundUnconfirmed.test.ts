/**
 * A RECEIPT WE COULD NOT READ IS NOT A TRANSACTION THAT FAILED.
 *
 * The allowance unit (`adapters/arc/jobAdapter.ts`) holds one key per client address across both
 * receipt waits — that is what makes approve-then-fund a unit. So the waits have to be BOUNDED,
 * or one transaction the mempool never mines parks every job in the process behind it for viem's
 * default three minutes per wait. They are bounded at {RECEIPT_TIMEOUT_MS}, and Arc's finality is
 * sub-second, so a minute of silence is not slowness, it is something wrong.
 *
 * And the bound must not lie. A timeout says the opposite of a revert: the transaction was SENT,
 * it may still land, and the escrow may yet be funded — which is why it gets its own type, its own
 * `fund`/`unconfirmed` event, and a sentence that never contains the word "reverted". Booking
 * nothing is right either way; claiming the money never moved is right only for a revert.
 */
import { beforeEach, expect, test } from "vitest";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import { OPENING_BALANCE, jobClientAccount, jobFundHarness } from "../helpers/jobFundHarness";

beforeEach(() => resetSenderNonces());

test("an approve whose receipt never arrives is unconfirmed, and no fund is sent", async () => {
  const h = jobFundHarness({ withholdReceipt: "approve", receiptTimeoutMs: 40 });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 3n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  // The approve is on the chain. Nothing followed it, because we do not know what it did.
  expect(h.node.actions).toEqual([
    { call: "approve", from: jobClientAccount.address, status: "success" },
  ]);
  const approveHash = h.node.sends[0]!.hash;

  const row = h.jobs.findByKey("t:k")!;
  expect(row.status).toBe("failed");
  expect(row.fundTxHash).toBe(null);
  expect(row.error).toBe(
    `the escrow funding for job 3 was sent at the approve step (${approveHash}) but we could not confirm it in time — it may still land. Nothing was booked; do not re-run this job until the transaction is resolved.`,
  );
  // The one word it must never say about a transaction whose fate is unknown.
  expect(row.error!.includes("reverted")).toBe(false);
  expect(h.outflows).toEqual([]);
  expect(h.eventsFor("t:k")).toEqual([
    { step: "fund", status: "unconfirmed", tx_hash: approveHash },
  ]);
});

test("a fund whose receipt never arrives is unconfirmed — the escrow may be full, the ledger stays empty", async () => {
  const h = jobFundHarness({ withholdReceipt: "fund", receiptTimeoutMs: 40 });
  h.seedCreatedJob({ jobKey: "t:k", entityKey: "t:agent", jobId: 4n });

  h.runner.reconcileInFlight();
  await h.runner.settled();

  // Both transactions landed and the escrow IS funded — we simply could not read the receipt.
  expect(h.node.actions).toEqual([
    { call: "approve", from: jobClientAccount.address, status: "success" },
    { call: "fund", from: jobClientAccount.address, status: "success" },
  ]);
  expect(h.node.escrowOf(4n)).toBe(500_000n);
  const fundHash = h.node.sends[1]!.hash;

  const row = h.jobs.findByKey("t:k")!;
  expect(row.status).toBe("failed");
  expect(row.fundTxHash).toBe(null);
  expect(row.error).toBe(
    `the escrow funding for job 4 was sent at the fund step (${fundHash}) but we could not confirm it in time — it may still land. Nothing was booked; do not re-run this job until the transaction is resolved.`,
  );
  // Refusing to book is the only honest answer: we do not know that the money moved.
  expect(h.outflows).toEqual([]);
  expect(h.eventsFor("t:k")).toEqual([{ step: "fund", status: "unconfirmed", tx_hash: fundHash }]);
});

test("the allowance unit is released after a timeout, so the next job funds normally", async () => {
  // The whole reason for the bound: a receipt nobody can read must not hold the key for every
  // tenant. Both jobs are fired together; the second waits out the first's dead unit, then funds.
  const h = jobFundHarness({ withholdReceipt: "approve", receiptTimeoutMs: 40 });
  h.seedCreatedJob({ jobKey: "t:stuck", entityKey: "t:agent-a", jobId: 6n });
  h.seedCreatedJob({ jobKey: "t:next", entityKey: "t:agent-b", jobId: 7n });

  await Promise.allSettled([
    h.runJob({ jobKey: "t:stuck", entityKey: "t:agent-a" }),
    h.runJob({ jobKey: "t:next", entityKey: "t:agent-b" }),
  ]);

  // The two approves and the one fund, and then the refund of the escrow that fund filled: the
  // second job got past funding, so its worker throwing is a post-funding failure like any other.
  expect(h.node.actions.map((a) => `${a.call}:${a.status}`)).toEqual([
    "approve:success",
    "approve:success",
    "fund:success",
    "reject:success",
  ]);
  // The stuck job sent one transaction, booked nothing, and left the hash on the trail. It never
  // funded, so there is nothing to recover and no refund line of its own.
  expect(h.jobs.findByKey("t:stuck")!.fundTxHash).toBe(null);
  expect(h.eventsFor("t:stuck")).toEqual([
    { step: "fund", status: "unconfirmed", tx_hash: h.node.sends[0]!.hash },
  ]);
  expect(h.jobs.findByKey("t:stuck")!.escrowState).toBe(null);
  // The next one was not held up by it: it funded, and got its budget back.
  expect(h.jobs.findByKey("t:next")!.status).toBe("funded");
  const [fundHash] = h.node.hashesOf("fund");
  expect(h.node.escrowOf(7n)).toBe(0n);
  expect(h.node.balanceOf(jobClientAccount.address)).toBe(OPENING_BALANCE);
  expect(h.jobs.findByKey("t:next")!.escrowState).toBe("refunded");
  expect(h.outflows).toEqual([{ path: "job_fund", amountAtomic: 500_000n, ref: fundHash }]);
});
