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
