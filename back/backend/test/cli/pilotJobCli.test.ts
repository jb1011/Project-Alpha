/**
 * The pilot's case commands (`pilot:job`, `pilot:contest`, `pilot:case`) over a fake PilotContext
 * whose case table is a real SQLite repository in memory: no chain, no network.
 *
 * The pre-flight and the job creation are stubbed through the commands' dependencies, so a test
 * sees exactly what the command would have run. The wallets sit on a transport that refuses
 * every request, so any request it records is a call the command should not have made.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Command } from "commander";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createWalletClient,
  custom,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type MockInstance, afterEach, describe, expect, test, vi } from "vitest";
import { anvilChain } from "../../src/chains";
import { type PilotCommandDeps, registerPilotCommands } from "../../src/cli/pilot";
import type { Config } from "../../src/config/env";
import {
  ChainTxRevertedError,
  ChainTxUnconfirmedError,
  JobFundRevertedError,
  JobFundUnconfirmedError,
} from "../../src/errors";
import { migrate } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import {
  PILOT_FILED_STATUSES,
  SqlitePilotCaseRepository,
  newCaseId,
} from "../../src/pilot/casesRepository";
import type { PilotContext } from "../../src/pilot/context";
import {
  type CreatePilotJobInput,
  withCreateMayHaveBeenSent,
  withPilotCaseId,
} from "../../src/pilot/job";
import type { PilotCaseRecord, PilotMode, PilotStatus } from "../../src/pilot/types";

// Anvil's well-known throwaway keys (accounts 1, 2, 3): never real.
const KEYS = {
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  referee: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;
const ADDR = {
  buyer: privateKeyToAccount(KEYS.buyer).address,
  seller: privateKeyToAccount(KEYS.seller).address,
  referee: privateKeyToAccount(KEYS.referee).address,
};
const JOB_CONTRACT: Address = "0x0000000000000000000000000000000000000b0b";
/** 2026-10-28T00:00:00Z, in Unix seconds. */
const NOW = 1_793_145_600;
const FAKE_TX: Hex = `0x${"ab".repeat(32)}`;
const TWO_TO_256 = (1n << 256n).toString();

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Fake {
  ctx: PilotContext;
  cases: SqlitePilotCaseRepository;
  transportCalls: string[];
  writes: MockInstance[];
  preflight: ReturnType<typeof vi.fn>;
  createJob: ReturnType<typeof vi.fn>;
  deps: Partial<PilotCommandDeps>;
  open: () => PilotContext;
  opened: () => number;
  closed: () => number;
}

