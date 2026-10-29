/**
 * The pilot job over the fake node: the buyer creates and funds, the seller sets the budget and
 * submits, and the case row follows each mined step. Real JobAdapter, real local signers, real
 * SQLite; the node runs the ERC-20 allowance and the job's status the way the contract does.
 *
 * The node mines `setBudget` and `submit` without changing the job (the budget arrives with the
 * job, from the node's options), so the signers and the order are asserted here and submit's
 * effect on the contract is proven on anvil (`job.int.test.ts`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, keccak256, parseEventLogs } from "viem";
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
  pilotCaseIdOf,
  preflightPilotJob,
} from "../../src/pilot/job";
import { jobSubmittedEventAbi } from "../../src/pilot/jobEvents";
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
    withholdReceipt?: "fund" | "submit";
    runSubmit?: boolean;
    omitSubmittedLog?: boolean;
    skewJobSubmittedLog?: { deliverable?: Hex; provider?: Address };
    emitJobCreatedLog?: boolean;
    skewJobCreatedId?: bigint;
  } = {},
) {
  /** The clock in seconds, shared by the node and the job; a test moves it with `setClock`. */
  let clock = NOW;
  const node = usdcJobNode({
    usdc: USDC,
    jobContract: JOB_CONTRACT,
    budget: BUDGET,
    now: () => clock,
    runSubmit: o.runSubmit,
    omitSubmittedLog: o.omitSubmittedLog,
    skewJobSubmittedLog: o.skewJobSubmittedLog,
    emitJobCreatedLog: o.emitJobCreatedLog,
    skewJobCreatedId: o.skewJobCreatedId,
    // A submit is adopted from its transaction, so the node answers what it accepted.
    answerTransactions: true,
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
    [BUYER_AGENT]: activeAnswer(BUYER_AGENT, "Buyer Agent DAO LLC"),
    [SELLER_AGENT]: activeAnswer(SELLER_AGENT, "Seller Agent DAO LLC"),
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
    now: () => clock,
    maxBudgetAtomic: 2_000_000n,
  };
  const setClock = (t: number) => {
    clock = t;
  };
  return { node, cases, deps, chain, answers, setClock, docStore };
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
  const { node, cases, deps, docStore } = setup();
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
  // The store's id, which is what the store reads by; not a path on disk.
  expect(row.deliverablePath).toBe(`pilot-${row.caseId}-deliverable.csv`);
  expect(new Uint8Array(docStore.getBytes(row.deliverablePath!))).toEqual(DELIVERABLE);

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
    buyerName: "Buyer Agent DAO LLC",
    sellerName: "Seller Agent DAO LLC",
  });
  expect(node.sends).toEqual([]);
});

const pending = { ...activeAnswer(SELLER_AGENT, "Seller Agent DAO LLC"), standing: "pending" };
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
  [
    "a rehearsal expiry over thirty days",
    {},
    { mode: "rehearsal", expirySeconds: 2_592_001 },
    /expiry must be between 120 and 2592000 seconds in rehearsal mode/,
  ],
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
    ["rehearsal", 2_592_000],
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

