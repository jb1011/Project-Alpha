import { describe, expect, test } from "vitest";
import { JobAdapter } from "../../../src/adapters/arc/jobAdapter";
import { deployMockJob } from "../../helpers/anvilJob";

describe("JobAdapter reads", () => {
  test("jobCounter starts at 0", async () => {
    const { publicClient, clientWallet, jobAddr, stop } = await deployMockJob();
    try {
      const a = new JobAdapter({ publicClient, clientWallet, jobContract: jobAddr });
      expect(await a.jobCounter()).toBe(0n);
    } finally {
      await stop();
    }
  }, 40_000);
});

describe("JobAdapter writes", () => {
  test("createJob → provider setBudget → client fund moves USDC into escrow", async () => {
    const env = await deployMockJob();
    await env.mintUsdc(env.clientAddr, 1_000_000n);
    const a = new JobAdapter({
      publicClient: env.publicClient,
      clientWallet: env.clientWallet,
      jobContract: env.jobAddr,
    });
    const { jobId } = await a.createJob({
      provider: env.providerAddr,
      evaluator: env.evaluatorAddr,
      expiredAt: 9_999_999_999n,
      description: "demo",
    });
    expect(jobId).toBe(0n);
    await a.setBudget(jobId, 500_000n, env.providerWallet);
    await a.approveAndFund(jobId, env.usdcAddr, 500_000n);
    expect((await a.getJob(jobId)).status).toBe(1); // Funded
    await env.stop();
  }, 60_000);

  test("provider submits, evaluator completes, USDC released to provider", async () => {
    const env = await deployMockJob();
    try {
      await env.mintUsdc(env.clientAddr, 1_000_000n);
      const a = new JobAdapter({
        publicClient: env.publicClient,
        clientWallet: env.clientWallet,
        evaluatorWallet: env.evaluatorWallet,
        jobContract: env.jobAddr,
      });
      const { jobId } = await a.createJob({
        provider: env.providerAddr,
        evaluator: env.evaluatorAddr,
        expiredAt: 9_999_999_999n,
        description: "x",
      });
      await a.setBudget(jobId, 400_000n, env.providerWallet);
      await a.approveAndFund(jobId, env.usdcAddr, 400_000n);
      await a.submit(jobId, `0x${"11".repeat(32)}` as `0x${string}`, env.providerWallet);
      await a.complete(jobId, `0x${"00".repeat(32)}` as `0x${string}`);
      expect(await env.usdcBalanceOf(env.providerAddr)).toBe(400_000n);
    } finally {
      await env.stop();
    }
  }, 60_000);
});

/**
 * THE TWO REFUNDS, AGAINST A REAL CHAIN AND THE REAL DOUBLE.
 *
 * The saga tests measure what the backend DECIDES; these measure what the contract ACCEPTS —
 * the roles, the deadline and the direction the money travels — against `MockERC8183Job` on
 * anvil, whose rules are the deployed implementation's.
 */