function makeFake(
  o: {
    mode?: PilotMode;
    agentIds?: { buyer?: string; seller?: string };
    preflight?: unknown;
  } = {},
): Fake {
  const transportCalls: string[] = [];
  const transport = custom({
    request: async ({ method }: { method: string }) => {
      transportCalls.push(method);
      throw new Error(`no network in this test: ${method}`);
    },
  });
  const wallet = (key: Hex): WalletClient =>
    createWalletClient({ account: privateKeyToAccount(key), chain: anvilChain, transport });
  const wallets = {
    buyer: wallet(KEYS.buyer),
    seller: wallet(KEYS.seller),
    referee: wallet(KEYS.referee),
  };
  const writes = Object.values(wallets).map((w) => vi.spyOn(w, "writeContract"));
  const db = new Database(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const cfg = {
    chainId: anvilChain.id,
    jobContract: JOB_CONTRACT,
    usdc: "0x3600000000000000000000000000000000000000",
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    arcExplorerUrl: "https://explorer.example.com",
    maxJobBudget: 10_000_000n,
    pilot: {
      buyerPrivateKey: KEYS.buyer,
      sellerPrivateKey: KEYS.seller,
      refereePrivateKey: KEYS.referee,
      mode: o.mode ?? "rehearsal",
      testnetCasesCap: 10,
      liveCasesCap: 5,
      lookupBase: "https://api.example.com",
      buyerAgentId: o.agentIds?.buyer,
      sellerAgentId: o.agentIds?.seller,
    },
  } as unknown as Config;
  const pub = {
    readContract: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getBalance: vi.fn(async () => 10n ** 18n),
  };
  let closes = 0;
  const ctx = {
    cfg,
    db,
    cases,
    docStore: new FileDocumentStore(mkdtempSync(join(tmpdir(), "pilot-job-cli-docs-"))),
    publicClient: pub as unknown as PublicClient,
    sendClient: pub as unknown as PublicClient,
    wallets,
    addresses: ADDR,
    close: () => {
      closes++;
    },
  } as unknown as PilotContext;
  let opens = 0;
  const preflight = vi.fn(
    async () =>
      o.preflight ?? {
        ok: true,
        buyerBalance: 5_250_000n,
        buyerName: "Buyer Test Agent DAO LLC",
        sellerName: "Seller Test Agent DAO LLC",
      },
  );
  const createJob = vi.fn(async (_d: unknown, input: CreatePilotJobInput) =>
    insertCase(cases, { mode: input.mode, status: "submitted" }),
  );
  return {
    ctx,
    cases,
    transportCalls,
    writes,
    preflight,
    createJob,
    deps: {
      readConfig: () => cfg,
      preflight: preflight as unknown as PilotCommandDeps["preflight"],
      createJob: createJob as unknown as PilotCommandDeps["createJob"],
      now: () => NOW,
    },
    open: () => {
      opens++;
      return ctx;
    },
    opened: () => opens,
    closed: () => closes,
  };
}

/** A case row at `status`, with whatever columns the test names. */
function insertCase(
  cases: SqlitePilotCaseRepository,
  o: { mode?: PilotMode; status?: PilotStatus; patch?: Partial<PilotCaseRecord> } = {},
): PilotCaseRecord {
  const caseId = newCaseId();
  cases.insert({
    caseId,
    label: "test case 1",
    mode: o.mode ?? "rehearsal",
    chainId: anvilChain.id,
    jobContract: JOB_CONTRACT,
    buyerAddress: ADDR.buyer,
    buyerAgentId: "11",
    sellerAddress: ADDR.seller,
    sellerAgentId: "12",
    refereeAddress: ADDR.referee,
    budgetAtomic: "2000000",
    description: "a test job",
    expiredAt: NOW + 7 * 86_400,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
  });
  const status = o.status ?? "created";
  if (status === "created") return o.patch ? cases.patch(caseId, o.patch) : cases.find(caseId)!;
  return cases.advance(caseId, "created", status, o.patch) as PilotCaseRecord;
}

/** Runs one command line; returns what it printed. Throws what the command throws. */
async function run(fake: Fake, argv: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPilotCommands(program, fake.open, fake.deps);
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  try {
    await program.parseAsync(["node", "cli", ...argv]);
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

function expectNothingSent(fake: Fake): void {
  for (const w of fake.writes) expect(w).not.toHaveBeenCalled();
  expect(fake.transportCalls).toEqual([]);
}

function expectNoKey(output: string): void {
  for (const key of Object.values(KEYS)) {
    expect(output).not.toContain(key);
    expect(output).not.toContain(key.slice(2));
  }
}

function tempFile(name: string, content: string | Uint8Array): string {
  const path = join(mkdtempSync(join(tmpdir(), "pilot-job-cli-")), name);
  writeFileSync(path, content);
  return path;
}

const DELIVERABLE = new TextEncoder().encode("the delivered summary\n");

function jobArgs(extra: string[] = []): string[] {
  return [
    "pilot:job",
    "--label",
    "test case 1",
    "--description-file",
    tempFile("description.txt", "Summarize the attached report in 200 words.\n"),
    "--deliverable",
    tempFile("deliverable.md", DELIVERABLE),
    "--buyer-agent",
    "11",
    "--seller-agent",
    "12",
    ...extra,
  ];
}

const inputOf = (m: ReturnType<typeof vi.fn>, call = 0) =>
  m.mock.calls[call]?.[1] as CreatePilotJobInput;

describe("pilot:job: the dry run", () => {
  test("prints the pre-flight (mode, names, balance, expiry, hash) and creates nothing", async () => {
    const fake = makeFake();
    const out = await run(fake, jobArgs());
    const printed = JSON.parse(out);
    expect(printed.dryRun).toBe(true);
    expect(printed.mode).toBe("rehearsal");
    expect(printed).not.toHaveProperty("klerosScript");
    expect(printed.buyer).toEqual({
      agentId: "11",
      address: ADDR.buyer,
      legalName: "Buyer Test Agent DAO LLC",
    });
    expect(printed.seller.legalName).toBe("Seller Test Agent DAO LLC");
    expect(printed.buyerBalanceAtomic).toBe("5250000");
    expect(printed.budgetAtomic).toBe("2000000");
    expect(printed.expirySeconds).toBe(7 * 86_400);
    expect(printed.expiresAt).toBe("2026-11-04T00:00:00.000Z");
    expect(printed.deliverable.hash).toBe(keccak256(DELIVERABLE));
    expect(printed.deliverable.extension).toBe("md");
    expect(out).toContain("Arc testnet");
    expect(out).toContain("test data");
    expect(fake.preflight).toHaveBeenCalledTimes(1);
    expect(fake.createJob).not.toHaveBeenCalled();
    expect(fake.cases.list()).toEqual([]);
    expectNothingSent(fake);
    expectNoKey(out);
    expect(fake.opened()).toBe(1);
    expect(fake.closed()).toBe(1);
  });

  test("the pre-flight gets the parsed input and the agent ids", async () => {
    const fake = makeFake();
    await run(fake, jobArgs());
    const [deps, input] = fake.preflight.mock.calls[0] as [
      { agentIds: unknown; maxBudgetAtomic: bigint },
      CreatePilotJobInput,
    ];
    expect(deps.agentIds).toEqual({ buyer: "11", seller: "12" });
    expect(deps.maxBudgetAtomic).toBe(10_000_000n);
    expect(input.label).toBe("test case 1");
    expect(input.description).toBe("Summarize the attached report in 200 words.\n");
    expect(input.deliverable.extension).toBe("md");
    expect(Array.from(input.deliverable.bytes)).toEqual(Array.from(DELIVERABLE));
    expect(input.budgetAtomic).toBe(2_000_000n);
    expect(input.expirySeconds).toBe(7 * 86_400);
    expect(input.mode).toBe("rehearsal");
  });

  test("a failing pre-flight is refused with its problem, and nothing is created", async () => {
    const fake = makeFake({
      preflight: { ok: false, problem: "the seller's agent 12 has no legal body" },
    });
    await expect(run(fake, jobArgs())).rejects.toThrow(
      /refusing: the seller's agent 12 has no legal body/,
    );
    expect(fake.createJob).not.toHaveBeenCalled();
    expect(fake.closed()).toBe(1);
  });

  test("in testnet mode the output names the mode and no script", async () => {
    const fake = makeFake({ mode: "testnet" });
    const printed = JSON.parse(await run(fake, jobArgs()));
    expect(printed.mode).toBe("testnet");
    expect(printed).not.toHaveProperty("klerosScript");
  });

  test("--resume in the dry run reads the case and sends nothing", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "created", patch: { jobId: "7" } });
    const printed = JSON.parse(await run(fake, jobArgs(["--resume", row.caseId])));
    expect(printed.dryRun).toBe(true);
    expect(printed.resume).toEqual({
      caseId: row.caseId,
      mode: "rehearsal",
      status: "created",
      jobId: "7",
    });
    expect(fake.createJob).not.toHaveBeenCalled();
    expect(fake.preflight).not.toHaveBeenCalled();
    expectNothingSent(fake);
  });

  test("--resume of an unknown case is refused", async () => {
    const fake = makeFake();
    await expect(run(fake, jobArgs(["--resume", "pc_000000000000"]))).rejects.toThrow(
      /refusing: no pilot case pc_000000000000/,
    );
  });
});