test("an error's em dash is persisted in the event detail as a colon", async () => {
  const { cases, deps, chain } = setup();
  const failedSubmit = `0x${"55".repeat(32)}` as Hex;
  const error = new ChainTxRevertedError("submit", failedSubmit);
  expect(error.message).toContain("\u2014");
  vi.spyOn(chain.job, "submit").mockRejectedValueOnce(error);
  await expect(createPilotJob(deps, input())).rejects.toBe(error);
  const [row] = cases.list();
  const detail = cases.events(row!.caseId).at(-1)?.detail ?? "";
  expect(detail).not.toContain("\u2014");
  expect(detail).toMatch(/reverted on chain \(.*\): the transaction was mined/);
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

  // Without its receipt the fund is not proven, and the row stays at created.
  await expect(createPilotJob(deps, input(), row!.caseId)).rejects.toThrow(
    /has a receipt that could not be read yet/,
  );
  expect(cases.find(row!.caseId)?.status).toBe("created");

  node.releaseWithheld();
  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.status).toBe("submitted");
  expect(done.fundTxHash).toBe(fundHash);
  // The block time comes from the adopted fund's receipt, as for a fund this run saw mined.
  expect(done.fundedBlockTime).toBe(NOW);
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

// ── A submit that landed while the row stayed at funded ─────────────────────────────────────────

test("an unconfirmed submit that landed: the resume reads the JobSubmitted log, checks the hash and adopts it", async () => {
  const { node, cases, deps, chain, docStore } = setup({
    runSubmit: true,
    withholdReceipt: "submit",
  });
  await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(ChainTxUnconfirmedError);
  const [row] = cases.list();
  expect(row?.status).toBe("funded");
  const submitHash = node.hashesOf("submit")[0];
  expect(cases.events(row!.caseId).at(-1)).toMatchObject({
    step: "submit",
    status: "unconfirmed",
    ref: submitHash,
  });
  expect(node.chainJob(1n)?.status).toBe(2);

  // Still no receipt: the resume refuses and the row stays where it is.
  await expect(createPilotJob(deps, input(), row!.caseId)).rejects.toThrow(/receipt/);
  expect(cases.find(row!.caseId)?.status).toBe("funded");

  node.releaseWithheld();
  // The receipt carries the deployed contract's log: this job, the seller, the deliverable.
  const [logged] = parseEventLogs({
    abi: jobSubmittedEventAbi,
    logs: (await chain.publicClient.getTransactionReceipt({ hash: submitHash! })).logs,
  });
  expect(logged?.args).toEqual({
    jobId: 1n,
    provider: SELLER,
    deliverable: keccak256(DELIVERABLE),
  });
  const sends = node.sends.length;
  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.status).toBe("submitted");
  expect(done.submitTxHash).toBe(submitHash);
  expect(done.submittedBlockTime).toBe(NOW);
  expect(done.deliverableHash).toBe(keccak256(DELIVERABLE));
  expect(new Uint8Array(docStore.getBytes(done.deliverablePath!))).toEqual(DELIVERABLE);
  expect(node.sends).toHaveLength(sends);
  expect(cases.events(row!.caseId).at(-1)).toMatchObject({
    step: "submit",
    status: "observed_on_chain",
    ref: submitHash,
  });
});

test("a mined submit whose block read failed once is adopted on resume, with no second submit", async () => {
  const { node, cases, deps, chain } = setup({ runSubmit: true });
  const getBlock = chain.publicClient.getBlock.bind(chain.publicClient);
  let reads = 0;
  vi.spyOn(chain.publicClient, "getBlock").mockImplementation(async (args) => {
    reads += 1;
    // The create's and the fund's block reads pass; the submit's fails.
    if (reads === 3) throw new Error("the block read failed");
    return getBlock(args as never);
  });
  await expect(createPilotJob(deps, input())).rejects.toThrow(/block read failed/);
  const [row] = cases.list();
  expect(row?.status).toBe("funded");
  const submitHash = node.hashesOf("submit")[0];
  expect(cases.events(row!.caseId).at(-1)).toMatchObject({
    step: "submit",
    status: "mined",
    ref: submitHash,
  });

  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.status).toBe("submitted");
  expect(done.submitTxHash).toBe(submitHash);
  expect(done.submittedBlockTime).toBe(NOW);
  expect(node.hashesOf("submit")).toHaveLength(1);
});

test("adopting a submit refuses when the deliverable given does not hash to the one on chain", async () => {
  const { node, cases, deps } = setup({ runSubmit: true, withholdReceipt: "submit" });
  await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(ChainTxUnconfirmedError);
  node.releaseWithheld();
  const [row] = cases.list();
  const other = new TextEncoder().encode("another file\n");
  await expect(
    createPilotJob(deps, input({ deliverable: { bytes: other, extension: "csv" } }), row!.caseId),
  ).rejects.toThrow(new RegExp(`${keccak256(DELIVERABLE)}.*${keccak256(other)}`));
  expect(cases.find(row!.caseId)?.status).toBe("funded");
});

