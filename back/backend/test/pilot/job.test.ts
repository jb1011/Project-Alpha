/**
 * The pilot job over the fake node: the buyer creates and funds, the seller sets the budget and
 * submits, and the case row follows each mined step. Real JobAdapter, real local signers, real
 * SQLite; the node runs the ERC-20 allowance and the job's status the way the contract does.
 *
 * The node mines `setBudget` and `submit` without changing the job (the budget arrives with the
 * job, from the node's options), so the signers and the order are asserted here and submit's
 * effect on the contract is proven on anvil (`job.int.test.ts`).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, expect, test, vi } from "vitest";
import { JobAdapter } from "../../src/adapters/arc/jobAdapter";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import type { ByAgentAnswer } from "../../src/api/routes/legalBodyStatements";
import type { Config } from "../../src/config/env";
import {
  ChainTxRevertedError,
  ChainTxUnconfirmedError,
  JobFundRevertedError,
} from "../../src/errors";
import type { SignedStatementJson } from "../../src/legalBody/publicStatement";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository } from "../../src/pilot/casesRepository";
import { buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import {
  type CreatePilotJobInput,
  type PilotJobDeps,
  createPilotJob,
  preflightPilotJob,
} from "../../src/pilot/job";
import type { LookupClient } from "../../src/pilot/lookup";
import {
  JOB_CONTRACT,
  USDC,
  evaluatorAccount,
  fakeChain,
  jobClientAccount,
  usdcJobNode,
} from "../helpers/jobFundHarness";

/** anvil's account #3: the seller. The buyer and the referee are the harness's #1 and #2. */
const sellerAccount = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
const BUYER = jobClientAccount.address as Address;
const SELLER = sellerAccount.address as Address;
const REFEREE = evaluatorAccount.address as Address;
const REGISTRY = "0x0000000000000000000000000000000000000005" as Address;
const BUYER_AGENT = "41";
const SELLER_AGENT = "42";
/** 0.5 USDC: what the node's fund pulls. */
const BUDGET = 500_000n;
const NOW = 1_800_000_000;
const DELIVERABLE = new TextEncoder().encode("date,amount\n2026-10-01,12.50\n");

const statement = (legalName: string) =>
  ({ message: { legalName } }) as unknown as SignedStatementJson;
const activeAnswer = (agentId: string, legalName: string): ByAgentAnswer => ({
  agentId,
  legalBody: true,
  standing: "active",
  publicId: `nc_${agentId}`,
  network: "testnet",
  links: { transparency: "https://api.example.com/t", statement: "https://api.example.com/s" },
  checkedAt: "2026-10-28T00:00:00.000Z",
  statement: statement(legalName),
});

beforeEach(() => resetSenderNonces());