describe("pilot:job: options", () => {
  test.each([
    ["2", 2_000_000n],
    ["2.00", 2_000_000n],
    ["0.000001", 1n],
    ["10", 10_000_000n],
    ["1.5", 1_500_000n],
  ])("--budget %s is %s atomic USDC", async (budget, atomic) => {
    const fake = makeFake();
    await run(fake, jobArgs(["--budget", budget]));
    expect(inputOf(fake.preflight).budgetAtomic).toBe(atomic);
  });

  test("--expiry-days sets the expiry in whole days", async () => {
    const fake = makeFake({ mode: "testnet" });
    await run(fake, jobArgs(["--expiry-days", "3"]));
    expect(inputOf(fake.preflight).expirySeconds).toBe(3 * 86_400);
  });

  test("--expiry-seconds is accepted in rehearsal", async () => {
    const fake = makeFake();
    const printed = JSON.parse(await run(fake, jobArgs(["--expiry-seconds", "300"])));
    expect(inputOf(fake.preflight).expirySeconds).toBe(300);
    expect(printed.expiresAt).toBe("2026-10-28T00:05:00.000Z");
  });

  test("the agent ids come from the config when the options are absent", async () => {
    const fake = makeFake({ agentIds: { buyer: "21", seller: "22" } });
    const args = jobArgs().slice(0, 7);
    await run(fake, args);
    expect((fake.preflight.mock.calls[0]?.[0] as { agentIds: unknown }).agentIds).toEqual({
      buyer: "21",
      seller: "22",
    });
  });

  test("the options take precedence over the config's agent ids", async () => {
    const fake = makeFake({ agentIds: { buyer: "21", seller: "22" } });
    await run(fake, jobArgs());
    expect((fake.preflight.mock.calls[0]?.[0] as { agentIds: unknown }).agentIds).toEqual({
      buyer: "11",
      seller: "12",
    });
  });

  test.each([
    [["--budget", "2.0000001"], /--budget/],
    [["--budget", "1e3"], /--budget/],
    [["--budget", "-1"], /--budget/],
    [["--budget", "0"], /--budget must be above zero/],
    [["--budget", ".5"], /--budget/],
    [["--budget", "2."], /--budget/],
    [["--buyer-agent", TWO_TO_256], /--buyer-agent must fit in a uint256/],
    [["--expiry-days", "0"], /--expiry-days/],
    [["--expiry-days", "1.5"], /--expiry-days/],
    [["--expiry-days", "2", "--expiry-seconds", "300"], /--expiry-days and --expiry-seconds/],
    [["--expiry-seconds", "abc"], /--expiry-seconds/],
    [["--buyer-agent", "0x0b"], /--buyer-agent/],
    [["--seller-agent", "-2"], /--seller-agent/],
    [["--resume", "not-a-case"], /--resume/],
  ])("%j is refused before the context opens", async (extra, message) => {
    const fake = makeFake();
    await expect(run(fake, jobArgs(extra as string[]))).rejects.toThrow(message);
    expect(fake.opened()).toBe(0);
    expect(fake.preflight).not.toHaveBeenCalled();
  });

  test.each([["testnet"], ["live"]] as const)(
    "--expiry-seconds is refused by name in %s mode, before the context opens",
    async (mode) => {
      const fake = makeFake({ mode });
      await expect(run(fake, jobArgs(["--expiry-seconds", "300"]))).rejects.toThrow(
        new RegExp(`refusing: --expiry-seconds is accepted in rehearsal mode only.*${mode}`),
      );
      expect(fake.opened()).toBe(0);
    },
  );

  test("a missing agent id is refused by option and variable name, before the context opens", async () => {
    const fake = makeFake({ agentIds: { seller: "22" } });
    await expect(run(fake, jobArgs().slice(0, 7))).rejects.toThrow(
      /--buyer-agent or PILOT_BUYER_AGENT_ID/,
    );
    expect(fake.opened()).toBe(0);
  });

  test("an unreadable description file is refused by path, before the context opens", async () => {
    const fake = makeFake();
    const args = jobArgs();
    args[4] = "/nonexistent/description.txt";
    await expect(run(fake, args)).rejects.toThrow(/--description-file \/nonexistent/);
    expect(fake.opened()).toBe(0);
  });

  test("an empty description is refused before the context opens", async () => {
    const fake = makeFake();
    const args = jobArgs();
    args[4] = tempFile("empty.txt", "  \n");
    await expect(run(fake, args)).rejects.toThrow(/--description-file .* is empty/);
    expect(fake.opened()).toBe(0);
  });

  test("a deliverable without an extension is refused before the context opens", async () => {
    const fake = makeFake();
    const args = jobArgs();
    args[6] = tempFile("deliverable", DELIVERABLE);
    await expect(run(fake, args)).rejects.toThrow(/--deliverable .* has no file extension/);
    expect(fake.opened()).toBe(0);
  });

  test("an empty label is refused before the context opens", async () => {
    const fake = makeFake();
    const args = jobArgs();
    args[2] = " ";
    await expect(run(fake, args)).rejects.toThrow(/--label/);
    expect(fake.opened()).toBe(0);
  });
});

describe("pilot:job --yes", () => {
  test("creates the job and prints the row with the mode and no script", async () => {
    const fake = makeFake();
    const printed = JSON.parse(await run(fake, jobArgs(["--yes"])));
    expect(fake.createJob).toHaveBeenCalledTimes(1);
    expect(fake.createJob.mock.calls[0]?.[2]).toBeUndefined();
    expect(inputOf(fake.createJob).budgetAtomic).toBe(2_000_000n);
    expect(printed.mode).toBe("rehearsal");
    expect(printed).not.toHaveProperty("klerosScript");
    expect(printed.case.status).toBe("submitted");
    expect(printed.note).toContain("Arc testnet");
  });

  test("--resume hands the case id to the job creation", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "funded", patch: { jobId: "7" } });
    await run(fake, jobArgs(["--yes", "--resume", row.caseId]));
    expect(fake.createJob.mock.calls[0]?.[2]).toBe(row.caseId);
  });

  test("a reverted transaction prints its hash and still fails", async () => {
    const fake = makeFake();
    fake.createJob.mockRejectedValueOnce(new ChainTxRevertedError("createJob", FAKE_TX));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    const program = new Command();
    program.exitOverride();
    registerPilotCommands(program, fake.open, fake.deps);
    try {
      await expect(program.parseAsync(["node", "cli", ...jobArgs(["--yes"])])).rejects.toThrow(
        /createJob reverted/,
      );
    } finally {
      spy.mockRestore();
    }
    const printed = JSON.parse(logs.join("\n"));
    expect(printed.failed).toBe(true);
    expect(printed.txHash).toBe(FAKE_TX);
    expect(fake.closed()).toBe(1);
  });
});