test("a submit is adopted from its call and receipt when the contract emits no JobSubmitted log", async () => {
  const { node, cases, deps, chain } = setup({
    runSubmit: true,
    omitSubmittedLog: true,
    withholdReceipt: "submit",
  });
  await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(ChainTxUnconfirmedError);
  node.releaseWithheld();
  const [row] = cases.list();
  const submitHash = node.hashesOf("submit")[0]!;
  expect((await chain.publicClient.getTransactionReceipt({ hash: submitHash })).logs).toEqual([]);

  const sends = node.sends.length;
  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.status).toBe("submitted");
  expect(done.submitTxHash).toBe(submitHash);
  expect(done.submittedBlockTime).toBe(NOW);
  expect(done.deliverableHash).toBe(keccak256(DELIVERABLE));
  expect(node.sends).toHaveLength(sends);
});

test.each<[string, { deliverable?: Hex; provider?: Address }, (h: Hex) => RegExp]>([
  [
    "another deliverable hash",
    { deliverable: `0x${"ab".repeat(32)}` as Hex },
    (h) =>
      new RegExp(
        `${h} has a JobSubmitted log for job 1 with deliverable hash 0x(ab){32}, and the deliverable given hashes to ${keccak256(DELIVERABLE)}`,
      ),
  ],
  [
    "another provider",
    { provider: STRANGER },
    (h) =>
      new RegExp(
        `${h} has a JobSubmitted log for job 1 naming provider ${STRANGER}, not the seller ${SELLER}`,
        "i",
      ),
  ],
])(
  "a JobSubmitted log naming %s than the submit call refuses the adoption",
  async (_n, skew, problem) => {
    const { node, cases, deps } = setup({
      runSubmit: true,
      withholdReceipt: "submit",
      skewJobSubmittedLog: skew,
    });
    await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(ChainTxUnconfirmedError);
    node.releaseWithheld();
    const [row] = cases.list();
    const submitHash = node.hashesOf("submit")[0]!;
    const sends = node.sends.length;
    await expect(createPilotJob(deps, input(), row!.caseId)).rejects.toThrow(problem(submitHash));
    expect(cases.find(row!.caseId)?.status).toBe("funded");
    expect(node.sends).toHaveLength(sends);
  },
);

test("of a submit that landed and a later one that reverted, the resume adopts the one that landed", async () => {
  const { node, cases, deps, chain } = setup({ runSubmit: true, withholdReceipt: "submit" });
  await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(ChainTxUnconfirmedError);
  const [row] = cases.list();
  const landed = node.hashesOf("submit")[0]!;
  // A second submit, sent while the first was unconfirmed, reverts on chain: the job is already
  // Submitted. The case recorded it as sent, so it is the newest submit the resume reads.
  const second = await chain.job
    .submit(1n, keccak256(DELIVERABLE), chain.wallets.seller)
    .catch((e) => e);
  expect(second).toBeInstanceOf(ChainTxRevertedError);
  cases.recordEvent(row!.caseId, "submit", "unconfirmed", second.txHash, null);
  node.releaseWithheld();

  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.status).toBe("submitted");
  expect(done.submitTxHash).toBe(landed);
  expect(node.hashesOf("submit")).toEqual([landed, second.txHash]);
  expect(cases.events(row!.caseId).at(-1)).toMatchObject({
    step: "submit",
    status: "observed_on_chain",
    ref: landed,
  });
});

test("adopting a submit refuses a recorded transaction that the seller did not send, naming the sender", async () => {
  const { node, cases, deps } = setup({ runSubmit: true, withholdReceipt: "submit" });
  await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(ChainTxUnconfirmedError);
  const [row] = cases.list();
  // The withheld submit is never released; the newest recorded "submit" is the buyer's fund.
  const fundHash = node.hashesOf("fund")[0]!;
  cases.recordEvent(row!.caseId, "submit", "mined", fundHash, null);
  const err = await createPilotJob(deps, input(), row!.caseId).catch((e) => e);
  expect(err.message).toMatch(
    new RegExp(`${fundHash} has sender ${BUYER}, not the seller ${SELLER}`),
  );
  expect(err.message).toMatch(/has a receipt that could not be read yet/);
  expect(cases.find(row!.caseId)?.status).toBe("funded");
});

// ── The pre-flight on resume ────────────────────────────────────────────────────────────────────

/** A row at created whose fund reverted, so the chain reads Open. */
async function createdAfterRevertedFund(o: Parameters<typeof setup>[0] = {}) {
  const h = setup({ ...o, stealAllowanceOnFund: true });
  await expect(createPilotJob(h.deps, input())).rejects.toBeInstanceOf(JobFundRevertedError);
  const [row] = h.cases.list();
  expect(row?.status).toBe("created");
  return { ...h, row: row! };
}

