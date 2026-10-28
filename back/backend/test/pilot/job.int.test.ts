/**
 * The pilot job end to end on anvil: MockUSDC, MockERC8183Job and MockIdentityRegistry, the
 * buyer as the job's client, the seller as its provider, the referee as its evaluator. Here the
 * contract enforces who may call what, so the signers are proven by the calls succeeding, and the
 * `Submitted` log proves the deliverable's hash reached the chain.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  http,
  type Address,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  getAddress,
  keccak256,
} from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mockErc8183JobAbi, mockIdentityRegistryAbi } from "../../src/abis/generated";
import type { ByAgentAnswer } from "../../src/api/routes/legalBodyStatements";
import { anvilChain } from "../../src/chains";
import type { Config } from "../../src/config/env";
import type { SignedStatementJson } from "../../src/legalBody/publicStatement";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository } from "../../src/pilot/casesRepository";
import { buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import { type PilotJobDeps, createPilotJob, preflightPilotJob } from "../../src/pilot/job";
import type { LookupClient } from "../../src/pilot/lookup";
import { type MockJobEnv, deployMockJob } from "../helpers/anvilJob";
import { loadArtifact } from "../helpers/artifacts";

const BUDGET = 500_000n;
const DELIVERABLE = new TextEncoder().encode("date,amount\n2026-10-01,12.50\n");

let env: MockJobEnv;
let registry: Address;
const agentIds = { buyer: "", seller: "" };

async function deployRegistry(wallet: WalletClient, pub: PublicClient): Promise<Address> {
  const { abi, bytecode } = loadArtifact("MockIdentityRegistry");
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [],
    account: wallet.account!,
    chain: wallet.chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("MockIdentityRegistry deploy produced no address");
  return getAddress(receipt.contractAddress);
}

async function register(wallet: WalletClient): Promise<string> {
  const { request, result } = await env.publicClient.simulateContract({
    address: registry,
    abi: mockIdentityRegistryAbi,
    functionName: "register",
    args: [""],
    account: wallet.account!,
  });
  const hash = await wallet.writeContract(request);
  await env.publicClient.waitForTransactionReceipt({ hash });
  return result.toString();
}

const active = (agentId: string, legalName: string): ByAgentAnswer => ({
  agentId,
  legalBody: true,
  standing: "active",
  publicId: `nc_${agentId}`,
  network: "testnet",
  links: { transparency: "https://api.example.com/t", statement: "https://api.example.com/s" },
  checkedAt: "2026-10-28T00:00:00.000Z",
  statement: { message: { legalName } } as unknown as SignedStatementJson,
});

beforeAll(async () => {
  env = await deployMockJob();
  registry = await deployRegistry(env.clientWallet, env.publicClient);
  agentIds.buyer = await register(env.clientWallet);
  agentIds.seller = await register(env.providerWallet);
  await env.mintUsdc(env.clientAddr, 5_000_000n);
});

afterAll(() => env?.stop());

test("the buyer creates and funds, the seller submits, and the Submitted log carries the deliverable's hash", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const cfg = {
    chainId: anvilChain.id,
    usdc: env.usdcAddr,
    jobContract: env.jobAddr,
    identityRegistry: registry,
    arcExplorerUrl: "https://explorer.example.com",
  } as unknown as Config;
  const ctx = {
    cfg,
    publicClient: env.publicClient,
    sendClient: createPublicClient({ chain: anvilChain, transport: http(env.rpcUrl) }),
    wallets: { buyer: env.clientWallet, seller: env.providerWallet, referee: env.evaluatorWallet },
    addresses: { buyer: env.clientAddr, seller: env.providerAddr, referee: env.evaluatorAddr },
  } as unknown as PilotContext;
  const lookup: LookupClient = {
    byAgent: async (id) =>
      id === agentIds.buyer ? active(id, "Buyer Agent LLC") : active(id, "Seller Agent LLC"),
  };
  const deps: PilotJobDeps = {
    chain: buildPilotChain(ctx),
    cases,
    docStore: new FileDocumentStore(mkdtempSync(join(tmpdir(), "pilot-job-int-"))),
    lookup,
    agentIds: { ...agentIds },
    maxBudgetAtomic: 2_000_000n,
  };
  const input = {
    label: "test case 1",
    description: "Monthly expense report as a CSV",
    deliverable: { bytes: DELIVERABLE, extension: "csv" },
    budgetAtomic: BUDGET,
    expirySeconds: 7 * 86_400,
    mode: "testnet" as const,
  };

  const pre = await preflightPilotJob(deps, input);
  expect(pre).toMatchObject({
    ok: true,
    buyerName: "Buyer Agent LLC",
    sellerName: "Seller Agent LLC",
  });

  const before = await env.usdcBalanceOf(env.clientAddr);
  const row = await createPilotJob(deps, input);

  expect(row.status).toBe("submitted");
  expect(row.deliverableHash).toBe(keccak256(DELIVERABLE));
  expect(new Uint8Array(readFileSync(row.deliverablePath!))).toEqual(DELIVERABLE);
  for (const h of [row.createTxHash, row.fundTxHash, row.submitTxHash])
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  expect(row.createdBlockTime).toBeGreaterThan(0);
  expect(row.fundedBlockTime).toBeGreaterThanOrEqual(row.createdBlockTime!);
  expect(row.submittedBlockTime).toBeGreaterThanOrEqual(row.fundedBlockTime!);

  const jobId = BigInt(row.jobId!);
  const job = await deps.chain.job.getJob(jobId);
  expect(job).toMatchObject({
    client: env.clientAddr,
    provider: env.providerAddr,
    evaluator: env.evaluatorAddr,
    budget: BUDGET,
    expiredAt: BigInt(row.expiredAt),
    status: 2,
  });
  expect(await env.usdcBalanceOf(env.clientAddr)).toBe(before - BUDGET);
  expect(await env.usdcBalanceOf(env.jobAddr)).toBe(BUDGET);

  const logs = await env.publicClient.getContractEvents({
    address: env.jobAddr,
    abi: mockErc8183JobAbi,
    eventName: "Submitted",
    args: { jobId },
    fromBlock: 0n,
  });
  expect(logs).toHaveLength(1);
  expect(logs[0]?.args.deliverable).toBe(keccak256(DELIVERABLE));
  expect(logs[0]?.transactionHash).toBe(row.submitTxHash);

  const submitTx = await env.publicClient.getTransaction({
    hash: row.submitTxHash as `0x${string}`,
  });
  expect(submitTx.from.toLowerCase()).toBe(env.providerAddr.toLowerCase());
  const fundTx = await env.publicClient.getTransaction({ hash: row.fundTxHash as `0x${string}` });
  expect(fundTx.from.toLowerCase()).toBe(env.clientAddr.toLowerCase());
});