describe("pilot:contest", () => {
  test("moves a submitted case to contested with both texts and the time, and records it", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "submitted" });
    const reason = tempFile("reason.txt", "The summary is 40 words, not 200.\n\tSee line 2.");
    const reply = tempFile("reply.txt", "The job allowed a shorter summary.");
    const printed = JSON.parse(
      await run(fake, [
        "pilot:contest",
        "--case",
        row.caseId,
        "--reason-file",
        reason,
        "--reply-file",
        reply,
        "--yes",
      ]),
    );
    const after = fake.cases.find(row.caseId);
    expect(after?.status).toBe("contested");
    expect(after?.contestReason).toBe("The summary is 40 words, not 200.\n\tSee line 2.");
    expect(after?.contestReply).toBe("The job allowed a shorter summary.");
    expect(after?.contestedAt).toBe(NOW);
    expect(printed.case.status).toBe("contested");
    expect(printed.contestedAt).toBe("2026-10-28T00:00:00.000Z");
    expect(fake.cases.events(row.caseId).map((e) => [e.step, e.status])).toEqual([
      ["contest", "ok"],
    ]);
  });

  test("the reply is optional", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "submitted" });
    await run(fake, [
      "pilot:contest",
      "--case",
      row.caseId,
      "--reason-file",
      tempFile("reason.txt", "late"),
      "--yes",
    ]);
    expect(fake.cases.find(row.caseId)?.contestReply).toBeNull();
  });

  test("the dry run changes nothing", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "submitted" });
    const printed = JSON.parse(
      await run(fake, [
        "pilot:contest",
        "--case",
        row.caseId,
        "--reason-file",
        tempFile("reason.txt", "late"),
      ]),
    );
    expect(printed.dryRun).toBe(true);
    expect(fake.cases.find(row.caseId)?.status).toBe("submitted");
    expect(fake.cases.events(row.caseId)).toEqual([]);
  });

  test.each([["funded"], ["contested"], ["filed"]] as const)(
    "a case at %s is refused and left as it was",
    async (status) => {
      const fake = makeFake();
      const row = insertCase(fake.cases, { status });
      await expect(
        run(fake, [
          "pilot:contest",
          "--case",
          row.caseId,
          "--reason-file",
          tempFile("reason.txt", "late"),
          "--yes",
        ]),
      ).rejects.toThrow(new RegExp(`refusing: pilot case ${row.caseId} is at ${status}`));
      expect(fake.cases.find(row.caseId)?.status).toBe(status);
      expect(fake.cases.events(row.caseId)).toEqual([]);
    },
  );

  test("an unknown case is refused", async () => {
    const fake = makeFake();
    await expect(
      run(fake, [
        "pilot:contest",
        "--case",
        "pc_000000000000",
        "--reason-file",
        tempFile("reason.txt", "late"),
        "--yes",
      ]),
    ).rejects.toThrow(/refusing: no pilot case pc_000000000000/);
  });

  test.each([
    ["--reason-file", "x".repeat(4097), /over 4096 bytes/],
    ["--reason-file", "a\u0000b", /control character/],
    ["--reason-file", "a\rb", /control character/],
    ["--reason-file", "", /empty/],
    ["--reply-file", "a\u001bb", /--reply-file .* control character/],
    ["--reply-file", "é".repeat(2049), /over 4096 bytes/],
  ])("%s holding a bad text is refused before the context opens", async (which, text, message) => {
    const fake = makeFake();
    const good = tempFile("good.txt", "late");
    const bad = tempFile("bad.txt", text);
    const args = ["pilot:contest", "--case", "pc_000000000000", "--yes"];
    args.push("--reason-file", which === "--reason-file" ? bad : good);
    if (which === "--reply-file") args.push("--reply-file", bad);
    await expect(run(fake, args)).rejects.toThrow(message);
    expect(fake.opened()).toBe(0);
  });

  test("exactly 4096 bytes is accepted", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "submitted" });
    await run(fake, [
      "pilot:contest",
      "--case",
      row.caseId,
      "--reason-file",
      tempFile("reason.txt", "x".repeat(4096)),
      "--yes",
    ]);
    expect(fake.cases.find(row.caseId)?.status).toBe("contested");
  });
});

const FILED_TESTNET = {
  klerosChain: "arbitrum-sepolia-testnet",
  coreDisputeId: "186",
  localDisputeId: "4",
} as const;
const FILED_LIVE = {
  klerosChain: "arbitrum-one",
  coreDisputeId: "287",
  localDisputeId: "1",
} as const;
const COURT_URL = "https://v2-testnet.kleros.builders/#/cases/186/overview";

describe("pilot:case show and list", () => {
  test("show prints the row, its events and the Court URL", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, {
      mode: "testnet",
      status: "filed",
      patch: FILED_TESTNET,
    });
    fake.cases.recordEvent(row.caseId, "create", "mined", FAKE_TX, null);
    const printed = JSON.parse(await run(fake, ["pilot:case", "show", row.caseId]));
    expect(printed.case.caseId).toBe(row.caseId);
    expect(printed.events.map((e: { step: string }) => e.step)).toEqual(["create"]);
    expect(printed.courtUrl).toBe(COURT_URL);
  });

  test.each([
    ["no ids", "submitted", {}],
    ["the rehearsal's fake deployment", "filed", { klerosChain: "fake", coreDisputeId: "1" }],
  ] as const)("show gives no Court URL for %s", async (_what, status, patch) => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status, patch });
    const printed = JSON.parse(await run(fake, ["pilot:case", "show", row.caseId]));
    expect(printed.courtUrl).toBeNull();
  });

  test("show of an unknown case is refused", async () => {
    const fake = makeFake();
    await expect(run(fake, ["pilot:case", "show", "pc_000000000000"])).rejects.toThrow(
      /refusing: no pilot case pc_000000000000/,
    );
  });

  test("list prints every case, and --mode keeps one mode's", async () => {
    const fake = makeFake();
    const a = insertCase(fake.cases, { mode: "rehearsal" });
    const b = insertCase(fake.cases, { mode: "testnet", status: "submitted" });
    const all = JSON.parse(await run(fake, ["pilot:case", "list"]));
    expect(all.cases.map((c: { caseId: string }) => c.caseId).sort()).toEqual(
      [a.caseId, b.caseId].sort(),
    );
    const testnet = JSON.parse(await run(fake, ["pilot:case", "list", "--mode", "testnet"]));
    expect(testnet.cases).toHaveLength(1);
    expect(testnet.cases[0]).toMatchObject({
      caseId: b.caseId,
      mode: "testnet",
      status: "submitted",
    });
  });

  test("list --mode of another word is refused before the context opens", async () => {
    const fake = makeFake();
    await expect(run(fake, ["pilot:case", "list", "--mode", "staging"])).rejects.toThrow(
      /--mode must be rehearsal, testnet or live/,
    );
    expect(fake.opened()).toBe(0);
  });
});

