/**
 * `claimRefund` signs with the job client unless the caller passes another local wallet.
 *
 * The refund goes to the job's client whoever sends it, so the platform keeps sending it as the
 * client. The pilot's referee holds no client key of the platform's, so it passes the buyer's
 * wallet or its own: the call must send from the wallet it is handed.
 */
import type { Address } from "viem";
import { beforeEach, expect, test } from "vitest";
import { JobAdapter } from "../../../src/adapters/arc/jobAdapter";
import { resetSenderNonces } from "../../../src/adapters/arc/senderLock";
import {
  JOB_CONTRACT,
  USDC,
  ZERO_ADDRESS,
  evaluatorAccount,
  jobClientAccount,
  usdcJobNode,
} from "../../helpers/jobFundHarness";

const BUDGET = 500_000n;
const JOB_ID = 7n;

beforeEach(() => resetSenderNonces());

/** A funded job whose expiry is already behind the node's clock, so claimRefund succeeds. */
function expiredFundedJob() {
  const node = usdcJobNode({
    usdc: USDC,
    jobContract: JOB_CONTRACT,
    budget: BUDGET,
    now: () => 100,
  });
  node.mint(jobClientAccount.address as Address, BUDGET);
  node.seedChainJob({
    id: JOB_ID,
    client: jobClientAccount.address as Address,
    provider: ZERO_ADDRESS,
    evaluator: evaluatorAccount.address as Address,
    description: "demo",
    budget: BUDGET,
    expiredAt: 50n,
    status: 1,
    hook: ZERO_ADDRESS,
  });
  const adapter = new JobAdapter({
    publicClient: node.publicClient,
    clientWallet: node.walletFor(jobClientAccount),
    evaluatorWallet: node.walletFor(evaluatorAccount),
    sendClient: node.sendClient,
    jobContract: JOB_CONTRACT,
  });
  return { node, adapter };
}

test("without a wallet, claimRefund is sent by the job client", async () => {
  const { node, adapter } = expiredFundedJob();
  const h = await adapter.claimRefund(JOB_ID);
  expect(node.hashesOf("claimRefund")).toEqual([h]);
  expect(node.sendsFrom(jobClientAccount.address as Address).map((s) => s.hash)).toEqual([h]);
  expect(node.sendsFrom(evaluatorAccount.address as Address)).toEqual([]);
  expect(node.chainJob(JOB_ID)?.status).toBe(5);
  expect(node.balanceOf(jobClientAccount.address)).toBe(BUDGET);
});

test("a passed wallet signs claimRefund, and the refund still goes to the client", async () => {
  const { node, adapter } = expiredFundedJob();
  const h = await adapter.claimRefund(JOB_ID, node.walletFor(evaluatorAccount));
  expect(node.sendsFrom(evaluatorAccount.address as Address).map((s) => s.hash)).toEqual([h]);
  expect(node.sendsFrom(jobClientAccount.address as Address)).toEqual([]);
  expect(node.chainJob(JOB_ID)?.status).toBe(5);
  expect(node.balanceOf(jobClientAccount.address)).toBe(BUDGET);
});
