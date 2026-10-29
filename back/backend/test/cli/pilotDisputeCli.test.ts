/**
 * `pilot:dispute` and `pilot:kleros check`, through the commands' own option parsing.
 *
 * Most tests stub the pre-flight, the filing and the check through the commands' dependencies, so
 * a test sees exactly what the command would have run, and in what order. Two run the real steps
 * end to end over the fake node: a rehearsal's dry run and filing on the fake, and a testnet
 * filing over a stubbed `fetch` that answers both the lookups and the Dispute Service.
 */
import { mkdtempSync, readFileSync } from "node:fs";
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
} from "viem";
import { type PrivateKeyAccount, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import { deploymentFor } from "../../src/adapters/kleros/deployments";
import type { CourtClock } from "../../src/adapters/kleros/disputeService";
import { FakeDisputeService } from "../../src/adapters/kleros/fakeDisputeService";
import type { ByAgentAnswer } from "../../src/api/routes/legalBodyStatements";
import { anvilChain } from "../../src/chains";
import { type PilotCommandDeps, registerPilotCommands } from "../../src/cli/pilot";
import type { Config, KlerosConfig, PilotKlerosMode } from "../../src/config/env";
import { migrate } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import { type KlerosStage, buildKlerosService, buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import type { FileOutcome, Preflight } from "../../src/pilot/dispute";
import { createPilotJob } from "../../src/pilot/job";
import type { KlerosCheckResult } from "../../src/pilot/klerosCheck";
import { httpLookupClient } from "../../src/pilot/lookup";
import type { PilotCaseRecord } from "../../src/pilot/types";
import {
  JOB_CONTRACT,
  USDC,
  evaluatorAccount,
  fakeChain,
  jobClientAccount,
  usdcJobNode,
} from "../helpers/jobFundHarness";

/** The seller signs with a key made for this run; the buyer and the referee are the harness's. */
const sellerAccount = privateKeyToAccount(generatePrivateKey());
/** The config's pilot keys, made for this run: no command here signs with them. */
const PILOT_KEYS = {
  buyer: generatePrivateKey(),
  seller: generatePrivateKey(),
  referee: generatePrivateKey(),
};
const ADDR = {
  buyer: jobClientAccount.address as Address,
  seller: sellerAccount.address as Address,
  referee: evaluatorAccount.address as Address,
};
const TESTNET_KEY = "test-key-testnet";
const LIVE_KEY = "test-key-live";
const API_URL = "https://dispute-service.example.test/mcp";
const LOOKUP_BASE = "https://api.example.com";
const POLICY = "/ipfs/test-policy-uri";
const KLEROS: KlerosConfig = {
  apiKeyTestnet: TESTNET_KEY,
  apiKeyLive: LIVE_KEY,
  apiUrl: API_URL,
  courtIdTestnet: 8,
  courtIdLive: 34,
  aliasClient: "client",
  aliasProvider: "provider",
  expectedOptions: {},
  policyUri: POLICY,
};
/** 2026-10-28T10:00:00Z. */
const NOW = 1_793_181_600;
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "pilot");
const fixtureText = (name: string) => readFileSync(join(FIXTURES, name), "utf8").replace(/\n$/, "");
const fixtureAnswer = (side: "buyer" | "seller"): ByAgentAnswer =>
  JSON.parse(readFileSync(join(FIXTURES, `lookup-${side}.json`), "utf8")) as ByAgentAnswer;
const CSV = new Uint8Array(readFileSync(join(FIXTURES, "test-case-1-report.csv")));
const COURT: CourtClock = {
  courtId: 8,
  timesPerPeriod: [900, 2700, 1800, 2700],
  hiddenVotes: true,
  raw: { id: "8" },
};
const EVIDENCE_TEXT = "**TEST DATA.** the whole record, every section, word for word.\n";

beforeEach(() => resetSenderNonces());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function configFor(mode: PilotKlerosMode, over: Partial<Config> = {}): Config {
  return {
    chainId: anvilChain.id,
    jobContract: "0x0000000000000000000000000000000000000b0b",
    usdc: "0x3600000000000000000000000000000000000000",
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    arcExplorerUrl: "https://explorer.example.com",
    arcNetwork: "testnet",
    maxJobBudget: 10_000_000n,
    pilot: {
      buyerPrivateKey: PILOT_KEYS.buyer,
      sellerPrivateKey: PILOT_KEYS.seller,
      refereePrivateKey: PILOT_KEYS.referee,
      mode,
      testnetCasesCap: 10,
      liveCasesCap: 5,
      lookupBase: LOOKUP_BASE,
    },
    kleros: KLEROS,
    ...over,
  } as unknown as Config;
}

/** The stubbed command world: a context over an in-memory case table, and every step a spy. */
function makeFake(mode: PilotKlerosMode = "rehearsal") {
  const transport = custom({
    request: async ({ method }: { method: string }) => {
      throw new Error(`no network in this test: ${method}`);
    },
  });
  const wallet = (account: PrivateKeyAccount): WalletClient =>
    createWalletClient({ account, chain: anvilChain, transport });
  const db = new Database(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const cfg = configFor(mode);
  const ctx = {
    cfg,
    db,
    cases,
    docStore: new FileDocumentStore(mkdtempSync(join(tmpdir(), "pilot-dispute-cli-"))),
    publicClient: {} as PublicClient,
    sendClient: {} as PublicClient,
    wallets: {
      buyer: wallet(jobClientAccount),
      seller: wallet(sellerAccount),
      referee: wallet(evaluatorAccount),
    },
    addresses: ADDR,
    close: () => {},
  } as unknown as PilotContext;
  let opens = 0;
  const order: string[] = [];
  const caseRow = insertContested(cases, mode);
  const preflight = vi.fn(async (_d: unknown, _caseId: string, _o: unknown): Promise<Preflight> => {
    order.push("preflight");
    return okPreflight(mode);
  });
  const file = vi.fn(async (_d: unknown, caseId: string, _o: unknown): Promise<FileOutcome> => {
    order.push("file");
    const chain = mode === "rehearsal" ? "fake" : deploymentFor(mode).chain;
    cases.advance(caseId, "contested", "filed", { klerosChain: chain, coreDisputeId: "186" });
    return {
      outcome: "filed",
      coreDisputeId: "186",
      localDisputeId: "42",
      evidenceStatus: "mined",
    };
  });
  const check = vi.fn(
    async (stage: KlerosStage): Promise<KlerosCheckResult> => ({
      deployment: stage.deployment,
      tools: ["dispute_create", "evidence_pin", "evidence_submit"],
      instructions: "the key's own instructions, printed in full",
      court: COURT,
      problems: [],
    }),
  );
  const stages: KlerosStage[] = [];
  const buildStage = vi.fn((c: Config, o: Parameters<typeof buildKlerosService>[1]) => {
    const stage = buildKlerosService(c, o);
    stages.push(stage);
    return stage;
  });
  const sleep = vi.fn(async (ms: number) => {
    order.push(`sleep ${ms}`);
  });
  const deps: Partial<PilotCommandDeps> = {
    readConfig: () => cfg,
    now: () => NOW,
    preflightDispute: preflight as unknown as PilotCommandDeps["preflightDispute"],
    fileDispute: file as unknown as PilotCommandDeps["fileDispute"],
    checkKleros: check as unknown as PilotCommandDeps["checkKleros"],
    buildStage: buildStage as unknown as PilotCommandDeps["buildStage"],
    sleep,
  };
  return {
    ctx,
    cases,
    cfg,
    caseRow,
    preflight,
    file,
    check,
    buildStage,
    stages,
    sleep,
    order,
    deps,
    open: () => {
      opens++;
      return ctx;
    },
    opened: () => opens,
  };
}
type Fake = ReturnType<typeof makeFake>;

function okPreflight(mode: PilotKlerosMode): Preflight {
  return {
    ok: true,
    evidence: {
      name: "Job TEST-1: the complete record (test data)",
      description: EVIDENCE_TEXT,
      sha256: `0x${"ab".repeat(32)}`,
      byteLength: EVIDENCE_TEXT.length,
    },
    court: COURT,
    instructions: "the key's own instructions, printed in full",
    escrow: {
      status: 2,
      budget: 500_000n,
      expiredAt: BigInt(NOW + 7 * 86_400),
      client: ADDR.buyer,
      evaluator: ADDR.referee,
    },
    records: { buyer: fixtureAnswer("buyer"), seller: fixtureAnswer("seller") },
    filedCount: 3,
    cap: mode === "testnet" ? 10 : mode === "live" ? 5 : null,
  };
}

function insertContested(cases: SqlitePilotCaseRepository, mode: PilotKlerosMode): PilotCaseRecord {
  const caseId = newCaseId();
  cases.insert({
    caseId,
    label: "TEST-1",
    mode,
    chainId: anvilChain.id,
    jobContract: "0x0000000000000000000000000000000000000b0b",
    buyerAddress: ADDR.buyer,
    buyerAgentId: "1001",
    sellerAddress: ADDR.seller,
    sellerAgentId: "1002",
    refereeAddress: ADDR.referee,
    budgetAtomic: "500000",
    description: "a test job",
    expiredAt: NOW + 7 * 86_400,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
  });
  return cases.advance(caseId, "created", "contested") as PilotCaseRecord;
}

/** Runs one command line; returns every line it printed. Throws what the command throws. */
async function run(
  open: () => PilotContext,
  deps: Partial<PilotCommandDeps>,
  argv: string[],
  lines: string[] = [],
): Promise<string[]> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPilotCommands(program, open, deps);
  const spy = vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
  try {
    await program.parseAsync(["node", "cli", ...argv]);
  } finally {
    spy.mockRestore();
  }
  return lines;
}
const runFake = (fake: Fake, argv: string[], lines?: string[]) =>
  run(fake.open, fake.deps, argv, lines);
/** The last line that parses as a JSON object: the command's result. */
const resultOf = (lines: string[]): Record<string, unknown> => {
  for (const line of [...lines].reverse()) {
    try {
      const v = JSON.parse(line);
      if (typeof v === "object" && v !== null && !("opslog" in v)) return v;
    } catch {
      // the banner, or another plain line
    }
  }
  throw new Error("no JSON result printed");
};

const disputeArgs = (fake: Fake, extra: string[] = []) => [
  "pilot:dispute",
  "--case",
  fake.caseRow.caseId,
  ...extra,
];

describe("pilot:dispute: the flags, checked before the context opens", () => {
  test.each([
    ["testnet", ["--testnet", "--live"], "--testnet and --live cannot both be given"],
    [
      "testnet",
      ["--live"],
      "--live is accepted in live mode only, and this box runs in testnet mode",
    ],
    [
      "rehearsal",
      ["--live"],
      "--live is accepted in live mode only, and this box runs in rehearsal mode",
    ],
    [
      "live",
      ["--testnet"],
      "--testnet is accepted in testnet mode only, and this box runs in live mode",
    ],
    [
      "rehearsal",
      ["--testnet"],
      "--testnet is accepted in testnet mode only, and this box runs in rehearsal mode",
    ],
    [
      "testnet",
      ["--script", "refund"],
      "--script is accepted in rehearsal mode only, and this box runs in testnet mode",
    ],
    ["rehearsal", ["--allow-standing", "Pending!"], "--allow-standing"],
  ] as const)("%s mode, %j: refused", async (mode, extra, message) => {
    const fake = makeFake(mode);
    await expect(runFake(fake, disputeArgs(fake, [...extra, "--yes"]))).rejects.toThrow(message);
    expect(fake.opened()).toBe(0);
    expect(fake.preflight).not.toHaveBeenCalled();
    expect(fake.file).not.toHaveBeenCalled();
  });

  test("a case id that is not one is refused", async () => {
    const fake = makeFake();
    await expect(runFake(fake, ["pilot:dispute", "--case", "TEST-1"])).rejects.toThrow(
      "--case must be a pilot case id",
    );
    expect(fake.opened()).toBe(0);
  });

  test("an unknown --script is refused before the context opens", async () => {
    const fake = makeFake();
    await expect(runFake(fake, disputeArgs(fake, ["--script", "win"]))).rejects.toThrow(/script/);
    expect(fake.opened()).toBe(0);
  });

  test("a rehearsal's --script picks the fake's script", async () => {
    const fake = makeFake();
    await runFake(fake, disputeArgs(fake, ["--script", "refund"]));
    expect(fake.buildStage).toHaveBeenCalledWith(fake.cfg, { script: "refund" });
    expect(fake.stages[0]?.service).toBeInstanceOf(FakeDisputeService);
  });
});

describe("pilot:dispute: the dry run", () => {
  test.each(["rehearsal", "testnet", "live"] as const)(
    "%s, without --yes: prints the evidence in full, the instructions, the clock, the escrow, the cap and count, and files nothing",
    async (mode) => {
      const fake = makeFake(mode);
      const lines = await runFake(fake, disputeArgs(fake));
      const out = resultOf(lines);
      expect(out.dryRun).toBe(true);
      expect(out.evidence).toEqual({
        name: "Job TEST-1: the complete record (test data)",
        sha256: `0x${"ab".repeat(32)}`,
        byteLength: EVIDENCE_TEXT.length,
        description: EVIDENCE_TEXT,
      });
      expect(out.instructions).toBe("the key's own instructions, printed in full");
      expect(out.court).toEqual({
        courtId: 8,
        evidenceSeconds: 900,
        commitSeconds: 2700,
        voteSeconds: 1800,
        appealSeconds: 2700,
        hiddenVotes: true,
      });
      expect(out.escrow).toEqual({
        status: 2,
        budgetAtomic: "500000",
        expiredAt: NOW + 7 * 86_400,
        expiresAt: new Date((NOW + 7 * 86_400) * 1000).toISOString(),
        client: ADDR.buyer,
        evaluator: ADDR.referee,
      });
      expect([out.filedCount, out.cap]).toEqual([
        3,
        mode === "testnet" ? 10 : mode === "live" ? 5 : null,
      ]);
      expect(out.stage).toMatchObject({
        mode,
        chain: mode === "rehearsal" ? "fake" : deploymentFor(mode).chain,
        key: mode === "rehearsal" ? null : mode,
      });
      expect(String(out.next)).toContain("nothing was sent");
      expect(fake.preflight).toHaveBeenCalledTimes(1);
      expect(fake.file).not.toHaveBeenCalled();
      expect(fake.sleep).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["testnet", "--testnet --yes"],
    ["live", "--live --yes"],
  ] as const)(
    "%s with --yes but without its flag: the dry run, and nothing filed",
    async (mode, needs) => {
      const fake = makeFake(mode);
      const out = resultOf(await runFake(fake, disputeArgs(fake, ["--yes"])));
      expect(out.dryRun).toBe(true);
      expect(String(out.next)).toContain(needs);
      expect(fake.file).not.toHaveBeenCalled();
    },
  );

  test("--allow-standing reaches the pre-flight", async () => {
    const fake = makeFake();
    await runFake(fake, disputeArgs(fake, ["--allow-standing", "pending"]));
    expect(fake.preflight.mock.calls[0]?.[2]).toEqual({ allowStanding: "pending" });
  });

  test("a pre-flight problem is refused, and nothing is filed", async () => {
    const fake = makeFake("testnet");
    fake.preflight.mockResolvedValue({ ok: false, problem: "the evidence cannot be rendered" });
    await expect(runFake(fake, disputeArgs(fake))).rejects.toThrow(
      "refusing: the evidence cannot be rendered",
    );
    await expect(runFake(fake, disputeArgs(fake, ["--testnet", "--yes"]))).rejects.toThrow(
      "refusing: the evidence cannot be rendered",
    );
    expect(fake.file).not.toHaveBeenCalled();
    expect(fake.sleep).not.toHaveBeenCalled();
  });
});

describe("pilot:dispute: the filing", () => {
  test("a rehearsal with --yes files with no banner and no wait", async () => {
    const fake = makeFake();
    const lines = await runFake(fake, disputeArgs(fake, ["--yes"]));
    expect(fake.order).toEqual(["file"]);
    expect(fake.file.mock.calls[0]?.[2]).toEqual({ confirmedFlag: null });
    const out = resultOf(lines);
    expect(out).toMatchObject({
      outcome: "filed",
      coreDisputeId: "186",
      status: "filed",
      courtUrl: null,
    });
    expect(lines.some((l) => l.includes("juror count"))).toBe(false);
  });

  test.each([
    [
      "testnet",
      "--testnet",
      "arbitrum-sepolia-testnet",
      8,
      10,
      "https://v2-testnet.kleros.builders/#/cases/186/overview",
    ],
    ["live", "--live", "arbitrum-one", 34, 5, "https://v2.kleros.builders/#/cases/186/overview"],
  ] as const)(
    "%s with %s --yes: the banner, a 1 s wait, then the filing, and the Court URL",
    async (mode, flag, chain, court, cap, url) => {
      const fake = makeFake(mode);
      const lines = await runFake(fake, disputeArgs(fake, [flag, "--yes"]));
      expect(fake.order).toEqual(["preflight", "sleep 1000", "file"]);
      expect(fake.file.mock.calls[0]?.[2]).toEqual({ confirmedFlag: flag });

      const banner = lines.find((l) => l.includes("juror count"));
      expect(banner).toBeDefined();
      for (const fact of [
        `stage: ${mode}`,
        `chain: ${chain}`,
        `court id: ${court}`,
        "juror count: as the preset sets it",
        `key: ${mode}`,
        `policy URI: ${POLICY}`,
        `cap: 3 filed so far, of ${cap}`,
        `case: TEST-1 (${fake.caseRow.caseId})`,
        `evidence: sha256 0x${"ab".repeat(32)}, ${EVIDENCE_TEXT.length} bytes`,
      ])
        expect(banner).toContain(fact);
      expect(lines.indexOf(banner!)).toBeLessThan(lines.length - 1);

      const out = resultOf(lines);
      expect(out).toMatchObject({ outcome: "filed", coreDisputeId: "186", courtUrl: url });
      for (const key of [TESTNET_KEY, LIVE_KEY]) expect(lines.join("\n")).not.toContain(key);
    },
  );

  test("a juror count the court's payload carries is printed in the banner", async () => {
    const fake = makeFake("testnet");
    fake.preflight.mockResolvedValue({
      ...(okPreflight("testnet") as Extract<Preflight, { ok: true }>),
      court: { ...COURT, raw: { id: "8", jurors: 5 } },
    });
    const lines = await runFake(fake, disputeArgs(fake, ["--testnet", "--yes"]));
    expect(lines.find((l) => l.includes("juror count"))).toContain("juror count: 5");
  });

  test("filed with its evidence in doubt: exit 0, with a warning and a next step that says so", async () => {
    const fake = makeFake();
    fake.file.mockImplementation(async (_d: unknown, caseId: string) => {
      fake.cases.advance(caseId, "contested", "evidence_unknown", {
        klerosChain: "fake",
        coreDisputeId: "186",
      });
      return { outcome: "filed", coreDisputeId: "186", evidenceStatus: "unknown" };
    });
    const out = resultOf(await runFake(fake, disputeArgs(fake, ["--yes"])));
    expect(out).toMatchObject({
      outcome: "filed",
      evidenceStatus: "unknown",
      status: "evidence_unknown",
    });
    expect(String(out.warning)).toContain("the evidence item is in doubt");
    expect(String(out.next)).toContain("check the Court's evidence tab");
    expect(String(out.next)).toContain("do not submit again without deciding with Kleros");
  });

  test("not_sent: the outcome is printed and the command fails", async () => {
    const fake = makeFake();
    fake.file.mockResolvedValue({
      outcome: "not_sent",
      code: "INSUFFICIENT_BALANCE",
      text: "Kleros refused the filing and nothing was sent: INSUFFICIENT_BALANCE",
    });
    const lines: string[] = [];
    await expect(runFake(fake, disputeArgs(fake, ["--yes"]), lines)).rejects.toThrow(
      "refusing: Kleros refused the filing and nothing was sent: INSUFFICIENT_BALANCE",
    );
    const out = resultOf(lines);
    expect(out).toMatchObject({
      failed: true,
      outcome: "not_sent",
      code: "INSUFFICIENT_BALANCE",
      status: "contested",
    });
    expect(String(out.next)).toContain("nothing was sent");
  });

  test("filing_unknown: the hash is printed, the next step never files again, and the command fails", async () => {
    const fake = makeFake();
    const txHash: Hex = `0x${"cd".repeat(32)}`;
    fake.file.mockResolvedValue({ outcome: "filing_unknown", txHash, text: "no receipt in time" });
    const lines: string[] = [];
    await expect(runFake(fake, disputeArgs(fake, ["--yes"]), lines)).rejects.toThrow(
      "no receipt in time",
    );
    const out = resultOf(lines);
    expect(out).toMatchObject({ failed: true, outcome: "filing_unknown", txHash });
    expect(String(out.next)).toContain("do not file it again");
  });
});

describe("pilot:dispute on a row left at filing, testnet mode, through the real steps", () => {
  /** A testnet row a command left at `filing`, and a fetch that records every request. */
  function leftAtFiling(o: { startedAgo: number; ids?: boolean }) {
    const fake = makeFake("testnet");
    const { caseId } = fake.caseRow;
    fake.cases.advance(caseId, "contested", "filing", {
      filingStartedAt: NOW - o.startedAgo,
      klerosChain: "arbitrum-sepolia-testnet",
      klerosCourtId: 8,
      klerosPolicyUri: POLICY,
      ...(o.ids ? { coreDisputeId: "186", localDisputeId: "42" } : {}),
    });
    fake.cases.recordEvent(caseId, "filing", "started", "arbitrum-sepolia-testnet", null);
    fake.cases.recordEvent(caseId, "create", "sending", null, null);
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      requests.push(String(url));
      throw new Error("no request is made on this path");
    });
    // The real pre-flight and filing; only the config, the clock, the stage and the wait are the test's.
    const deps: Partial<PilotCommandDeps> = {
      readConfig: fake.deps.readConfig,
      now: () => NOW,
      buildStage: fake.deps.buildStage,
      sleep: fake.sleep,
    };
    const go = (lines: string[]) =>
      run(fake.open, deps, ["pilot:dispute", "--case", caseId, "--testnet", "--yes"], lines);
    return { fake, caseId, requests, go };
  }

  test("started under 30 minutes ago: a filing is in progress, the row stays at filing, nothing is read", async () => {
    const w = leftAtFiling({ startedAgo: 60 });
    const lines: string[] = [];
    await expect(w.go(lines)).rejects.toThrow("a filing is in progress: wait");
    expect(resultOf(lines)).toMatchObject({
      failed: true,
      outcome: "not_sent",
      code: "filing_in_progress",
    });
    expect(w.fake.cases.find(w.caseId)?.status).toBe("filing");
    expect(w.requests).toEqual([]);
    expect(w.fake.sleep).not.toHaveBeenCalled();
  });

  test("started over 30 minutes ago with a create sent and no id: filing_unknown, nothing is read", async () => {
    const w = leftAtFiling({ startedAgo: 31 * 60 });
    const lines: string[] = [];
    await expect(w.go(lines)).rejects.toThrow("filing_unknown");
    expect(resultOf(lines)).toMatchObject({ failed: true, outcome: "filing_unknown" });
    expect(w.fake.cases.find(w.caseId)?.status).toBe("filing_unknown");
    expect(w.requests).toEqual([]);
  });

  test("started over 30 minutes ago with a dispute id: evidence_unknown, filed with a warning", async () => {
    const w = leftAtFiling({ startedAgo: 31 * 60, ids: true });
    const out = resultOf(await w.go([]));
    expect(out).toMatchObject({
      outcome: "filed",
      coreDisputeId: "186",
      evidenceStatus: "unknown",
      status: "evidence_unknown",
      courtUrl: "https://v2-testnet.kleros.builders/#/cases/186/overview",
    });
    expect(String(out.warning)).toContain("in doubt");
    expect(w.requests).toEqual([]);
  });
});