function setup(
  o: {
    answers?: Record<string, ByAgentAnswer | Error>;
    owners?: Record<string, Address>;
    buyerBalance?: bigint;
    stealAllowanceOnFund?: boolean;
    withholdReceipt?: "fund";
  } = {},
) {
  const node = usdcJobNode({
    usdc: USDC,
    jobContract: JOB_CONTRACT,
    budget: BUDGET,
    now: () => NOW,
    identityRegistry: REGISTRY,
    ownerOf: (id) => (o.owners ?? { [BUYER_AGENT]: BUYER, [SELLER_AGENT]: SELLER })[id.toString()],
    stealAllowanceOnFund: o.stealAllowanceOnFund,
    withholdReceipt: o.withholdReceipt,
  });
  node.mint(BUYER, o.buyerBalance ?? 10_000_000n);
  const db = openDatabase(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "pilot-job-")));
  const cfg = {
    chainId: fakeChain.id,
    usdc: USDC,
    jobContract: JOB_CONTRACT,
    identityRegistry: REGISTRY,
    arcExplorerUrl: "https://explorer.example.com",
  } as unknown as Config;
  const ctx = {
    cfg,
    publicClient: node.publicClient,
    sendClient: node.sendClient,
    wallets: {
      buyer: node.walletFor(jobClientAccount),
      seller: node.walletFor(sellerAccount),
      referee: node.walletFor(evaluatorAccount),
    },
    addresses: { buyer: BUYER, seller: SELLER, referee: REFEREE },
  } as unknown as PilotContext;
  const chain = buildPilotChain(ctx);
  if (o.withholdReceipt)
    // A short receipt bound, so an unconfirmed fund is reported in milliseconds, not a minute.
    chain.job = new JobAdapter({
      publicClient: node.publicClient,
      clientWallet: ctx.wallets.buyer,
      evaluatorWallet: ctx.wallets.referee,
      sendClient: node.sendClient,
      jobContract: JOB_CONTRACT,
      receiptTimeoutMs: 300,
    });
  const answers: Record<string, ByAgentAnswer | Error> = o.answers ?? {
    [BUYER_AGENT]: activeAnswer(BUYER_AGENT, "Buyer Agent LLC"),
    [SELLER_AGENT]: activeAnswer(SELLER_AGENT, "Seller Agent LLC"),
  };
  const lookup: LookupClient = {
    byAgent: async (id) => {
      const a = answers[id];
      if (a === undefined) throw new Error(`no answer scripted for ${id}`);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  const deps: PilotJobDeps = {
    chain,
    cases,
    docStore,
    lookup,
    agentIds: { buyer: BUYER_AGENT, seller: SELLER_AGENT },
    now: () => NOW,
    maxBudgetAtomic: 2_000_000n,
  };
  return { node, cases, deps, chain };
}

const input = (over: Partial<CreatePilotJobInput> = {}): CreatePilotJobInput => ({
  label: "test case 1",
  description: "Monthly expense report as a CSV",
  deliverable: { bytes: DELIVERABLE, extension: "csv" },
  budgetAtomic: BUDGET,
  expirySeconds: 7 * 86_400,
  mode: "testnet",
  ...over,
});

test("the four steps, in order, with the right signers; the row ends at submitted with every hash", async () => {
  const { node, cases, deps } = setup();
  const row = await createPilotJob(deps, input());

  expect(node.actions.map((a) => [a.call, a.from])).toEqual([
    ["createJob", BUYER],
    ["other", SELLER], // setBudget
    ["approve", BUYER],
    ["fund", BUYER],
    ["other", SELLER], // submit
  ]);
  expect(node.sendsFrom(SELLER)).toHaveLength(2);
  expect(node.sendsFrom(REFEREE)).toEqual([]);
  const [setBudgetHash, submitHash] = node.sendsFrom(SELLER).map((s) => s.hash);

  expect(row.status).toBe("submitted");
  expect(row.mode).toBe("testnet");
  expect(row.jobId).toBe("1");
  expect(row.chainId).toBe(fakeChain.id);
  expect(row.jobContract.toLowerCase()).toBe(JOB_CONTRACT.toLowerCase());
  expect(row.buyerAddress).toBe(BUYER);
  expect(row.sellerAddress).toBe(SELLER);
  expect(row.refereeAddress).toBe(REFEREE);
  expect(row.buyerAgentId).toBe(BUYER_AGENT);
  expect(row.sellerAgentId).toBe(SELLER_AGENT);
  expect(row.budgetAtomic).toBe(BUDGET.toString());
  expect(row.expiredAt).toBe(NOW + 7 * 86_400);
  expect(node.chainJob(1n)).toMatchObject({
    client: BUYER,
    provider: SELLER,
    evaluator: REFEREE,
    expiredAt: BigInt(NOW + 7 * 86_400),
    description: "Monthly expense report as a CSV",
    status: 1,
  });
  expect(node.escrowOf(1n)).toBe(BUDGET);

  expect(row.createTxHash).toBe(node.hashesOf("createJob")[0]);
  expect(row.fundTxHash).toBe(node.hashesOf("fund")[0]);
  expect(row.submitTxHash).toBe(submitHash);
  expect(row.createdBlockTime).toBe(NOW);
  expect(row.fundedBlockTime).toBe(NOW);
  expect(row.submittedBlockTime).toBe(NOW);

  expect(row.deliverableHash).toBe(keccak256(DELIVERABLE));
  expect(row.deliverableExtension).toBe("csv");
  expect(row.deliverablePath).toMatch(new RegExp(`pilot-${row.caseId}-deliverable\\.csv$`));
  expect(new Uint8Array(readFileSync(row.deliverablePath!))).toEqual(DELIVERABLE);

  expect(cases.events(row.caseId).map((e) => [e.step, e.status, e.ref])).toEqual([
    ["create", "mined", row.createTxHash],
    ["setBudget", "mined", setBudgetHash],
    ["fund", "mined", row.fundTxHash],
    ["submit", "mined", row.submitTxHash],
  ]);
  expect(cases.find(row.caseId)).toEqual(row);
});

test("pre-flight passes with both bodies active, both owners right, the balance and the expiry in range", async () => {
  const { node, deps } = setup();
  const pre = await preflightPilotJob(deps, input());
  expect(pre).toEqual({
    ok: true,
    buyerBalance: 10_000_000n,
    buyerName: "Buyer Agent LLC",
    sellerName: "Seller Agent LLC",
  });
  expect(node.sends).toEqual([]);
});

const pending = { ...activeAnswer(SELLER_AGENT, "Seller Agent LLC"), standing: "pending" };
const noBody: ByAgentAnswer = {
  agentId: BUYER_AGENT,
  legalBody: false,
  standing: null,
  checkedAt: "2026-10-28T00:00:00.000Z",
};
const unknownBody: ByAgentAnswer = {
  agentId: SELLER_AGENT,
  legalBody: true,
  standing: "unknown",
  publicId: null,
  network: "testnet",
  links: { transparency: "https://api.example.com/t" },
  checkedAt: "2026-10-28T00:00:00.000Z",
  statement: null,
};
const STRANGER = "0x00000000000000000000000000000000000000aa" as Address;

test.each<[string, Parameters<typeof setup>[0], Partial<CreatePilotJobInput>, RegExp]>([
  [
    "the seller's standing is not active",
    {
      answers: {
        [BUYER_AGENT]: activeAnswer(BUYER_AGENT, "B"),
        [SELLER_AGENT]: pending as ByAgentAnswer,
      },
    },
    {},
    /seller.*pending/,
  ],
  [
    "the buyer has no legal body",
    { answers: { [BUYER_AGENT]: noBody, [SELLER_AGENT]: activeAnswer(SELLER_AGENT, "S") } },
    {},
    /buyer.*no legal body/,
  ],
  [
    "the seller's statement is missing",
    { answers: { [BUYER_AGENT]: activeAnswer(BUYER_AGENT, "B"), [SELLER_AGENT]: unknownBody } },
    {},
    /seller/,
  ],
  [
    "the lookup fails",
    {
      answers: {
        [BUYER_AGENT]: new Error("the legal-body lookup for agent 41 answered 503"),
        [SELLER_AGENT]: activeAnswer(SELLER_AGENT, "S"),
      },
    },
    {},
    /buyer.*503/,
  ],
  [
    "the buyer's agent is owned by another address",
    { owners: { [BUYER_AGENT]: STRANGER, [SELLER_AGENT]: SELLER } },
    {},
    /buyer.*owned by/,
  ],
  ["the seller's agent does not exist", { owners: { [BUYER_AGENT]: BUYER } }, {}, /seller.*42/],
  [
    "the buyer's balance is below the budget plus 0.5 USDC",
    { buyerBalance: 999_999n },
    {},
    /balance/,
  ],
  ["the budget is above the maximum", {}, { budgetAtomic: 2_000_001n }, /budget/],
  ["a testnet expiry under a day", {}, { expirySeconds: 86_399 }, /expiry/],
  ["a testnet expiry over thirty days", {}, { expirySeconds: 2_592_001 }, /expiry/],
  ["a live expiry under a day", {}, { mode: "live", expirySeconds: 3_600 }, /expiry/],
  ["a live expiry over thirty days", {}, { mode: "live", expirySeconds: 2_592_001 }, /expiry/],
  ["a rehearsal expiry under two minutes", {}, { mode: "rehearsal", expirySeconds: 119 }, /expiry/],
])("pre-flight refuses when %s, and nothing is sent", async (_name, o, over, problem) => {
  const { node, cases, deps } = setup(o);
  const pre = await preflightPilotJob(deps, input(over));
  expect(pre.ok).toBe(false);
  expect(pre.ok === false && pre.problem).toMatch(problem);
  await expect(createPilotJob(deps, input(over))).rejects.toThrow(problem);
  expect(node.sends).toEqual([]);
  expect(cases.list()).toEqual([]);
});

test("the expiry bounds are inclusive, and rehearsal accepts two minutes", async () => {
  const { deps } = setup();
  for (const [mode, expirySeconds] of [
    ["testnet", 86_400],
    ["testnet", 2_592_000],
    ["live", 86_400],
    ["rehearsal", 120],
  ] as const)
    expect((await preflightPilotJob(deps, input({ mode, expirySeconds }))).ok).toBe(true);
});

test("a reverted fund leaves the row at created with an event carrying the hash; resuming funds and submits", async () => {
  const { node, cases, deps } = setup({ stealAllowanceOnFund: true });
  const err = await createPilotJob(deps, input()).catch((e) => e);
  expect(err).toBeInstanceOf(JobFundRevertedError);
  const [row] = cases.list();
  expect(row?.status).toBe("created");
  expect(row?.fundTxHash).toBeNull();
  const revertedFund = node.hashesOf("fund")[0];
  expect(cases.events(row!.caseId).at(-1)).toMatchObject({
    step: "fund",
    status: "reverted",
    ref: revertedFund,
  });

  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.status).toBe("submitted");
  expect(done.caseId).toBe(row!.caseId);
  expect(done.createTxHash).toBe(row!.createTxHash);
  expect(done.fundTxHash).toBe(node.hashesOf("fund")[1]);
  // One job: the resume did not create a second one.
  expect(node.hashesOf("createJob")).toHaveLength(1);
  expect(node.actions.map((a) => a.call)).toEqual([
    "createJob",
    "other",
    "approve",
    "fund",
    "other",
    "approve",
    "fund",
    "other",
  ]);
  expect(node.sendsFrom(SELLER)).toHaveLength(3);
});