/** A row at funded whose submit reverted, so the chain reads Funded. */
async function fundedAfterRevertedSubmit() {
  const h = setup();
  vi.spyOn(h.chain.job, "submit").mockRejectedValueOnce(
    new ChainTxRevertedError("submit", `0x${"54".repeat(32)}` as Hex),
  );
  await expect(createPilotJob(h.deps, input())).rejects.toBeInstanceOf(ChainTxRevertedError);
  const [row] = h.cases.list();
  expect(row?.status).toBe("funded");
  return { ...h, row: row! };
}

test("a resume whose chain reads Open refuses when the seller's standing is no longer active, and sends nothing", async () => {
  const { node, deps, answers, row } = await createdAfterRevertedFund();
  answers[SELLER_AGENT] = pending as ByAgentAnswer;
  const sent = node.sends.length;
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(/seller.*pending/);
  expect(node.sends).toHaveLength(sent);
});

test("a resume whose chain reads Open checks the balance and the time the job has left", async () => {
  const { node, deps, chain, setClock, row } = await createdAfterRevertedFund();
  const sent = node.sends.length;

  vi.spyOn(chain.job, "usdcBalanceOf").mockResolvedValueOnce(BUDGET + 499_999n);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(/balance/);

  setClock(row.expiredAt - 3_599);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(/expiry/);
  expect(node.sends).toHaveLength(sent);

  // A job with an hour left resumes, although an hour is under the minimum to create one.
  setClock(row.expiredAt - 3_600);
  expect((await createPilotJob(deps, input(), row.caseId)).status).toBe("submitted");
});

test("a resume refuses a job with less time left than the minimum in words about the time left", async () => {
  const { node, deps, setClock, row } = await createdAfterRevertedFund();
  const sent = node.sends.length;
  setClock(row.expiredAt - 3_599);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(
    `refusing to resume pilot case ${row.caseId}: job 1 has 3599 seconds left, under the resume minimum of 3600 for testnet mode; it waits for expiry and a refund`,
  );
  expect(node.sends).toHaveLength(sent);
});

test("a resume whose chain reads Funded skips only the balance check", async () => {
  const { deps, chain, answers, row } = await fundedAfterRevertedSubmit();
  answers[BUYER_AGENT] = noBody;
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(/buyer.*no legal body/);

  answers[BUYER_AGENT] = activeAnswer(BUYER_AGENT, "Buyer Agent DAO LLC");
  const balance = vi.spyOn(chain.job, "usdcBalanceOf").mockResolvedValue(0n);
  expect((await createPilotJob(deps, input(), row.caseId)).status).toBe("submitted");
  expect(balance).not.toHaveBeenCalled();
});

// ── The job on chain must be this case's ────────────────────────────────────────────────────────

test.each<
  [string, (j: NonNullable<ReturnType<ReturnType<typeof usdcJobNode>["chainJob"]>>) => void, RegExp]
>([
  [
    "another client",
    (j) => {
      j.client = STRANGER;
    },
    /has client/,
  ],
  [
    "another evaluator",
    (j) => {
      j.evaluator = STRANGER;
    },
    /has evaluator/,
  ],
  [
    "another provider",
    (j) => {
      j.provider = STRANGER;
    },
    /has provider 0x0{38}aa, not the seller/i,
  ],
  [
    "another expiry",
    (j) => {
      j.expiredAt += 1n;
    },
    /expires at \d+, not at the case's \d+/,
  ],
  [
    "another description",
    (j) => {
      j.description = "another run's job";
    },
    /has another description than the case's/,
  ],
])("the resume refuses a job with %s, and sends nothing", async (_n, change, problem) => {
  const { node, deps, row } = await createdAfterRevertedFund();
  change(node.chainJob(1n)!);
  const sent = node.sends.length;
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(problem);
  expect(node.sends).toHaveLength(sent);
});

test("the resume refuses a Funded job whose budget is not the case's", async () => {
  const { node, deps, row } = await fundedAfterRevertedSubmit();
  node.chainJob(1n)!.budget = BUDGET + 1n;
  const sent = node.sends.length;
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(/holds a budget of/);
  expect(node.sends).toHaveLength(sent);
});