describe("pilot:case seen-in-court", () => {
  test("records the Court URL and the operator's name on a filed testnet case", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { mode: "testnet", status: "filed", patch: FILED_TESTNET });
    const printed = JSON.parse(
      await run(fake, ["pilot:case", "seen-in-court", row.caseId, "--by", "operator", "--yes"]),
    );
    expect(printed.courtUrl).toBe(COURT_URL);
    expect(fake.cases.events(row.caseId)).toMatchObject([
      { step: "seen_in_court", status: "ok", ref: COURT_URL, detail: "by operator" },
    ]);
    expect(fake.cases.countSeenInCourt("testnet")).toBe(1);
  });

  test("without --by it records an operator", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { mode: "testnet", status: "ruled", patch: FILED_TESTNET });
    await run(fake, ["pilot:case", "seen-in-court", row.caseId, "--yes"]);
    expect(fake.cases.events(row.caseId)[0]?.detail).toBe("by an operator");
  });

  test("without --yes it records nothing", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { mode: "testnet", status: "filed", patch: FILED_TESTNET });
    const printed = JSON.parse(await run(fake, ["pilot:case", "seen-in-court", row.caseId]));
    expect(printed.dryRun).toBe(true);
    expect(printed.courtUrl).toBe(COURT_URL);
    expect(fake.cases.events(row.caseId)).toEqual([]);
  });

  test.each([
    [
      "a rehearsal case",
      "rehearsal",
      "filed",
      { klerosChain: "fake", coreDisputeId: "1" },
      /rehearsal/,
    ],
    ["a case before filed", "testnet", "contested", {}, /is at contested/],
    ["a case at filing", "testnet", "filing", {}, /is at filing/],
    ["a filed case without ids", "testnet", "filed", {}, /no Kleros dispute id/],
  ] as const)(
    "%s is refused and no event is written",
    async (_what, mode, status, patch, message) => {
      const fake = makeFake();
      const row = insertCase(fake.cases, { mode, status, patch });
      await expect(run(fake, ["pilot:case", "seen-in-court", row.caseId, "--yes"])).rejects.toThrow(
        message,
      );
      expect(fake.cases.events(row.caseId)).toEqual([]);
    },
  );

  test("a control character in --by is refused before the context opens", async () => {
    const fake = makeFake();
    await expect(
      run(fake, ["pilot:case", "seen-in-court", "pc_000000000000", "--by", "a\u0007", "--yes"]),
    ).rejects.toThrow(/--by/);
    expect(fake.opened()).toBe(0);
  });
});

describe("pilot:case fail", () => {
  test("moves a case to failed with the reason as an event", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "funded" });
    const printed = JSON.parse(
      await run(fake, [
        "pilot:case",
        "fail",
        row.caseId,
        "--reason",
        "the seller key was lost",
        "--yes",
      ]),
    );
    expect(printed.case.status).toBe("failed");
    expect(fake.cases.find(row.caseId)?.error).toBe("the seller key was lost");
    expect(fake.cases.events(row.caseId)).toMatchObject([
      { step: "failed", status: "ok", detail: expect.stringMatching(/^the seller key was lost; /) },
    ]);
  });

  test("without --yes it changes nothing", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "funded" });
    const printed = JSON.parse(
      await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "stuck"]),
    );
    expect(printed.dryRun).toBe(true);
    expect(fake.cases.find(row.caseId)?.status).toBe("funded");
    expect(fake.cases.events(row.caseId)).toEqual([]);
  });

  test.each([["settled"], ["failed"]] as const)("a %s case is refused", async (status) => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status });
    await expect(
      run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--yes"]),
    ).rejects.toThrow(new RegExp(`pilot case ${row.caseId} is ${status}`));
    expect(fake.cases.events(row.caseId)).toEqual([]);
  });

  test.each([
    ["testnet", "filed"],
    ["testnet", "ruled"],
    ["live", "filed"],
  ] as const)(
    "a %s case at %s is refused without --force, naming its Kleros ids",
    async (mode, status) => {
      const fake = makeFake();
      const row = insertCase(fake.cases, { mode, status, patch: FILED_TESTNET });
      await expect(
        run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--yes"]),
      ).rejects.toThrow(/--force.*arbitrum-sepolia-testnet.*186.*4|186.*4.*--force/);
      expect(fake.cases.find(row.caseId)?.status).toBe(status);
      expect(fake.cases.events(row.caseId)).toEqual([]);
    },
  );

  test("--force fails a filed testnet case", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { mode: "testnet", status: "filed", patch: FILED_TESTNET });
    await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--force", "--yes"]);
    expect(fake.cases.find(row.caseId)?.status).toBe("failed");
  });

  test("a filed rehearsal case needs no --force", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "filed" });
    const printed = JSON.parse(
      await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--yes"]),
    );
    expect(fake.cases.find(row.caseId)?.status).toBe("failed");
    expect(fake.cases.events(row.caseId).at(-1)?.detail).toBe("x");
    expect(printed.note).not.toContain("forced");
  });

  test("a reason with a control character is refused before the context opens", async () => {
    const fake = makeFake();
    await expect(
      run(fake, ["pilot:case", "fail", "pc_000000000000", "--reason", "a\u0000", "--yes"]),
    ).rejects.toThrow(/--reason/);
    expect(fake.opened()).toBe(0);
  });
});

describe("pilot:case fail: the cap's statuses need --force to fail", () => {
  const guarded = PILOT_FILED_STATUSES.filter((st) => st !== "settled");

  test("the guarded statuses are every cap status but settled", () => {
    expect([...guarded].sort()).toEqual(
      ["evidence_unknown", "filed", "filing", "filing_unknown", "ruled", "settling"].sort(),
    );
  });

  for (const mode of ["testnet", "live"] as const)
    test.each(guarded.map((st) => [st]))(
      `a ${mode} case at %s is refused without --force, and the cap count is unchanged`,
      async (status) => {
        const fake = makeFake();
        const patch = mode === "live" ? FILED_LIVE : FILED_TESTNET;
        const row = insertCase(fake.cases, { mode, status, patch });
        const before = fake.cases.countFiled(mode);
        await expect(
          run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--yes"]),
        ).rejects.toThrow(new RegExp(`is at ${status} in ${mode} mode.*--force`));
        expect(fake.cases.countFiled(mode)).toBe(before);
        expect(fake.cases.find(row.caseId)?.status).toBe(status);
        expect(fake.cases.events(row.caseId)).toEqual([]);

        const printed = JSON.parse(
          await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--force", "--yes"]),
        );
        expect(fake.cases.find(row.caseId)?.status).toBe("failed");
        // The row had no filing time: the forced fail stamps one, so the slot stays used.
        expect(fake.cases.countFiled(mode)).toBe(before);
        expect(fake.cases.find(row.caseId)?.filingStartedAt).toBe(NOW);
        const forced = `forced: x (the case keeps its slot in the ${mode} cap count)`;
        expect(fake.cases.events(row.caseId).at(-1)?.detail).toBe(forced);
        expect(printed.note).toContain(forced);
      },
    );

  test("a filing_unknown refusal names the create-dispute transaction", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, {
      mode: "testnet",
      status: "filing_unknown",
      patch: { klerosChain: "arbitrum-sepolia-testnet", createDisputeTx: FAKE_TX },
    });
    await expect(
      run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--yes"]),
    ).rejects.toThrow(new RegExp(`create-dispute transaction ${FAKE_TX}`));
  });

  test("a testnet case before filing needs no --force", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { mode: "testnet", status: "contested" });
    const printed = JSON.parse(
      await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--yes"]),
    );
    expect(fake.cases.find(row.caseId)?.status).toBe("failed");
    expect(fake.cases.events(row.caseId).at(-1)?.detail).toMatch(/^x; the job still holds/);
    expect(printed.note).not.toContain("forced");
  });
});