describe("pilot:kleros check", () => {
  test("prints the check, the instructions in full, and succeeds when there is no problem", async () => {
    const fake = makeFake("testnet");
    const out = resultOf(await runFake(fake, ["pilot:kleros", "check"]));
    expect(out).toMatchObject({
      mode: "testnet",
      instructions: "the key's own instructions, printed in full",
      problems: [],
    });
    expect(fake.buildStage).toHaveBeenCalledWith(fake.cfg, {});
    expect(fake.opened()).toBe(0);
  });

  test("a problem is printed and the command fails", async () => {
    const fake = makeFake("testnet");
    fake.check.mockResolvedValue({
      deployment: deploymentFor("testnet"),
      tools: [],
      instructions: null,
      court: null,
      problems: ["court_get did not answer"],
    });
    const lines: string[] = [];
    await expect(runFake(fake, ["pilot:kleros", "check"], lines)).rejects.toThrow(
      "court_get did not answer",
    );
    expect(resultOf(lines).problems).toEqual(["court_get did not answer"]);
  });

  test.each(["testnet", "live"] as const)(
    "--real-reads %s in rehearsal builds that reader",
    async (name) => {
      const fake = makeFake("rehearsal");
      await runFake(fake, ["pilot:kleros", "check", "--real-reads", name]);
      expect(fake.buildStage).toHaveBeenCalledWith(fake.cfg, { realReads: name });
      expect(fake.stages[0]?.deployment).toEqual(deploymentFor(name));
    },
  );

  test.each([
    [
      "testnet",
      "testnet",
      "--real-reads is accepted in rehearsal mode only, and this box runs in testnet mode",
    ],
    [
      "live",
      "live",
      "--real-reads is accepted in rehearsal mode only, and this box runs in live mode",
    ],
    ["rehearsal", "mainnet", "--real-reads must be testnet or live"],
  ] as const)("%s mode, --real-reads %s: refused", async (mode, value, message) => {
    const fake = makeFake(mode);
    await expect(runFake(fake, ["pilot:kleros", "check", "--real-reads", value])).rejects.toThrow(
      message,
    );
    expect(fake.buildStage).not.toHaveBeenCalled();
  });

  test("the real check over the testnet key prints no key", async () => {
    const fake = makeFake("testnet");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      const result =
        body.method === "initialize"
          ? { instructions: "arbitrum-sepolia-testnet, court 8" }
          : body.method === "tools/list"
            ? {
                tools: ["dispute_create", "evidence_pin", "evidence_submit"].map((name) => ({
                  name,
                })),
              }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      id: "8",
                      timesPerPeriod: [900, 2700, 1800, 2700],
                      hiddenVotes: true,
                    }),
                  },
                ],
              };
      return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
        status: 200,
      });
    });
    // The real check, over the real HTTP client the stage builds with the testnet key.
    const deps = { readConfig: fake.deps.readConfig, buildStage: fake.deps.buildStage };
    const lines = await run(fake.open, deps, ["pilot:kleros", "check"]);
    expect(resultOf(lines).problems).toEqual([]);
    expect(seen).toEqual([
      `Bearer ${TESTNET_KEY}`,
      `Bearer ${TESTNET_KEY}`,
      `Bearer ${TESTNET_KEY}`,
    ]);
    for (const key of [TESTNET_KEY, LIVE_KEY]) expect(lines.join("\n")).not.toContain(key);
  });
});