test("a job at Funded whose only recorded fund reverted is not adopted: the resume asks for the hash", async () => {
  const { node, cases, deps, row } = await createdAfterRevertedFund();
  // The job reads Funded although this case's only fund reverted: nothing proves a fund.
  node.chainJob(1n)!.status = 1;
  const sent = node.sends.length;
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(
    `refusing to adopt the fund of pilot case ${row.caseId}: job 1 is Funded on chain but this case recorded no fund transaction; if you know its hash, run the same command with --resume ${row.caseId} --fund-tx <hash> --yes`,
  );
  expect(cases.find(row.caseId)).toMatchObject({ status: "created", fundTxHash: null });
  expect(cases.events(row.caseId).some((e) => e.status === "observed_on_chain")).toBe(false);
  expect(node.sends).toHaveLength(sent);
});

test("a recorded fund hash that is not the buyer's fund of this job is not adopted", async () => {
  const { node, cases, deps, row } = await createdAfterRevertedFund();
  node.chainJob(1n)!.status = 1;
  // The newest "fund" the case holds is the seller's setBudget: right contract, wrong sender.
  const setBudget = node.sendsFrom(SELLER)[0]!.hash;
  cases.recordEvent(row.caseId, "fund", "mined", setBudget, null);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(
    new RegExp(`${setBudget} has sender ${SELLER}, not the buyer ${BUYER}.*--fund-tx <hash>`, "i"),
  );
  expect(cases.find(row.caseId)?.status).toBe("created");
});

// ── Hashes the case lost, given on the resume ───────────────────────────────────────────────────

/** A fund or submit that landed, whose hash the run lost: the RPC failed after the send. */
async function lostHash(step: "fund" | "submit") {
  const h = setup({ runSubmit: true });
  const real = step === "fund" ? h.chain.job.approveAndFund : h.chain.job.submit;
  const spy = vi
    .spyOn(h.chain.job, step === "fund" ? "approveAndFund" : "submit")
    .mockImplementationOnce(async (...args: unknown[]) => {
      await (real as (...a: unknown[]) => Promise<Hex>).apply(h.chain.job, args);
      throw new Error("the connection to the node dropped");
    });
  await expect(createPilotJob(h.deps, input())).rejects.toThrow(/connection to the node dropped/);
  spy.mockRestore();
  const [row] = h.cases.list();
  expect(h.cases.events(row!.caseId).at(-1)).toMatchObject({ step, status: "failed", ref: null });
  const hash = h.node.hashesOf(step)[0]!;
  return { ...h, row: row!, hash };
}

test("a fund whose hash was lost is adopted from the hash given on the resume, with its block time", async () => {
  const { node, cases, deps, row, hash } = await lostHash("fund");
  expect(row.status).toBe("created");
  expect(node.chainJob(1n)?.status).toBe(1);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(/--fund-tx <hash>/);

  const done = await createPilotJob(deps, input({ givenTx: { fund: hash } }), row.caseId);
  expect(done.status).toBe("submitted");
  expect(done.fundTxHash).toBe(hash);
  expect(done.fundedBlockTime).toBe(NOW);
  expect(node.hashesOf("fund")).toEqual([hash]);
  expect(cases.events(row.caseId).find((e) => e.status === "observed_on_chain")).toMatchObject({
    step: "fund",
    ref: hash,
  });
});

test("a submit whose hash was lost is adopted from the hash given on the resume", async () => {
  const { node, deps, row, hash } = await lostHash("submit");
  expect(row.status).toBe("funded");
  expect(node.chainJob(1n)?.status).toBe(2);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(/--submit-tx <hash>/);

  const done = await createPilotJob(deps, input({ givenTx: { submit: hash } }), row.caseId);
  expect(done.status).toBe("submitted");
  expect(done.submitTxHash).toBe(hash);
  expect(done.submittedBlockTime).toBe(NOW);
  expect(node.hashesOf("submit")).toEqual([hash]);
});