describe("JobAdapter refunds", () => {
  /** Anvil's clock, moved past a deadline. `evm_increaseTime` alone does not mine a block. */
  const warp = async (rpcUrl: string, seconds: number) => {
    for (const [id, method, params] of [
      [1, "evm_increaseTime", [seconds]],
      [2, "evm_mine", []],
    ] as const) {
      await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    }
  };

  const REASON = `0x${"5a".repeat(32)}` as `0x${string}`;

  test("the evaluator rejects a funded job and the client's USDC comes back", async () => {
    const env = await deployMockJob();
    try {
      await env.mintUsdc(env.clientAddr, 1_000_000n);
      const a = new JobAdapter({
        publicClient: env.publicClient,
        clientWallet: env.clientWallet,
        evaluatorWallet: env.evaluatorWallet,
        jobContract: env.jobAddr,
      });
      const { jobId } = await a.createJob({
        provider: env.providerAddr,
        evaluator: env.evaluatorAddr,
        expiredAt: 9_999_999_999n,
        description: "demo",
      });
      await a.setBudget(jobId, 500_000n, env.providerWallet);
      await a.approveAndFund(jobId, env.usdcAddr, 500_000n);
      expect(await env.usdcBalanceOf(env.clientAddr)).toBe(500_000n);

      await a.reject(jobId, REASON, env.evaluatorWallet);

      expect(await a.escrowState(jobId)).toEqual({
        status: 4, // Rejected
        budget: 500_000n,
        expiredAt: 9_999_999_999n,
        client: env.clientAddr,
        // WHO WAS ENTITLED to reject it, read from the chain rather than assumed from our config.
        evaluator: env.evaluatorAddr,
      });
      // Back where it came from, to the last unit — and not to the evaluator who sent it.
      expect(await env.usdcBalanceOf(env.clientAddr)).toBe(1_000_000n);
      expect(await env.usdcBalanceOf(env.jobAddr)).toBe(0n);
      expect(await env.usdcBalanceOf(env.evaluatorAddr)).toBe(0n);
    } finally {
      await env.stop();
    }
  }, 60_000);

  test("past its deadline the client claims the refund itself", async () => {
    const env = await deployMockJob();
    try {
      await env.mintUsdc(env.clientAddr, 1_000_000n);
      const a = new JobAdapter({
        publicClient: env.publicClient,
        clientWallet: env.clientWallet,
        // No evaluator key: the deployment where the only refund left is the expiry one.
        jobContract: env.jobAddr,
      });
      const block = await env.publicClient.getBlock();
      const expiredAt = block.timestamp + 60n;
      const { jobId } = await a.createJob({
        provider: env.providerAddr,
        evaluator: env.evaluatorAddr,
        expiredAt,
        description: "demo",
      });
      await a.setBudget(jobId, 400_000n, env.providerWallet);
      await a.approveAndFund(jobId, env.usdcAddr, 400_000n);

      // Before the deadline the contract refuses, and the escrow does not move.
      await expect(a.claimRefund(jobId)).rejects.toThrow(/not expired|reverted/);
      expect((await a.escrowState(jobId)).status).toBe(1); // still Funded
      expect(await env.usdcBalanceOf(env.jobAddr)).toBe(400_000n);

      await warp(env.rpcUrl, 120);
      await a.claimRefund(jobId);

      expect((await a.escrowState(jobId)).status).toBe(5); // Expired
      expect(await env.usdcBalanceOf(env.clientAddr)).toBe(1_000_000n);
      expect(await env.usdcBalanceOf(env.jobAddr)).toBe(0n);
    } finally {
      await env.stop();
    }
  }, 60_000);

  test("a reject from the wrong signer is refused, and the escrow stays put", async () => {
    const env = await deployMockJob();
    try {
      await env.mintUsdc(env.clientAddr, 1_000_000n);
      const a = new JobAdapter({
        publicClient: env.publicClient,
        clientWallet: env.clientWallet,
        evaluatorWallet: env.evaluatorWallet,
        jobContract: env.jobAddr,
      });
      const { jobId } = await a.createJob({
        provider: env.providerAddr,
        evaluator: env.evaluatorAddr,
        expiredAt: 9_999_999_999n,
        description: "demo",
      });
      await a.setBudget(jobId, 300_000n, env.providerWallet);
      await a.approveAndFund(jobId, env.usdcAddr, 300_000n);

      // Neither the client nor the evaluator of this job: the contract does not care who pays
      // the gas, it cares who is entitled to end the job.
      await expect(a.reject(jobId, REASON, env.strangerWallet)).rejects.toThrow(
        /not client or evaluator|reverted/,
      );
      // And the CLIENT is refused too, because this job is not Open any more.
      await expect(a.reject(jobId, REASON, env.clientWallet)).rejects.toThrow(
        /client: not open|reverted/,
      );

      expect((await a.escrowState(jobId)).status).toBe(1); // still Funded
      expect(await env.usdcBalanceOf(env.jobAddr)).toBe(300_000n);
      expect(await env.usdcBalanceOf(env.strangerAddr)).toBe(0n);
    } finally {
      await env.stop();
    }
  }, 60_000);
});