describe("pilot:contest: texts with Windows line endings", () => {
  test("CRLF is read as a newline and stored as LF", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "submitted" });
    await run(fake, [
      "pilot:contest",
      "--case",
      row.caseId,
      "--reason-file",
      tempFile("reason.txt", "line one\r\nline two\r\n"),
      "--yes",
    ]);
    expect(fake.cases.find(row.caseId)?.contestReason).toBe("line one\nline two\n");
  });

  test("the 4096-byte limit is measured after CRLF becomes LF", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "submitted" });
    await run(fake, [
      "pilot:contest",
      "--case",
      row.caseId,
      "--reason-file",
      tempFile("reason.txt", `${"x".repeat(4095)}\r\n`),
      "--yes",
    ]);
    expect(fake.cases.find(row.caseId)?.contestReason).toHaveLength(4096);
  });
});

describe("agent ids, resume, sends and the Court", () => {
  test("an environment agent id above uint256 is refused by variable name before the context opens", async () => {
    const fake = makeFake({ agentIds: { buyer: TWO_TO_256, seller: "22" } });
    await expect(run(fake, jobArgs().slice(0, 7))).rejects.toThrow(
      /PILOT_BUYER_AGENT_ID must fit in a uint256/,
    );
    expect(fake.opened()).toBe(0);
  });

  test("the --resume dry run prints the case's mode", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "created", patch: { jobId: "7" } });
    const printed = JSON.parse(await run(fake, jobArgs(["--resume", row.caseId])));
    expect(printed.mode).toBe("rehearsal");
    expect(printed.resume.mode).toBe("rehearsal");
  });

  test("the --resume dry run refuses a case of another mode, sending nothing", async () => {
    const fake = makeFake({ mode: "testnet" });
    const row = insertCase(fake.cases, { mode: "rehearsal", patch: { jobId: "7" } });
    await expect(run(fake, jobArgs(["--resume", row.caseId]))).rejects.toThrow(
      /created in rehearsal mode, and this box runs in testnet mode/,
    );
    expect(fake.createJob).not.toHaveBeenCalled();
    expectNothingSent(fake);
  });

  test("an unconfirmed fund prints its hash and still fails", async () => {
    const fake = makeFake();
    fake.createJob.mockRejectedValueOnce(new JobFundUnconfirmedError("fund", FAKE_TX, 7n));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    const program = new Command();
    program.exitOverride();
    registerPilotCommands(program, fake.open, fake.deps);
    try {
      await expect(program.parseAsync(["node", "cli", ...jobArgs(["--yes"])])).rejects.toThrow(
        /could not confirm it in time/,
      );
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(logs.join("\n")).txHash).toBe(FAKE_TX);
  });

  test("seen-in-court records a filed live case with the live Court URL", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, {
      mode: "live",
      status: "filed",
      patch: { klerosChain: "arbitrum-one", coreDisputeId: "287", localDisputeId: "1" },
    });
    const printed = JSON.parse(
      await run(fake, ["pilot:case", "seen-in-court", row.caseId, "--by", "operator", "--yes"]),
    );
    expect(printed.courtUrl).toBe("https://v2.kleros.builders/#/cases/287/overview");
    expect(fake.cases.events(row.caseId)).toMatchObject([
      { step: "seen_in_court", status: "ok", detail: "by operator" },
    ]);
    expect(fake.cases.countSeenInCourt("live")).toBe(1);
  });
});

describe("pilot:job: the default pre-flight wiring", () => {
  test("the dry run runs the real pre-flight over the chain and lookup built from the context", async () => {
    const fake = makeFake();
    // Only the pre-flight is left at its default: the chain and the lookup are built from ctx.
    const { preflight: _stubbed, ...deps } = fake.deps;
    fake.deps = deps;
    const names: Record<string, string> = {
      "11": "Buyer Wired DAO LLC",
      "12": "Seller Wired DAO LLC",
    };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        const id = url.split("/").at(-1) as string;
        return new Response(
          JSON.stringify({
            agentId: id,
            legalBody: true,
            standing: "active",
            statement: { message: { legalName: names[id] } },
          }),
          { status: 200 },
        );
      }),
    );
    const owners: Record<string, Address> = { "11": ADDR.buyer, "12": ADDR.seller };
    const pub = fake.ctx.publicClient as unknown as { readContract: ReturnType<typeof vi.fn> };
    pub.readContract.mockImplementation(
      async (p: { functionName: string; args: readonly unknown[] }) => {
        if (p.functionName === "ownerOf") return owners[String(p.args[0])];
        if (p.functionName === "balanceOf") return 5_250_000n;
        throw new Error(`unexpected read ${p.functionName}`);
      },
    );
    const printed = JSON.parse(await run(fake, jobArgs()));
    expect(fetched).toEqual([
      "https://api.example.com/legal-bodies/by-agent/11",
      "https://api.example.com/legal-bodies/by-agent/12",
    ]);
    expect(printed.buyer.legalName).toBe("Buyer Wired DAO LLC");
    expect(printed.seller.legalName).toBe("Seller Wired DAO LLC");
    expect(printed.buyerBalanceAtomic).toBe("5250000");
    expect(fake.createJob).not.toHaveBeenCalled();
    expectNothingSent(fake);
  });
});

/** Built from its code point, so the character never appears in the source. */
const EM_DASH = String.fromCodePoint(0x2014);

/** Runs a `pilot:job --yes` that fails; returns the parsed print and the thrown error. */
async function failingJob(
  fake: Fake,
  error: Error,
  argv: string[] = jobArgs(["--yes"]),
): Promise<{ printed: Record<string, unknown>; thrown: unknown }> {
  fake.createJob.mockRejectedValueOnce(error);
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  const program = new Command();
  program.exitOverride();
  registerPilotCommands(program, fake.open, fake.deps);
  let thrown: unknown;
  try {
    await program.parseAsync(["node", "cli", ...argv]);
  } catch (e) {
    thrown = e;
  } finally {
    spy.mockRestore();
  }
  return { printed: JSON.parse(logs.join("\n")), thrown };
}