test("a reverted submit leaves the row at funded with the hash in an event; resuming submits once", async () => {
  const { node, cases, deps, chain } = setup();
  const failedSubmit = `0x${"51".repeat(32)}` as Hex;
  vi.spyOn(chain.job, "submit").mockRejectedValueOnce(
    new ChainTxRevertedError("submit", failedSubmit),
  );
  await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(ChainTxRevertedError);
  const [row] = cases.list();
  expect(row?.status).toBe("funded");
  expect(row?.submitTxHash).toBeNull();
  expect(cases.events(row!.caseId).at(-1)).toMatchObject({
    step: "submit",
    status: "reverted",
    ref: failedSubmit,
  });

  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.status).toBe("submitted");
  expect(done.fundTxHash).toBe(row!.fundTxHash);
  expect(node.hashesOf("fund")).toHaveLength(1);
  expect(node.hashesOf("approve")).toHaveLength(1);
  expect(done.submitTxHash).toBe(node.sendsFrom(SELLER).at(-1)?.hash);
});

test("an unconfirmed submit is recorded as unconfirmed with its hash, and the row stays at funded", async () => {
  const { cases, deps, chain } = setup();
  const sent = `0x${"52".repeat(32)}` as Hex;
  vi.spyOn(chain.job, "submit").mockRejectedValueOnce(new ChainTxUnconfirmedError("submit", sent));
  await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(ChainTxUnconfirmedError);
  const [row] = cases.list();
  expect(row?.status).toBe("funded");
  expect(cases.events(row!.caseId).at(-1)).toMatchObject({
    step: "submit",
    status: "unconfirmed",
    ref: sent,
  });
});