test("a given hash that does not prove is refused with the reason, before any recorded hash is tried", async () => {
  const { deps, row, cases } = await lostHash("fund");
  const create = row.createTxHash as Hex;
  await expect(
    createPilotJob(deps, input({ givenTx: { fund: create } }), row.caseId),
  ).rejects.toThrow(
    `refusing to adopt the fund of pilot case ${row.caseId}: ${create} calls createJob, not fund`,
  );
  expect(cases.find(row.caseId)?.status).toBe("created");
});

test("a given hash for a step the chain says has not happened is refused, and nothing is sent", async () => {
  const { node, deps, row } = await createdAfterRevertedFund();
  const sent = node.sends.length;
  await expect(
    createPilotJob(deps, input({ givenTx: { fund: `0x${"ab".repeat(32)}` as Hex } }), row.caseId),
  ).rejects.toThrow(/job 1 is Open on chain, so no fund landed: run the resume without --fund-tx/);
  expect(node.sends).toHaveLength(sent);
});

// ── The create's block time, filled on a resume ─────────────────────────────────────────────────

test("a create whose block read failed gets its block time on the resume", async () => {
  const { cases, deps, chain } = setup();
  const getBlock = chain.publicClient.getBlock.bind(chain.publicClient);
  vi.spyOn(chain.publicClient, "getBlock").mockImplementationOnce(async () => {
    throw new Error("the block read failed");
  });
  await expect(createPilotJob(deps, input())).rejects.toThrow(/block read failed/);
  const [row] = cases.list();
  expect(row).toMatchObject({ status: "created", createdBlockTime: null });
  vi.mocked(chain.publicClient.getBlock).mockImplementation(getBlock as never);

  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done.createdBlockTime).toBe(NOW);
  expect(done.status).toBe("submitted");
});

// ── Pre-flight errors and boundaries ────────────────────────────────────────────────────────────

test("pre-flight returns a problem, not a throw, for a balance read that fails and an answer without a statement", async () => {
  const { chain, deps } = setup();
  vi.spyOn(chain.job, "usdcBalanceOf").mockRejectedValueOnce(new Error("rpc down"));
  const pre = await preflightPilotJob(deps, input());
  expect(pre.ok === false && pre.problem).toMatch(/balance could not be read/);

  const malformed = { ...activeAnswer(SELLER_AGENT, "S"), statement: undefined };
  const { deps: deps2 } = setup({
    answers: {
      [BUYER_AGENT]: activeAnswer(BUYER_AGENT, "B"),
      [SELLER_AGENT]: malformed as unknown as ByAgentAnswer,
    },
  });
  const pre2 = await preflightPilotJob(deps2, input());
  expect(pre2.ok === false && pre2.problem).toMatch(/seller.*no signed statement/);
});

test("pre-flight boundaries: the budget at the maximum, the balance at budget plus 0.5 USDC, live at thirty days", async () => {
  const { deps } = setup({ buyerBalance: 2_000_000n + 500_000n });
  expect((await preflightPilotJob(deps, input({ budgetAtomic: 2_000_000n }))).ok).toBe(true);
  const { deps: exact } = setup({ buyerBalance: BUDGET + 500_000n });
  expect((await preflightPilotJob(exact, input())).ok).toBe(true);
  expect(
    (await preflightPilotJob(exact, input({ mode: "live", expirySeconds: 2_592_000 }))).ok,
  ).toBe(true);
});

// ── The case's own agents and addresses on resume ───────────────────────────────────────────────

test.each<[string, (d: PilotJobDeps) => PilotJobDeps, RegExp]>([
  [
    "the buyer's agent id",
    (d) => ({ ...d, agentIds: { ...d.agentIds, buyer: "99" } }),
    /the case's buyer's agent id is 41, and this command's is 99/,
  ],
  [
    "the seller's agent id",
    (d) => ({ ...d, agentIds: { ...d.agentIds, seller: "98" } }),
    /the case's seller's agent id is 42, and this command's is 98/,
  ],
  [
    "the buyer's address",
    (d) => ({ ...d, chain: { ...d.chain, addresses: { ...d.chain.addresses, buyer: STRANGER } } }),
    /the case's buyer's address is .*, and this command's is /,
  ],
  [
    "the seller's address",
    (d) => ({ ...d, chain: { ...d.chain, addresses: { ...d.chain.addresses, seller: STRANGER } } }),
    /the case's seller's address is .*, and this command's is /,
  ],
])(
  "a resume refuses when %s differs from the case's, and sends nothing",
  async (_n, change, problem) => {
    const { node, deps, row } = await createdAfterRevertedFund();
    const sent = node.sends.length;
    await expect(createPilotJob(change(deps), input(), row.caseId)).rejects.toThrow(problem);
    expect(node.sends).toHaveLength(sent);
  },
);