// --- end to end over the fake node: the real pre-flight and the real filing ---

describe("pilot:dispute end to end", () => {
  async function realWorld(mode: PilotKlerosMode) {
    const node = usdcJobNode({
      usdc: USDC,
      jobContract: JOB_CONTRACT,
      budget: 500_000n,
      now: () => NOW,
      runSubmit: true,
      answerTransactions: true,
      identityRegistry: "0x0000000000000000000000000000000000000005",
      ownerOf: (id) =>
        ({ "1001": jobClientAccount.address as Address, "1002": ADDR.seller })[id.toString()],
    });
    node.mint(jobClientAccount.address as Address, 10_000_000n);
    const db = new Database(":memory:");
    migrate(db);
    const cases = new SqlitePilotCaseRepository(db);
    const cfg = configFor(mode, {
      chainId: fakeChain.id,
      jobContract: JOB_CONTRACT,
      usdc: USDC,
      identityRegistry: "0x0000000000000000000000000000000000000005",
    } as Partial<Config>);
    const ctx = {
      cfg,
      db,
      cases,
      docStore: new FileDocumentStore(mkdtempSync(join(tmpdir(), "pilot-dispute-cli-e2e-"))),
      publicClient: node.publicClient,
      sendClient: node.sendClient,
      wallets: {
        buyer: node.walletFor(jobClientAccount),
        seller: node.walletFor(sellerAccount),
        referee: node.walletFor(evaluatorAccount),
      },
      addresses: {
        buyer: jobClientAccount.address as Address,
        seller: ADDR.seller,
        referee: evaluatorAccount.address as Address,
      },
      close: () => {},
    } as unknown as PilotContext;
    const sequence: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith(`${LOOKUP_BASE}/legal-bodies/by-agent/`)) {
        const id = u.slice(u.lastIndexOf("/") + 1);
        return Response.json(fixtureAnswer(id === "1001" ? "buyer" : "seller"));
      }
      const body = JSON.parse(String(init?.body));
      const tool = body.method === "tools/call" ? body.params.name : body.method;
      sequence.push(tool);
      const payload: Record<string, unknown> = {
        court_get: { id: "8", timesPerPeriod: [900, 2700, 1800, 2700], hiddenVotes: true },
        evidence_pin: { status: "published", fileURI: "/ipfs/bafye2e", cid: "bafye2e" },
        dispute_create: {
          status: "mined",
          coreDisputeID: "186",
          localDisputeID: "42",
          txHash: `0x${"c1".repeat(32)}`,
        },
        evidence_submit: { status: "mined", txHash: `0x${"c2".repeat(32)}` },
      };
      const result =
        tool === "initialize"
          ? { instructions: "arbitrum-sepolia-testnet, court 8, 5 jurors" }
          : tool === "tools/list"
            ? {
                tools: ["dispute_create", "evidence_pin", "evidence_submit"].map((name) => ({
                  name,
                })),
              }
            : { content: [{ type: "text", text: JSON.stringify(payload[tool]) }] };
      return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
        status: 200,
      });
    });
    const row = await createPilotJob(
      {
        chain: buildPilotChain(ctx),
        cases,
        docStore: ctx.docStore,
        lookup: httpLookupClient(LOOKUP_BASE),
        agentIds: { buyer: "1001", seller: "1002" },
        now: () => NOW,
        maxBudgetAtomic: 2_000_000n,
      },
      {
        label: "TEST-1",
        description: fixtureText("test-case-1-description.txt"),
        deliverable: { bytes: CSV, extension: "csv" },
        budgetAtomic: 500_000n,
        expirySeconds: 7 * 86_400,
        mode,
      },
    );
    cases.advance(row.caseId, "submitted", "contested", {
      contestReason: fixtureText("test-case-1-reason.txt"),
      contestReply: fixtureText("test-case-1-reply.txt"),
      contestedAt: NOW + 600,
    });
    const stages: KlerosStage[] = [];
    const sleeps: number[] = [];
    const deps: Partial<PilotCommandDeps> = {
      readConfig: () => cfg,
      now: () => NOW + 900,
      buildStage: ((c: Config, o: Parameters<typeof buildKlerosService>[1]) => {
        const s = buildKlerosService(c, o);
        stages.push(s);
        return s;
      }) as PilotCommandDeps["buildStage"],
      sleep: async (ms) => {
        sequence.push(`sleep ${ms}`);
        sleeps.push(ms);
      },
    };
    return { ctx, cases, caseId: row.caseId, deps, stages, sequence, sleeps };
  }

  test("a rehearsal: the dry run prints the whole evidence and calls no write; --yes then files it on the fake", async () => {
    const w = await realWorld("rehearsal");
    const dry = resultOf(await run(() => w.ctx, w.deps, ["pilot:dispute", "--case", w.caseId]));
    const evidence = dry.evidence as { description: string; name: string };
    const row = w.cases.find(w.caseId)!;
    expect(evidence.description).toBe(w.ctx.docStore.get(row.evidencePath!));
    expect(evidence.description.startsWith("**TEST DATA.** ")).toBe(true);
    expect(evidence.description).toContain(new TextDecoder().decode(CSV));
    const fake = w.stages[0]?.service as FakeDisputeService;
    expect(fake.calls.map((c) => c.tool)).toEqual(["tools/list", "initialize", "court_get"]);
    expect(row.status).toBe("contested");

    const filed = resultOf(
      await run(() => w.ctx, w.deps, ["pilot:dispute", "--case", w.caseId, "--yes"]),
    );
    expect(filed).toMatchObject({ outcome: "filed", status: "filed", courtUrl: null });
    expect(w.cases.find(w.caseId)?.klerosChain).toBe("fake");
    expect(w.sleeps).toEqual([]);
  });

  test("testnet with --testnet --yes: the writes come after the banner's wait; the Court URL is printed", async () => {
    const w = await realWorld("testnet");
    const lines = await run(() => w.ctx, w.deps, [
      "pilot:dispute",
      "--case",
      w.caseId,
      "--testnet",
      "--yes",
    ]);
    const wait = w.sequence.indexOf("sleep 1000");
    expect(wait).toBeGreaterThan(-1);
    expect(w.sequence.slice(0, wait)).not.toContain("evidence_pin");
    expect(w.sequence.slice(wait)).toEqual(
      expect.arrayContaining(["evidence_pin", "dispute_create", "evidence_submit"]),
    );
    const out = resultOf(lines);
    expect(out).toMatchObject({
      outcome: "filed",
      status: "filed",
      courtUrl: "https://v2-testnet.kleros.builders/#/cases/186/overview",
    });
    expect(lines.some((l) => l.includes('"opslog":"pilot_case_filed"'))).toBe(true);
    for (const key of [TESTNET_KEY, LIVE_KEY]) expect(lines.join("\n")).not.toContain(key);
  });
});