test("an unconfirmed fund that landed: the resume reads Funded on chain, adopts the fund hash and submits", async () => {
  const { node, cases, deps } = setup({ withholdReceipt: "fund" });
  await expect(createPilotJob(deps, input())).rejects.toThrow(/could not confirm/);
  const [row] = cases.list();
  expect(row?.status).toBe("created");
  const fundHash = node.hashesOf("fund")[0];
  expect(cases.events(row!.caseId).at(-1)).toMatchObject({
    step: "fund",
    status: "unconfirmed",
    ref: fundHash,
  });
  expect(node.chainJob(1n)?.status).toBe(1);

  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.status).toBe("submitted");
  expect(done.fundTxHash).toBe(fundHash);
  expect(node.hashesOf("fund")).toHaveLength(1);
});

test("resuming refuses a row that is not at created or funded, an unknown case and another mode", async () => {
  const { node, deps } = setup();
  const row = await createPilotJob(deps, input());
  const sent = node.sends.length;
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(/submitted/);
  await expect(createPilotJob(deps, input(), "pc_000000000000")).rejects.toThrow(/pc_000000000000/);
  expect(node.sends).toHaveLength(sent);

  const { cases: cases2, deps: deps2, node: node2, chain } = setup();
  vi.spyOn(chain.job, "submit").mockRejectedValueOnce(
    new ChainTxRevertedError("submit", `0x${"53".repeat(32)}` as Hex),
  );
  await expect(createPilotJob(deps2, input())).rejects.toThrow();
  const [funded] = cases2.list();
  const before = node2.sends.length;
  await expect(createPilotJob(deps2, input({ mode: "live" }), funded!.caseId)).rejects.toThrow(
    /testnet/,
  );
  expect(node2.sends).toHaveLength(before);
});