test("a resume with the case's own agents and addresses, in another letter case, goes through", async () => {
  const { deps, row } = await createdAfterRevertedFund();
  const lower = {
    ...deps,
    chain: {
      ...deps.chain,
      addresses: {
        ...deps.chain.addresses,
        buyer: deps.chain.addresses.buyer.toLowerCase() as Address,
        seller: deps.chain.addresses.seller.toLowerCase() as Address,
      },
    },
  };
  expect((await createPilotJob(lower, input(), row.caseId)).status).toBe("submitted");
});

test("a failure after the row exists carries the case id; a failed createJob carries none", async () => {
  const reverted = setup({ stealAllowanceOnFund: true });
  const fundErr = await createPilotJob(reverted.deps, input()).catch((e) => e);
  expect(fundErr).toBeInstanceOf(JobFundRevertedError);
  expect(pilotCaseIdOf(fundErr)).toBe(reverted.cases.list()[0]?.caseId);

  const unconfirmed = setup({ runSubmit: true, withholdReceipt: "submit" });
  const submitErr = await createPilotJob(unconfirmed.deps, input()).catch((e) => e);
  expect(submitErr).toBeInstanceOf(ChainTxUnconfirmedError);
  const [row] = unconfirmed.cases.list();
  expect(pilotCaseIdOf(submitErr)).toBe(row?.caseId);
  // A resume that fails carries it too.
  const resumeErr = await createPilotJob(unconfirmed.deps, input(), row!.caseId).catch((e) => e);
  expect(resumeErr.message).toMatch(/receipt/);
  expect(pilotCaseIdOf(resumeErr)).toBe(row?.caseId);

  const failedCreate = setup();
  vi.spyOn(failedCreate.chain.job, "createJob").mockRejectedValueOnce(
    new ChainTxRevertedError("createJob", `0x${"56".repeat(32)}` as Hex),
  );
  const createErr = await createPilotJob(failedCreate.deps, input()).catch((e) => e);
  expect(createErr).toBeInstanceOf(ChainTxRevertedError);
  expect(pilotCaseIdOf(createErr)).toBeUndefined();
  expect(failedCreate.cases.list()).toEqual([]);
});

// ── The job id comes from the create's own receipt ──────────────────────────────────────────────

test("when other creates land between the simulation and the block, the row takes the id the JobCreated log names", async () => {
  const { node, cases, deps } = setup({ emitJobCreatedLog: true, skewJobCreatedId: 2n });
  const row = await createPilotJob(deps, input());
  expect(row.jobId).toBe("3");
  expect(row.status).toBe("submitted");
  expect(node.chainJob(3n)).toMatchObject({ client: BUYER, provider: SELLER, status: 1 });
  expect(node.chainJob(1n)).toBeUndefined();
  expect(cases.events(row.caseId)).toContainEqual(
    expect.objectContaining({
      step: "create",
      status: "job_id_from_log",
      ref: row.createTxHash,
      detail: "the simulation gave job 1; the JobCreated log of the create gives job 3",
    }),
  );
});

test("when the log names the simulated id, the row keeps it and records nothing about it", async () => {
  const { cases, deps } = setup({ emitJobCreatedLog: true });
  const row = await createPilotJob(deps, input());
  expect(row.jobId).toBe("1");
  expect(cases.events(row.caseId).some((e) => e.status === "job_id_from_log")).toBe(false);
});