describe("pilot:job --yes: a failure after the case exists names the case to resume", () => {
  test("a reverted fund prints the case id, its status, the hash and the resume line", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "created", patch: { jobId: "7" } });
    const error = withPilotCaseId(new JobFundRevertedError("fund", FAKE_TX, 7n), row.caseId);
    const { printed, thrown } = await failingJob(fake, error);
    expect(thrown).toBe(error);
    expect(printed).toMatchObject({
      failed: true,
      caseId: row.caseId,
      status: "created",
      txHash: FAKE_TX,
      next: `wait until the transaction is mined or dropped, then run the same command with --resume ${row.caseId} --yes`,
    });
    expect(String(printed.error)).toContain("failed at the fund step");
  });

  test("an unconfirmed submit prints the case id, the hash and the resume line, with no em dash", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "funded", patch: { jobId: "7" } });
    const error = withPilotCaseId(new ChainTxUnconfirmedError("submit", FAKE_TX), row.caseId);
    expect(error.message).toContain(EM_DASH);
    const { printed } = await failingJob(fake, error);
    expect(printed).toMatchObject({
      failed: true,
      caseId: row.caseId,
      status: "funded",
      txHash: FAKE_TX,
    });
    expect(String(printed.next)).toContain(`--resume ${row.caseId} --yes`);
    expect(String(printed.error)).not.toContain(EM_DASH);
    expect(String(printed.error)).toContain("could not confirm it in time: it may still be mined");
  });

  test("a failure with no hash still prints the case id and the resume line", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "funded", patch: { jobId: "7" } });
    const error = withPilotCaseId(new Error("the block read failed"), row.caseId);
    const { printed } = await failingJob(fake, error);
    expect(printed.caseId).toBe(row.caseId);
    expect(printed.txHash).toBeUndefined();
    expect(String(printed.next)).toContain(`--resume ${row.caseId} --yes`);
  });

  test("a failed createJob leaves no case: it prints the hash and says no case was recorded", async () => {
    const fake = makeFake();
    const { printed } = await failingJob(fake, new ChainTxRevertedError("createJob", FAKE_TX));
    expect(printed).toMatchObject({ failed: true, caseId: null, txHash: FAKE_TX });
    expect(String(printed.next)).toMatch(/^no case was recorded/);
    expect(String(printed.next)).not.toContain("--resume");
    expect(fake.cases.list()).toEqual([]);
  });
});

describe("pilot:case fail: a funded job keeps its escrow", () => {
  test.each([["funded"], ["submitted"], ["contested"]] as const)(
    "failing a %s case prints and records that the escrow waits for a claimRefund after expiry",
    async (status) => {
      const fake = makeFake();
      const row = insertCase(fake.cases, { mode: "testnet", status, patch: { jobId: "7" } });
      const printed = JSON.parse(
        await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "stuck", "--yes"]),
      );
      const escrow =
        "job 7 still holds the budget in escrow on chain until a claimRefund after its expiry at 2026-11-04T00:00:00.000Z";
      expect(printed.escrow).toBe(escrow);
      expect(fake.cases.events(row.caseId).at(-1)?.detail).toBe(`stuck; ${escrow}`);
      expect(fake.cases.find(row.caseId)?.error).toBe("stuck");
    },
  );

  test("failing a created case says nothing of an escrow", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { mode: "testnet", status: "created" });
    const printed = JSON.parse(
      await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "stuck", "--yes"]),
    );
    expect(printed.escrow).toBeUndefined();
    expect(fake.cases.events(row.caseId).at(-1)?.detail).toBe("stuck");
  });

  test("the fail help text says every case the cap counts needs --force", () => {
    const program = new Command();
    registerPilotCommands(program, makeFake().open, {});
    const fail = program.commands
      .find((c) => c.name() === "pilot:case")
      ?.commands.find((c) => c.name() === "fail");
    expect(fail?.description()).toBe(
      "mark a case failed, with the reason; every testnet or live case the mode's cap counts needs --force",
    );
  });
});

describe("free texts refuse invisible format characters, naming the code point", () => {
  const FORMAT_CHARACTERS = [
    0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff,
  ];
  const named = (c: number) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;

  test.each(FORMAT_CHARACTERS.map((c) => [named(c), c] as const))(
    "%s in --label is refused before the context opens",
    async (name, c) => {
      const fake = makeFake();
      const args = jobArgs();
      args[2] = `test${String.fromCodePoint(c)}case`;
      await expect(run(fake, args)).rejects.toThrow(
        `refusing: --label holds the invisible format character ${name}`,
      );
      expect(fake.opened()).toBe(0);
    },
  );

  const RLO = String.fromCodePoint(0x202e);

  test("in the description file", async () => {
    const fake = makeFake();
    const args = jobArgs();
    args[4] = tempFile("description.txt", `pay ${RLO}gnp.exe\n`);
    await expect(run(fake, args)).rejects.toThrow(/--description-file .* U\+202E/);
    expect(fake.opened()).toBe(0);
  });

  test.each([["--reason-file"], ["--reply-file"]])("in the contest's %s", async (option) => {
    const fake = makeFake();
    const good = tempFile("good.txt", "a plain text\n");
    const bad = tempFile("bad.txt", `a text${RLO}\n`);
    const files =
      option === "--reason-file"
        ? ["--reason-file", bad, "--reply-file", good]
        : ["--reason-file", good, "--reply-file", bad];
    await expect(
      run(fake, ["pilot:contest", "--case", "pc_000000000000", ...files, "--yes"]),
    ).rejects.toThrow(new RegExp(`${option} .* U\\+202E`));
    expect(fake.opened()).toBe(0);
  });

  test("in --by", async () => {
    const fake = makeFake();
    await expect(
      run(fake, ["pilot:case", "seen-in-court", "pc_000000000000", "--by", `M${RLO}a`, "--yes"]),
    ).rejects.toThrow("refusing: --by holds the invisible format character U+202E");
    expect(fake.opened()).toBe(0);
  });

  test("in the fail reason", async () => {
    const fake = makeFake();
    await expect(
      run(fake, [
        "pilot:case",
        "fail",
        "pc_000000000000",
        "--reason",
        `x${String.fromCodePoint(0x200b)}y`,
        "--yes",
      ]),
    ).rejects.toThrow("refusing: --reason holds the invisible format character U+200B");
    expect(fake.opened()).toBe(0);
  });
});

describe("pilot:job --resume with the hash of a step the case lost", () => {
  const HASH = `0x${"ab".repeat(32)}`;

  test("--fund-tx and --submit-tx reach the job creation with the resume", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "created", patch: { jobId: "7" } });
    await run(
      fake,
      jobArgs(["--yes", "--resume", row.caseId, "--fund-tx", HASH, "--submit-tx", HASH]),
    );
    expect(fake.createJob.mock.calls[0]?.[2]).toBe(row.caseId);
    expect(inputOf(fake.createJob).givenTx).toEqual({ fund: HASH, submit: HASH });
  });

  test("without them the input carries no given hash", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { status: "created", patch: { jobId: "7" } });
    await run(fake, jobArgs(["--yes", "--resume", row.caseId]));
    expect(inputOf(fake.createJob).givenTx).toBeUndefined();
  });

  test.each([
    ["--fund-tx", "0x1234"],
    ["--submit-tx", `0x${"ab".repeat(31)}`],
    ["--fund-tx", "ab".repeat(32)],
    ["--submit-tx", `0x${"zz".repeat(32)}`],
  ])("%s %s is refused before the context opens", async (option, value) => {
    const fake = makeFake();
    await expect(
      run(fake, jobArgs(["--yes", "--resume", "pc_000000000000", option, value])),
    ).rejects.toThrow(`refusing: ${option} must be a transaction hash (0x and 64 hex digits)`);
    expect(fake.opened()).toBe(0);
  });

  test("a hash without --resume is refused before the context opens", async () => {
    const fake = makeFake();
    await expect(run(fake, jobArgs(["--yes", "--fund-tx", HASH]))).rejects.toThrow(
      /pass them with --resume/,
    );
    expect(fake.opened()).toBe(0);
  });
});