test("a create whose receipt read failed takes the log's id on the resume", async () => {
  const { cases, deps, chain, node } = setup({ emitJobCreatedLog: true, skewJobCreatedId: 2n });
  const getBlock = chain.publicClient.getBlock.bind(chain.publicClient);
  vi.spyOn(chain.publicClient, "getBlock").mockImplementationOnce(async () => {
    throw new Error("the block read failed");
  });
  await expect(createPilotJob(deps, input())).rejects.toThrow(/block read failed/);
  const [row] = cases.list();
  // The row exists with the simulated id, so the case can be resumed.
  expect(row).toMatchObject({ status: "created", jobId: "1", createdBlockTime: null });
  vi.mocked(chain.publicClient.getBlock).mockImplementation(getBlock as never);
  const sent = node.sends.length;

  const done = await createPilotJob(deps, input(), row!.caseId);
  expect(done).toMatchObject({ jobId: "3", status: "submitted", createdBlockTime: NOW });
  expect(node.hashesOf("createJob")).toHaveLength(1);
  expect(node.sends.length).toBeGreaterThan(sent);
});

test("a resume refused before the case is shown resumable carries no case id; one refused after does", async () => {
  const { deps, cases, setClock } = setup({ stealAllowanceOnFund: true });
  await expect(createPilotJob(deps, input())).rejects.toBeInstanceOf(JobFundRevertedError);
  const [row] = cases.list();

  const unknown = await createPilotJob(deps, input(), "pc_000000000000").catch((e) => e);
  expect(unknown.message).toMatch(/no pilot case pc_000000000000/);
  expect(pilotCaseIdOf(unknown)).toBeUndefined();
  const otherMode = await createPilotJob(deps, input({ mode: "live" }), row!.caseId).catch(
    (e) => e,
  );
  expect(otherMode.message).toMatch(/created in testnet mode/);
  expect(pilotCaseIdOf(otherMode)).toBeUndefined();

  setClock(row!.expiredAt - 60);
  const late = await createPilotJob(deps, input(), row!.caseId).catch((e) => e);
  expect(late.message).toMatch(/seconds left/);
  expect(pilotCaseIdOf(late)).toBe(row!.caseId);
});

// ── What a recorded submit hash must be ─────────────────────────────────────────────────────────

/** A case at funded whose submit landed but was never confirmed, and whose receipt stays withheld. */
async function submittedUnconfirmed() {
  const h = setup({ runSubmit: true, withholdReceipt: "submit" });
  await expect(createPilotJob(h.deps, input())).rejects.toBeInstanceOf(ChainTxUnconfirmedError);
  const [row] = h.cases.list();
  expect(h.node.chainJob(1n)?.status).toBe(2);
  return { ...h, row: row! };
}

test("a recorded submit hash whose transaction went to another contract is refused, naming the recipient", async () => {
  const { node, cases, deps, row } = await submittedUnconfirmed();
  const approve = node.hashesOf("approve")[0]!;
  cases.recordEvent(row.caseId, "submit", "mined", approve, null);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(
    new RegExp(`${approve} has recipient ${USDC}, not the job contract ${JOB_CONTRACT}`, "i"),
  );
  expect(cases.find(row.caseId)?.status).toBe("funded");
});

test("a recorded submit hash whose call is not submit is refused, naming the call", async () => {
  const { node, cases, deps, row } = await submittedUnconfirmed();
  // The seller's setBudget: right contract and right sender, another call.
  const setBudget = node.sendsFrom(SELLER)[0]!.hash;
  cases.recordEvent(row.caseId, "submit", "mined", setBudget, null);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(
    new RegExp(`${setBudget} calls setBudget, not submit`),
  );
  expect(cases.find(row.caseId)?.status).toBe("funded");
});

test("a recorded submit hash that submits another job is refused, naming both job ids", async () => {
  const { node, cases, deps, chain, row } = await submittedUnconfirmed();
  // The seller's submit of a second, funded job: the right call, for another job.
  node.seedChainJob({
    id: 2n,
    client: BUYER,
    provider: SELLER,
    evaluator: REFEREE,
    description: "another job",
    budget: BUDGET,
    expiredAt: BigInt(NOW + 86_400),
    status: 1,
    hook: "0x0000000000000000000000000000000000000000",
  });
  const other = await chain.job.submit(2n, keccak256(DELIVERABLE), chain.wallets.seller);
  cases.recordEvent(row.caseId, "submit", "mined", other, null);
  await expect(createPilotJob(deps, input(), row.caseId)).rejects.toThrow(
    new RegExp(`${other} submits job 2, not job 1`),
  );
  expect(cases.find(row.caseId)?.status).toBe("funded");
});