describe("pilot:case fail --force on a case whose filing started", () => {
  test("a forced live fail keeps the case's slot in the cap count, and says so", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, {
      mode: "live",
      status: "filed",
      patch: { ...FILED_LIVE, filingStartedAt: NOW },
    });
    expect(fake.cases.countFiled("live")).toBe(1);
    const refusal = await run(fake, [
      "pilot:case",
      "fail",
      row.caseId,
      "--reason",
      "x",
      "--yes",
    ]).catch((e) => e as Error);
    expect(String((refusal as Error).message)).toMatch(/changes nothing there: pass --force/);
    const printed = JSON.parse(
      await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--force", "--yes"]),
    );
    expect(fake.cases.find(row.caseId)?.status).toBe("failed");
    expect(fake.cases.countFiled("live")).toBe(1);
    const forced = "forced: x (the case keeps its slot in the live cap count)";
    expect(fake.cases.events(row.caseId).at(-1)?.detail).toBe(forced);
    expect(printed.note).toContain(forced);
  });
});

describe("free texts refuse every format character and the Hangul fillers", () => {
  test.each([
    ["the first-strong isolate", 0x2068],
    ["the left-to-right isolate", 0x2066],
    ["the pop directional isolate", 0x2069],
    ["the soft hyphen", 0x00ad],
    ["a Unicode tag character", 0xe0041],
    ["the Hangul choseong filler", 0x115f],
    ["the Hangul jungseong filler", 0x1160],
    ["the Hangul filler", 0x3164],
    ["the halfwidth Hangul filler", 0xffa0],
  ])("%s in --label is refused by its code point", async (_n, c) => {
    const fake = makeFake();
    const args = jobArgs();
    args[2] = `test${String.fromCodePoint(c)}case`;
    const named = `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
    await expect(run(fake, args)).rejects.toThrow(
      `refusing: --label holds the invisible format character ${named}`,
    );
    expect(fake.opened()).toBe(0);
  });

  test("an isolate in a contest reason file is refused", async () => {
    const fake = makeFake();
    const bad = tempFile("bad.txt", `a text${String.fromCodePoint(0x2067)}b\n`);
    await expect(
      run(fake, ["pilot:contest", "--case", "pc_000000000000", "--reason-file", bad, "--yes"]),
    ).rejects.toThrow(/--reason-file .* U\+2067/);
  });
});

describe("pilot:job: the label limit and the resume hint", () => {
  test("a label over 64 bytes is refused before the context opens; 64 bytes is accepted", async () => {
    const fake = makeFake();
    const args = jobArgs();
    args[2] = "x".repeat(65);
    await expect(run(fake, args)).rejects.toThrow("refusing: --label is over 64 bytes (65)");
    expect(fake.opened()).toBe(0);
    // Multibyte: 22 three-byte characters are 66 bytes.
    args[2] = "\u20ac".repeat(22);
    await expect(run(fake, args)).rejects.toThrow("refusing: --label is over 64 bytes (66)");
    args[2] = "x".repeat(64);
    await run(fake, args);
    expect(fake.preflight).toHaveBeenCalledTimes(1);
  });

  test("a resume of an unknown case prints no resume hint", async () => {
    const fake = makeFake();
    // The real job creation: it refuses the unknown case before any chain read.
    const { createJob: _stubbed, ...deps } = fake.deps;
    fake.deps = deps;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    const program = new Command();
    program.exitOverride();
    registerPilotCommands(program, fake.open, fake.deps);
    try {
      await expect(
        program.parseAsync(["node", "cli", ...jobArgs(["--yes", "--resume", "pc_000000000000"])]),
      ).rejects.toThrow(/no pilot case pc_000000000000/);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join("\n")).not.toContain("--resume");
    expectNothingSent(fake);
  });
});

describe("pilot:job --yes: a create that failed without a hash", () => {
  test("prints a warning to check the buyer's latest transactions before re-running", async () => {
    const fake = makeFake();
    const { printed } = await failingJob(
      fake,
      withCreateMayHaveBeenSent(new Error("the node dropped the request")),
    );
    expect(printed).toMatchObject({
      failed: true,
      caseId: null,
      warning: "it may have been sent: check the buyer's latest transactions before re-running",
    });
    expect(printed).not.toHaveProperty("txHash");
  });

  test("a refusal before anything was sent prints nothing", async () => {
    const fake = makeFake();
    fake.createJob.mockRejectedValueOnce(new Error("refusing to create the pilot job: x"));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    const program = new Command();
    program.exitOverride();
    registerPilotCommands(program, fake.open, fake.deps);
    try {
      await expect(program.parseAsync(["node", "cli", ...jobArgs(["--yes"])])).rejects.toThrow(
        /refusing to create/,
      );
    } finally {
      spy.mockRestore();
    }
    expect(logs).toEqual([]);
  });
});

describe("pilot:case fail --force on a filed live case with no filing time", () => {
  test("keeps countFiled unchanged and says the slot stays used", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { mode: "live", status: "filed", patch: FILED_LIVE });
    expect(row.filingStartedAt).toBeNull();
    expect(fake.cases.countFiled("live")).toBe(1);
    await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--force", "--yes"]);
    expect(fake.cases.countFiled("live")).toBe(1);
    expect(fake.cases.events(row.caseId).at(-1)?.detail).toBe(
      "forced: x (the case keeps its slot in the live cap count)",
    );
    expect(fake.cases.events(row.caseId).at(-1)?.detail).not.toContain("never started");
  });

  test("a case that is not guarded gets no filing time", async () => {
    const fake = makeFake();
    const row = insertCase(fake.cases, { mode: "testnet", status: "contested" });
    await run(fake, ["pilot:case", "fail", row.caseId, "--reason", "x", "--yes"]);
    expect(fake.cases.find(row.caseId)?.filingStartedAt).toBeNull();
    expect(fake.cases.countFiled("testnet")).toBe(0);
  });
});
