/**
 * Filing a pilot case's dispute: the pre-flight, the three writes (pin, create, submit) and every
 * guard in front of them, over the fake node (real JobAdapter, real signers, real SQLite) with the
 * job created, funded and submitted by the pilot job step itself, and contested.
 *
 * Each test builds its own stage: the scripted fake for a rehearsal, or the HTTP client over a
 * recording `fetch` for testnet and live, so a test can count every request that reached the
 * service. The lookups answer the two fixture records. Time is injected: nothing waits.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Address, type Hex, keccak256, sha256, stringToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import { type KlerosDeploymentName, deploymentFor } from "../../src/adapters/kleros/deployments";
import type {
  CreateOutcome,
  PinOutcome,
  SubmitOutcome,
} from "../../src/adapters/kleros/disputeService";
import { KlerosRefusal } from "../../src/adapters/kleros/errors";
import {
  FakeDisputeService,
  type FakeDisputeServiceOptions,
  type FakeScript,
} from "../../src/adapters/kleros/fakeDisputeService";
import { HttpDisputeService } from "../../src/adapters/kleros/httpDisputeService";
import type { ByAgentAnswer } from "../../src/api/routes/legalBodyStatements";
import type { Config, KlerosConfig } from "../../src/config/env";
import type { SignedStatementJson } from "../../src/legalBody/publicStatement";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import { type KlerosStage, buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import { type FileDisputeDeps, fileDispute, preflightDispute } from "../../src/pilot/dispute";
import { createPilotJob } from "../../src/pilot/job";
import type { LookupClient } from "../../src/pilot/lookup";
import type { PilotCaseRecord, PilotMode, PilotStatus } from "../../src/pilot/types";
import {
  JOB_CONTRACT,
  USDC,
  evaluatorAccount,
  fakeChain,
  jobClientAccount,
  usdcJobNode,
} from "../helpers/jobFundHarness";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "pilot");
const fixtureText = (name: string) => readFileSync(join(FIXTURES, name), "utf8").replace(/\n$/, "");
const fixtureAnswer = (side: "buyer" | "seller"): ByAgentAnswer =>
  JSON.parse(readFileSync(join(FIXTURES, `lookup-${side}.json`), "utf8")) as ByAgentAnswer;

/** The seller signs with a key made for this run; the buyer and the referee are the harness's. */
const sellerAccount = privateKeyToAccount(generatePrivateKey());
const BUYER = jobClientAccount.address as Address;
const SELLER = sellerAccount.address as Address;
const REFEREE = evaluatorAccount.address as Address;
const REGISTRY = "0x0000000000000000000000000000000000000005" as Address;
/** The fixture records' agents. */
const BUYER_AGENT = "1001";
const SELLER_AGENT = "1002";
/** 0.5 USDC: what the node's fund pulls. */
const BUDGET = 500_000n;
/** 2026-10-28T10:00:00Z. */
const NOW = 1_793_181_600;
const CSV = new Uint8Array(readFileSync(join(FIXTURES, "test-case-1-report.csv")));

const API_URL = "https://dispute-service.example.test/mcp";
const TESTNET_KEY = "test-key-testnet";
const LIVE_KEY = "test-key-live";
const POLICY = "/ipfs/test-policy-uri";
const LOOKUP_BASE = "https://api.example.com";
const KLEROS_CFG: KlerosConfig = {
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
const CREATE_TX: Hex = keccak256(stringToBytes("test: the dispute_create transaction"));
const SUBMIT_TX: Hex = keccak256(stringToBytes("test: the evidence_submit transaction"));
const ATTACHMENT_CID = "bafytestattachment";

beforeEach(() => resetSenderNonces());
afterEach(() => {
  vi.restoreAllMocks();
});

function setup(
  o: { omitSubmittedLog?: boolean; skewJobSubmittedLog?: { deliverable?: Hex } } = {},
) {
  let clock = NOW;
  const node = usdcJobNode({
    usdc: USDC,
    jobContract: JOB_CONTRACT,
    budget: BUDGET,
    now: () => clock,
    // The deployed contract's submit: the job moves to Submitted and the receipt carries the
    // JobSubmitted log the filing reads its deliverable from.
    runSubmit: true,
    omitSubmittedLog: o.omitSubmittedLog,
    skewJobSubmittedLog: o.skewJobSubmittedLog,
    answerTransactions: true,
    identityRegistry: REGISTRY,
    ownerOf: (id) => ({ [BUYER_AGENT]: BUYER, [SELLER_AGENT]: SELLER })[id.toString()],
  });
  node.mint(BUYER, 10_000_000n);
  const db = openDatabase(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const docDir = mkdtempSync(join(tmpdir(), "pilot-dispute-"));
  const docStore = new FileDocumentStore(docDir);
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
  const answers: Record<string, ByAgentAnswer | Error> = {
    [BUYER_AGENT]: fixtureAnswer("buyer"),
    [SELLER_AGENT]: fixtureAnswer("seller"),
  };
  const lookups: string[] = [];
  const lookup: LookupClient = {
    byAgent: async (id) => {
      lookups.push(id);
      const a = answers[id];
      if (a === undefined) throw new Error(`no answer scripted for ${id}`);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  const sleeps: number[] = [];
  const deps = (stage: KlerosStage, over: Partial<FileDisputeDeps> = {}): FileDisputeDeps => ({
    chain,
    cases,
    docStore,
    lookup,
    stage,
    klerosCfg: KLEROS_CFG,
    arcNetwork: "testnet",
    lookupBase: LOOKUP_BASE,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  });
  /** A job created, funded and submitted by the pilot job step, then contested. */
  const contested = async (mode: PilotMode = "rehearsal"): Promise<PilotCaseRecord> => {
    const row = await createPilotJob(
      {
        chain,
        cases,
        docStore,
        lookup,
        agentIds: { buyer: BUYER_AGENT, seller: SELLER_AGENT },
        now: () => clock,
        maxBudgetAtomic: 2_000_000n,
      },
      {
        label: "TEST-1",
        description: fixtureText("test-case-1-description.txt"),
        deliverable: { bytes: CSV, extension: "csv" },
        budgetAtomic: BUDGET,
        expirySeconds: 7 * 86_400,
        mode,
      },
    );
    clock += 600;
    const next = cases.advance(row.caseId, "submitted", "contested", {
      contestReason: fixtureText("test-case-1-reason.txt"),
      contestReply: fixtureText("test-case-1-reply.txt"),
      contestedAt: clock,
    });
    if (!next) throw new Error("the test case did not reach contested");
    return next;
  };
  return {
    node,
    cases,
    docStore,
    docDir,
    chain,
    answers,
    lookups,
    sleeps,
    deps,
    contested,
    clock: () => clock,
    setClock: (t: number) => {
      clock = t;
    },
  };
}
type Harness = ReturnType<typeof setup>;

// --- the stages ---

function rehearsal(
  script: FakeScript = "pay",
  o: Partial<FakeDisputeServiceOptions> = {},
): { stage: KlerosStage; kleros: FakeDisputeService } {
  const kleros = new FakeDisputeService({ script, ...o });
  return {
    stage: { mode: "rehearsal", service: kleros, deployment: null, cap: null, flag: null },
    kleros,
  };
}

/** A rehearsal stage over a fake whose create is replaced: the shapes the fake has no script for. */
function rehearsalWithCreate(create: (n: number) => Promise<CreateOutcome>) {
  let n = 0;
  class Scripted extends FakeDisputeService {
    override async createDispute(p: { aliases: Record<string, Address> }): Promise<CreateOutcome> {
      await super.createDispute(p);
      return create(++n);
    }
  }
  const kleros = new Scripted({ script: "pay" });
  const stage: KlerosStage = {
    mode: "rehearsal",
    service: kleros,
    deployment: null,
    cap: null,
    flag: null,
  };
  return { stage, kleros };
}

interface Seen {
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
  authorization: string | null;
}
type Answer = (args: Record<string, unknown>, n: number) => Response | unknown;

const frame = (id: unknown, result: unknown) =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const toolResult = (payload: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});
const refusal = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const httpStatus = (code: number) =>
  new Response(JSON.stringify({ error: `status ${code}` }), {
    status: code,
    headers: { "content-type": "application/json" },
  });
const INSTRUCTIONS: Record<KlerosDeploymentName, string> = {
  testnet: "This key files on arbitrum-sepolia-testnet, court 8, 5 jurors; the preset broadcasts.",
  live: "This key files on arbitrum-one, court 34, 5 jurors; the preset broadcasts.",
};
const COURT_TIMES: Record<KlerosDeploymentName, string[]> = {
  testnet: ["900", "2700", "1800", "2700"],
  live: ["600", "2700", "1800", "129600"],
};

/** The service over a recording fetch: every read and write answered, any tool overridable. */
function http(
  mode: KlerosDeploymentName,
  o: {
    instructions?: string;
    answers?: Partial<Record<string, Answer>>;
    every?: (s: Seen) => Response | undefined;
    courtId?: number;
    cap?: number;
  } = {},
) {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchStub = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: unknown;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const tool = body.method === "tools/call" ? body.params?.name : undefined;
    const args = body.params?.arguments ?? {};
    const s: Seen = {
      method: body.method,
      tool,
      args: body.params?.arguments,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    seen.push(s);
    const forced = o.every?.(s);
    if (forced) return forced;
    if (body.method === "initialize")
      return frame(body.id, {
        protocolVersion: "2025-06-18",
        instructions: o.instructions ?? INSTRUCTIONS[mode],
      });
    if (body.method === "tools/list")
      return frame(body.id, {
        tools: [
          "dispute_create",
          "evidence_pin",
          "evidence_submit",
          "dispute_get",
          "court_get",
        ].map((name) => ({ name })),
      });
    const name = tool ?? "";
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    const custom = o.answers?.[name];
    const answer = custom
      ? custom(args, n)
      : name === "court_get"
        ? toolResult({ id: args.id, timesPerPeriod: COURT_TIMES[mode], hiddenVotes: true })
        : name === "evidence_pin"
          ? toolResult({
              status: "published",
              fileURI: `/ipfs/${ATTACHMENT_CID}`,
              cid: ATTACHMENT_CID,
            })
          : name === "dispute_create"
            ? toolResult({
                status: "mined",
                coreDisputeID: "186",
                localDisputeID: "42",
                txHash: CREATE_TX,
              })
            : name === "evidence_submit"
              ? toolResult({ status: "mined", txHash: SUBMIT_TX })
              : undefined;
    if (answer === undefined) throw new Error(`no answer for ${body.method} ${name}`);
    return answer instanceof Response ? answer : frame(body.id, answer);
  };
  let ms = 1_790_000_000_000;
  const service = new HttpDisputeService({
    apiUrl: API_URL,
    apiKey: mode === "testnet" ? TESTNET_KEY : LIVE_KEY,
    deployment: mode,
    fetch: fetchStub as typeof fetch,
    now: () => ms,
    sleep: async (d) => {
      ms += d;
    },
  });
  const stage: KlerosStage = {
    mode,
    service,
    deployment: deploymentFor(mode, o.courtId),
    cap: o.cap ?? (mode === "testnet" ? 10 : 5),
    flag: mode === "testnet" ? "--testnet" : "--live",
  };
  return { stage, seen };
}

const WRITE_TOOLS = ["evidence_pin", "dispute_create", "evidence_submit"];
const writesOf = (seen: Seen[]) => seen.filter((s) => WRITE_TOOLS.includes(s.tool ?? ""));
const fakeWrites = (k: FakeDisputeService) => k.calls.filter((c) => WRITE_TOOLS.includes(c.tool));

/** The case's trail from the pre-flight on: step, status and reference. */
function trail(h: Harness, caseId: string): [string, string, string | null][] {
  const events = h.cases.events(caseId);
  const from = events.findIndex((e) => e.step === "evidence");
  return events.slice(from === -1 ? events.length : from).map((e) => [e.step, e.status, e.ref]);
}

/** A row of `mode` at `status` that holds no job, for the cap and gate counts. */
function insertRow(h: Harness, mode: PilotMode, status: PilotStatus): PilotCaseRecord {
  const caseId = newCaseId();
  h.cases.insert({
    caseId,
    label: `other ${caseId}`,
    mode,
    chainId: fakeChain.id,
    jobContract: JOB_CONTRACT,
    buyerAddress: BUYER,
    buyerAgentId: BUYER_AGENT,
    sellerAddress: SELLER,
    sellerAgentId: SELLER_AGENT,
    refereeAddress: REFEREE,
    budgetAtomic: BUDGET.toString(),
    description: "another case",
    expiredAt: NOW + 7 * 86_400,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
  });
  return h.cases.advance(caseId, "created", status) as PilotCaseRecord;
}

/** A testnet case filed and recorded as looked at in the Court interface: the live gate's key. */
function seenTestnetCase(h: Harness): void {
  const row = insertRow(h, "testnet", "filed");
  h.cases.recordEvent(
    row.caseId,
    "seen_in_court",
    "ok",
    "https://court.example/1",
    "by an operator",
  );
}

const notSent = (o: unknown) => (o as { outcome: string }).outcome === "not_sent";
const textOf = (o: unknown) => (o as { text: string }).text;

// --- a rehearsal, script by script ---

describe("a rehearsal: the fake, script by script", () => {
  test.each(["pay", "refund", "tie", "refuse", "stalled"] as const)(
    "%s: pinned, created and submitted; the row is filed on chain fake with every id and hash",
    async (script) => {
      const h = setup();
      const row = await h.contested();
      const { stage, kleros } = rehearsal(script);
      const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });

      expect(out).toEqual({
        outcome: "filed",
        coreDisputeId: "1000",
        localDisputeId: "1000",
        evidenceStatus: "mined",
      });
      const done = h.cases.find(row.caseId)!;
      expect(done.status).toBe("filed");
      expect([done.klerosChain, done.klerosCourtId, done.klerosPolicyUri]).toEqual([
        "fake",
        null,
        POLICY,
      ]);
      expect([done.coreDisputeId, done.localDisputeId]).toEqual(["1000", "1000"]);
      expect(done.createDisputeTx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(done.evidenceTx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(done.evidenceTx).not.toBe(done.createDisputeTx);
      expect(done.evidenceStatus).toBe("mined");
      expect(done.attachmentUri).toBe(`/ipfs/${done.attachmentCid}`);
      expect(done.attachmentCid).toMatch(/^fake-/);
      expect([done.filingStartedAt, done.filedAt]).toEqual([h.clock(), h.clock()]);

      expect(kleros.calls.map((c) => c.tool)).toEqual([
        "tools/list",
        "initialize",
        "court_get",
        "evidence_pin",
        "dispute_create",
        "evidence_submit",
      ]);
      expect(kleros.calls[3]?.args).toEqual({ extension: "csv", byteLength: CSV.byteLength });
      expect(kleros.calls[4]?.args).toEqual({ aliases: { client: BUYER, provider: SELLER } });
      expect(kleros.calls[5]?.args).toEqual({
        coreDisputeId: "1000",
        name: "Job TEST-1: the complete record (test data)",
        description: h.docStore.get(done.evidencePath!),
        fileUri: done.attachmentUri,
        fileTypeExtension: "csv",
      });
      expect(trail(h, row.caseId)).toEqual([
        ["evidence", "stored", done.evidenceSha256],
        ["filing", "started", "fake"],
        ["pin", "published", done.attachmentUri],
        ["create", "sending", null],
        ["create", "mined", done.createDisputeTx],
        ["submit", "mined", done.evidenceTx],
      ]);
      expect(h.sleeps).toEqual([]);
    },
  );

  test("unknown-create: the row freezes at filing_unknown with the hash, and nothing is submitted", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal("unknown-create");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });

    expect(out.outcome).toBe("filing_unknown");
    const txHash = (out as { txHash?: Hex }).txHash;
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const done = h.cases.find(row.caseId)!;
    expect(done.status).toBe("filing_unknown");
    expect(done.createDisputeTx).toBe(txHash);
    expect(done.coreDisputeId).toBeNull();
    expect(done.error).toContain("must not be filed again");
    expect(kleros.calls.map((c) => c.tool)).not.toContain("evidence_submit");
    expect(trail(h, row.caseId).at(-1)).toEqual(["create", "unknown", txHash]);
  });

  test("unknown-create, then the same command again: zero create calls the second time", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal("unknown-create");
    await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    const before = kleros.calls.length;

    const again = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(again)).toBe(true);
    expect(textOf(again)).toContain("filing_unknown");
    expect(kleros.calls).toHaveLength(before);
    expect(kleros.calls.filter((c) => c.tool === "dispute_create")).toHaveLength(1);
    expect(h.cases.find(row.caseId)?.status).toBe("filing_unknown");
  });

  test("unknown-submit: the dispute is filed and its evidence in doubt; the row is evidence_unknown", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage } = rehearsal("unknown-submit");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });

    expect(out).toEqual({
      outcome: "filed",
      coreDisputeId: "1000",
      localDisputeId: "1000",
      evidenceStatus: "unknown",
    });
    const done = h.cases.find(row.caseId)!;
    expect(done.status).toBe("evidence_unknown");
    expect(done.evidenceStatus).toBe("unknown");
    expect(done.evidenceTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(done.coreDisputeId).toBe("1000");
    expect(trail(h, row.caseId).at(-1)).toEqual(["submit", "unknown", done.evidenceTx]);
  });

  test("write-in-progress-once: one more call at once, with no wait of its own, then filed", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal("write-in-progress-once");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });

    expect(out).toMatchObject({ outcome: "filed", evidenceStatus: "mined" });
    // The HTTP client has already waited the refusal out; the filing calls once more at once.
    expect(h.sleeps).toEqual([]);
    expect(kleros.calls.filter((c) => c.tool === "dispute_create")).toHaveLength(2);
    expect(h.cases.find(row.caseId)?.status).toBe("filed");
    const creates = trail(h, row.caseId).filter(([step]) => step === "create");
    expect(creates.map(([, status]) => status)).toEqual([
      "sending",
      "write_in_progress",
      "sending",
      "mined",
    ]);
  });

  test("a second WRITE_IN_PROGRESS on the submit: evidence_unknown, with no wait", async () => {
    const h = setup();
    const row = await h.contested();
    class Busy extends FakeDisputeService {
      override async submitEvidence(): Promise<SubmitOutcome> {
        throw new KlerosRefusal("evidence_submit", "WRITE_IN_PROGRESS: another write is running");
      }
    }
    const kleros = new Busy({ script: "pay" });
    const stage: KlerosStage = {
      mode: "rehearsal",
      service: kleros,
      deployment: null,
      cap: null,
      flag: null,
    };
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out).toMatchObject({ outcome: "filed", evidenceStatus: "unknown" });
    expect(h.sleeps).toEqual([]);
    const done = h.cases.find(row.caseId)!;
    expect(done.status).toBe("evidence_unknown");
    expect(done.error).toContain("WRITE_IN_PROGRESS");
    const submits = trail(h, row.caseId).filter(([step]) => step === "submit");
    expect(submits.map(([, status]) => status)).toEqual(["write_in_progress", "refused"]);
  });

  test("a second WRITE_IN_PROGRESS is not_sent, and the row is contested again", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsalWithCreate(async () => {
      throw new KlerosRefusal("dispute_create", "WRITE_IN_PROGRESS: another write is running");
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });

    expect(out).toMatchObject({ outcome: "not_sent", code: "WRITE_IN_PROGRESS" });
    expect(h.sleeps).toEqual([]);
    expect(kleros.calls.filter((c) => c.tool === "dispute_create")).toHaveLength(2);
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test.each([
    ["insufficient-balance", "INSUFFICIENT_BALANCE"],
    ["simulated", "PRESET_SIMULATES"],
  ] as const)(
    "%s: not_sent, and the row is contested again with the attachment and the deployment kept",
    async (script, code) => {
      const h = setup();
      const row = await h.contested();
      const { stage, kleros } = rehearsal(script);
      const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });

      expect(out).toMatchObject({ outcome: "not_sent", code });
      const done = h.cases.find(row.caseId)!;
      expect(done.status).toBe("contested");
      expect(done.attachmentUri).toMatch(/^\/ipfs\/fake-/);
      expect(done.attachmentCid).toMatch(/^fake-/);
      // The attempt stays on the row: when it started and on which deployment.
      expect(done.filingStartedAt).toBe(h.clock());
      expect([done.klerosChain, done.klerosCourtId, done.klerosPolicyUri]).toEqual([
        "fake",
        null,
        POLICY,
      ]);
      expect(done.coreDisputeId).toBeNull();
      expect(kleros.calls.map((c) => c.tool)).not.toContain("evidence_submit");
      const last = h.cases.events(row.caseId).at(-1)!;
      expect([last.step, last.status]).toEqual([
        "create",
        script === "simulated" ? "simulated" : "refused",
      ]);
      expect(last.detail).toContain(code);
    },
  );
});

// --- the real client's shape: testnet and live ---

describe("a testnet stage over HTTP", () => {
  test("files on arbitrum-sepolia-testnet in court 8; dispute_create carries only the two aliases", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });

    expect(out).toEqual({
      outcome: "filed",
      coreDisputeId: "186",
      localDisputeId: "42",
      evidenceStatus: "mined",
    });
    const done = h.cases.find(row.caseId)!;
    expect(done.status).toBe("filed");
    expect([done.klerosChain, done.klerosCourtId, done.klerosPolicyUri]).toEqual([
      "arbitrum-sepolia-testnet",
      8,
      POLICY,
    ]);
    expect([done.createDisputeTx, done.evidenceTx]).toEqual([CREATE_TX, SUBMIT_TX]);
    expect([done.attachmentUri, done.attachmentCid]).toEqual([
      `/ipfs/${ATTACHMENT_CID}`,
      ATTACHMENT_CID,
    ]);

    expect(seen.map((s) => s.tool ?? s.method)).toEqual([
      "tools/list",
      "initialize",
      "court_get",
      "evidence_pin",
      "dispute_create",
      "evidence_submit",
    ]);
    expect(seen[2]?.args).toEqual({ chain: "arbitrum-sepolia-testnet", id: "8" });
    const create = seen.filter((s) => s.tool === "dispute_create");
    expect(create).toHaveLength(1);
    expect(create[0]?.args).toEqual({ aliases: { client: BUYER, provider: SELLER } });
    expect(Object.keys(create[0]?.args ?? {})).toEqual(["aliases"]);
    expect(Object.keys((create[0]?.args?.aliases ?? {}) as object)).toEqual(["client", "provider"]);
    const submit = seen.find((s) => s.tool === "evidence_submit");
    expect(submit?.args).toEqual({
      dispute: "186",
      name: done.evidenceName,
      description: h.docStore.get(done.evidencePath!),
      fileUri: `/ipfs/${ATTACHMENT_CID}`,
      fileTypeExtension: "csv",
    });

    const filed = logs.map((l) => JSON.parse(l)).filter((l) => l.opslog === "pilot_case_filed");
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      caseId: row.caseId,
      mode: "testnet",
      klerosChain: "arbitrum-sepolia-testnet",
      coreDisputeId: "186",
    });
  });

  test("the alias slot keys come from config", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet");
    const klerosCfg = { ...KLEROS_CFG, aliasClient: "slot-a", aliasProvider: "slot-b" };
    await fileDispute(h.deps(stage, { klerosCfg }), row.caseId, { confirmedFlag: "--testnet" });
    expect(seen.find((s) => s.tool === "dispute_create")?.args).toEqual({
      aliases: { "slot-a": BUYER, "slot-b": SELLER },
    });
  });

  test("live, after a testnet case was seen in the Court interface: arbitrum-one, court 34", async () => {
    const h = setup();
    seenTestnetCase(h);
    const row = await h.contested("live");
    const { stage, seen } = http("live");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--live" });
    expect(out).toMatchObject({ outcome: "filed", coreDisputeId: "186" });
    const done = h.cases.find(row.caseId)!;
    expect([done.klerosChain, done.klerosCourtId]).toEqual(["arbitrum-one", 34]);
    expect(seen[2]?.args).toEqual({ chain: "arbitrum-one", id: "34" });
    expect(new Set(seen.map((s) => s.authorization))).toEqual(new Set([`Bearer ${LIVE_KEY}`]));
  });
});

// --- the guards: nothing reaches Kleros ---

describe("the stage's flag", () => {
  test.each(["testnet", "live"] as const)(
    "%s without its flag sends nothing and reads nothing",
    async (mode) => {
      const h = setup();
      if (mode === "live") seenTestnetCase(h);
      const row = await h.contested(mode);
      const { stage, seen } = http(mode);
      const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
      expect(notSent(out)).toBe(true);
      expect(textOf(out)).toContain(mode === "testnet" ? "--testnet" : "--live");
      expect(seen).toEqual([]);
      expect(h.cases.find(row.caseId)).toEqual(row);
    },
  );

  test.each([
    ["testnet", "--live"],
    ["live", "--testnet"],
  ] as const)("%s with %s refuses and sends nothing", async (mode, flag) => {
    const h = setup();
    if (mode === "live") seenTestnetCase(h);
    const row = await h.contested(mode);
    const { stage, seen } = http(mode);
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: flag });
    expect(notSent(out)).toBe(true);
    expect(seen).toEqual([]);
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test.each(["--testnet", "--live"] as const)("a rehearsal with %s refuses", async (flag) => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: flag });
    expect(notSent(out)).toBe(true);
    expect(kleros.calls).toEqual([]);
  });
});

describe("a rehearsal never reaches the real service", () => {
  test("a rehearsal stage holding an HttpDisputeService refuses before any call, filing or dry run", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage: real, seen } = http("testnet");
    const stage: KlerosStage = {
      ...real,
      mode: "rehearsal",
      deployment: null,
      cap: null,
      flag: null,
    };

    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("fake");
    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre.ok).toBe(false);
    expect(seen).toEqual([]);
    expect(h.lookups).toEqual([BUYER_AGENT, SELLER_AGENT]); // the job step's own two, no more
    expect(h.cases.find(row.caseId)?.evidencePath).toBeNull();
  });

  test("a testnet stage that holds the fake is refused too: a real deployment's row never gets a fake id", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { kleros } = rehearsal();
    const stage: KlerosStage = {
      mode: "testnet",
      service: kleros,
      deployment: deploymentFor("testnet"),
      cap: 10,
      flag: "--testnet",
    };
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(notSent(out)).toBe(true);
    expect(kleros.calls).toEqual([]);
  });

  test.each([
    ["a deployment", { deployment: deploymentFor("testnet") }],
    ["a cap", { cap: 10 }],
    ["a flag", { flag: "--testnet" }],
  ] as const)(
    "a rehearsal stage holding the fake and %s refuses before any call",
    async (_what, over) => {
      const h = setup();
      const row = await h.contested();
      const { stage, kleros } = rehearsal();
      const out = await fileDispute(h.deps({ ...stage, ...over }), row.caseId, {
        confirmedFlag: null,
      });
      expect(notSent(out)).toBe(true);
      expect(kleros.calls).toEqual([]);
    },
  );

  test("a row of another mode refuses before any call", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("testnet mode");
    expect(kleros.calls).toEqual([]);
  });
});

describe("the caps and the live gate", () => {
  /** Every status the cap counts, spread over the rows. */
  const COUNTED: PilotStatus[] = [
    "filing",
    "filed",
    "ruled",
    "settling",
    "settled",
    "filing_unknown",
    "evidence_unknown",
  ];
  const fill = (h: Harness, mode: PilotMode, n: number) => {
    for (let i = 0; i < n; i++) insertRow(h, mode, COUNTED[i % COUNTED.length]!);
  };

  test("the testnet cap refuses at 10 testnet rows, before any call", async () => {
    const h = setup();
    fill(h, "testnet", 10);
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("cap");
    expect(seen).toEqual([]);
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test("the testnet cap counts testnet rows only: 9 of them and 10 live rows still file", async () => {
    const h = setup();
    fill(h, "testnet", 9);
    fill(h, "live", 10);
    fill(h, "rehearsal", 10);
    const row = await h.contested("testnet");
    const { stage } = http("testnet");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out.outcome).toBe("filed");
  });

  test("the live cap refuses at 5 live rows, before any call", async () => {
    const h = setup();
    seenTestnetCase(h);
    fill(h, "live", 5);
    const row = await h.contested("live");
    const { stage, seen } = http("live");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--live" });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("cap");
    expect(seen).toEqual([]);
  });

  test("the live cap counts live rows only: 4 of them and 10 testnet rows still file", async () => {
    const h = setup();
    seenTestnetCase(h);
    fill(h, "testnet", 10);
    fill(h, "live", 4);
    const row = await h.contested("live");
    const { stage } = http("live");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--live" });
    expect(out.outcome).toBe("filed");
  });

  test("two filings at once, one under the cap: one is filed, the other refused by the cap read in the move", async () => {
    const h = setup();
    const a = await h.contested("testnet");
    const b = await h.contested("testnet");
    // Both pre-flights pass the cap before either moves: their lookups wait until both are asked.
    let asked = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup: LookupClient = {
      byAgent: async (id) => {
        if (++asked === 2) release();
        await gate;
        return id === BUYER_AGENT ? fixtureAnswer("buyer") : fixtureAnswer("seller");
      },
    };
    const { stage, seen } = http("testnet", { cap: 1 });
    const outs = await Promise.all(
      [a, b].map((r) =>
        fileDispute(h.deps(stage, { lookup }), r.caseId, { confirmedFlag: "--testnet" }),
      ),
    );
    expect(outs.map((o) => o.outcome).sort()).toEqual(["filed", "not_sent"]);
    expect(textOf(outs.find(notSent))).toContain("cap");
    expect(seen.filter((s) => s.tool === "dispute_create")).toHaveLength(1);
  });

  test("live with no testnet case seen in the Court interface refuses with zero calls", async () => {
    const h = setup();
    // A filed testnet case nobody recorded as seen, and a rehearsal case with the event: neither
    // opens the gate.
    insertRow(h, "testnet", "filed");
    const rehearsed = insertRow(h, "rehearsal", "filed");
    h.cases.recordEvent(rehearsed.caseId, "seen_in_court", "ok", null, null);
    const row = await h.contested("live");
    const { stage, seen } = http("live");

    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--live" });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("file and look at a testnet case first");
    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre).toEqual({
      ok: false,
      problem: expect.stringContaining("file and look at a testnet case first"),
    });
    expect(seen).toEqual([]);
  });
});

describe("the pre-flight refuses, and writes nothing", () => {
  /** Nothing of the filing was written: no evidence on the row or in the store, no Kleros write. */
  function expectNothingWritten(h: Harness, row: PilotCaseRecord, writes: unknown[]): void {
    const now = h.cases.find(row.caseId)!;
    expect(now.status).toBe("contested");
    expect([now.evidencePath, now.buyerRecordPath, now.sellerRecordPath]).toEqual([
      null,
      null,
      null,
    ]);
    expect(
      readdirSync(h.docDir).filter((f) => f.includes("evidence") || f.includes("record")),
    ).toEqual([]);
    expect(writes).toEqual([]);
  }

  test("an evidence period under 300 s", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal("pay", {
      court: { timesPerPeriod: [299, 2700, 1800, 2700] },
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("299 s");
    expectNothingWritten(h, row, fakeWrites(kleros));
  });

  test("an instructions string naming arbitrum-one under a testnet stage", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet", {
      instructions: "This key files on arbitrum-one, court 34.",
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("arbitrum-one");
    expectNothingWritten(h, row, writesOf(seen));
  });

  test("the escrow not Submitted", async () => {
    const h = setup();
    const row = await h.contested();
    h.node.chainJob(BigInt(row.jobId!))!.status = 1; // Funded
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("Submitted");
    expectNothingWritten(h, row, kleros.calls);
  });

  test.each([
    ["client", "the buyer"],
    ["evaluator", "the referee"],
    ["provider", "the seller"],
  ] as const)("a job whose %s is not %s", async (field, _who) => {
    const h = setup();
    const row = await h.contested();
    h.node.chainJob(BigInt(row.jobId!))![field] = "0x1111111111111111111111111111111111111111";
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain(field);
    expectNothingWritten(h, row, kleros.calls);
  });

  test.each(["budget", "expiry"] as const)(
    "a job whose %s on chain is not the row's, which the evidence prints",
    async (what) => {
      const h = setup();
      const row = await h.contested();
      const job = h.node.chainJob(BigInt(row.jobId!))!;
      if (what === "budget") job.budget = BUDGET + 1n;
      else job.expiredAt = job.expiredAt + 1n;
      const { stage, kleros } = rehearsal();
      const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
      expect(notSent(out)).toBe(true);
      expect(textOf(out)).toContain(what === "budget" ? "budget" : "expires at");
      expectNothingWritten(h, row, kleros.calls);
    },
  );

  test("under two hours to the job's expiry; exactly two hours passes", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal();
    h.setClock(row.expiredAt - 7_199);
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("expires");
    expectNothingWritten(h, row, kleros.calls);

    h.setClock(row.expiredAt - 7_200);
    expect((await preflightDispute(h.deps(stage), row.caseId, {})).ok).toBe(true);
  });

  test("a record pending refuses; allowStanding pending passes with the standing in the text", async () => {
    const h = setup();
    const row = await h.contested();
    const pending = fixtureAnswer("seller") as Extract<ByAgentAnswer, { publicId: string }>;
    h.answers[SELLER_AGENT] = {
      ...pending,
      standing: "pending",
      statement: {
        ...pending.statement,
        message: { ...pending.statement.message, standing: "pending" },
      } as SignedStatementJson,
    };
    const { stage, kleros } = rehearsal();
    const refused = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(refused).toEqual({ ok: false, problem: expect.stringContaining("record_not_active") });
    expectNothingWritten(h, row, fakeWrites(kleros));

    const passed = await preflightDispute(h.deps(stage), row.caseId, { allowStanding: "pending" });
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expect(passed.evidence.description).toContain(
      '- Provider agent: "Novi Pilot Test Seller DAO LLC" (test entity), a Wyoming DAO LLC, standing pending,',
    );
  });

  test("a lookup that fails", async () => {
    const h = setup();
    const row = await h.contested();
    h.answers[BUYER_AGENT] = new Error("the legal-body lookup for agent 1001 answered 503");
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("buyer");
    expectNothingWritten(h, row, kleros.calls);
  });
});

describe("the delivered file, read back and checked twice", () => {
  test("the row's absolute path and the store's flat id both find the file", async () => {
    const h = setup();
    const row = await h.contested();
    expect(row.deliverablePath).toMatch(/^\//);
    const { stage } = rehearsal();
    expect((await preflightDispute(h.deps(stage), row.caseId, {})).ok).toBe(true);
    h.cases.patch(row.caseId, { deliverablePath: basename(row.deliverablePath!) });
    expect((await preflightDispute(h.deps(stage), row.caseId, {})).ok).toBe(true);
  });

  test("a submit receipt with no JobSubmitted log refuses", async () => {
    const h = setup({ omitSubmittedLog: true });
    const row = await h.contested();
    const { stage, kleros } = rehearsal();
    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre).toEqual({
      ok: false,
      problem: expect.stringContaining("the submit receipt carries no JobSubmitted log"),
    });
    expect(kleros.calls).toEqual([]);
  });

  test("a submit receipt that says reverted refuses", async () => {
    const h = setup();
    const row = await h.contested();
    const client = h.chain.publicClient;
    const real = client.getTransactionReceipt.bind(client);
    vi.spyOn(client, "getTransactionReceipt").mockImplementation((async (
      a: Parameters<typeof real>[0],
    ) => ({ ...(await real(a)), status: "reverted" })) as never);
    const { stage, kleros } = rehearsal();
    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre).toEqual({ ok: false, problem: expect.stringContaining("reverted") });
    expect(kleros.calls).toEqual([]);
  });

  test("a JobSubmitted deliverable that is not the stored file's hash refuses", async () => {
    const other = keccak256(stringToBytes("another file"));
    const h = setup({ skewJobSubmittedLog: { deliverable: other } });
    const row = await h.contested();
    const { stage } = rehearsal();
    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre).toEqual({ ok: false, problem: expect.stringContaining("JobSubmitted") });
    expect(h.cases.find(row.caseId)?.evidencePath).toBeNull();
  });

  test.each([
    [
      "a row with no submit transaction",
      (h: Harness, r: PilotCaseRecord) => h.cases.patch(r.caseId, { submitTxHash: null }),
      "submit transaction",
    ],
    [
      "a deliverable name that is not a pilot file",
      (h: Harness, r: PilotCaseRecord) =>
        h.cases.patch(r.caseId, { deliverablePath: "/etc/hosts" }),
      "pilot",
    ],
    [
      "a deliverable missing from the store",
      (h: Harness, r: PilotCaseRecord) => rmSync(r.deliverablePath!),
      "cannot be read",
    ],
    [
      "a stored file whose bytes changed",
      (_h: Harness, r: PilotCaseRecord) => writeFileSync(r.deliverablePath!, "date,amount\n"),
      "hashes to",
    ],
    [
      "a row whose deliverable hash is another file's",
      (h: Harness, r: PilotCaseRecord) =>
        h.cases.patch(r.caseId, { deliverableHash: keccak256(stringToBytes("x")) }),
      "deliverable hash",
    ],
  ] as const)("%s refuses, with no write", async (_what, spoil, says) => {
    const h = setup();
    const row = await h.contested();
    spoil(h, row);
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain(says);
    expect(kleros.calls).toEqual([]);
    const now = h.cases.find(row.caseId)!;
    expect([now.status, now.evidencePath]).toEqual(["contested", null]);
  });
});

describe("what the pre-flight stores, and what the filing serves", () => {
  test("the evidence and both records, by their flat ids, in one patch; the dry run writes nothing to Kleros", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal();
    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;

    const stored = h.cases.find(row.caseId)!;
    expect(stored.status).toBe("contested");
    expect(stored.evidencePath).toBe(`pilot-${row.caseId}-evidence.txt`);
    expect(stored.buyerRecordPath).toBe(`pilot-${row.caseId}-buyer-record.json`);
    expect(stored.sellerRecordPath).toBe(`pilot-${row.caseId}-seller-record.json`);
    expect(stored.evidenceName).toBe(pre.evidence.name);
    expect(stored.evidenceSha256).toBe(pre.evidence.sha256);
    const evidenceBytes = h.docStore.getBytes(stored.evidencePath!);
    expect(evidenceBytes.toString("utf8")).toBe(pre.evidence.description);
    expect(sha256(new Uint8Array(evidenceBytes))).toBe(stored.evidenceSha256);
    // Each record is the lookup's answer exactly as it was returned.
    expect(h.docStore.get(stored.buyerRecordPath!)).toBe(JSON.stringify(fixtureAnswer("buyer")));
    expect(h.docStore.get(stored.sellerRecordPath!)).toBe(JSON.stringify(fixtureAnswer("seller")));
    expect(pre.records).toEqual({ buyer: fixtureAnswer("buyer"), seller: fixtureAnswer("seller") });

    expect(pre.instructions).toBe(await new FakeDisputeService({ script: "pay" }).instructions());
    expect(pre.court.timesPerPeriod).toEqual([900, 2700, 1800, 2700]);
    expect(pre.escrow.status).toBe(2);
    expect(pre.escrow.expiredAt).toBe(BigInt(row.expiredAt));
    expect([pre.filedCount, pre.cap]).toEqual([0, null]);
    expect(pre.evidence.description).toContain("**TEST DATA.**");
    expect(pre.evidence.description).toContain(new TextDecoder().decode(CSV));
    expect(pre.evidence.description).toContain(`Job id: ${row.jobId}.`);
    expect(fakeWrites(kleros)).toEqual([]);
    const evidence = h.cases.events(row.caseId).filter((e) => e.step === "evidence");
    expect(evidence.map((e) => [e.status, e.ref])).toEqual([["stored", pre.evidence.sha256]]);
  });

  test("the evidence bytes served from the document store equal the submitted description", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal();
    await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    const done = h.cases.find(row.caseId)!;
    const submit = kleros.calls.find((c) => c.tool === "evidence_submit")?.args as {
      name: string;
      description: string;
    };
    expect(h.docStore.get(done.evidencePath!)).toBe(submit.description);
    expect(sha256(stringToBytes(submit.description))).toBe(done.evidenceSha256);
    expect(submit.name).toBe(done.evidenceName);
  });

  test("a later pre-flight stores the records as read then", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage } = rehearsal();
    await preflightDispute(h.deps(stage), row.caseId, {});
    const later = {
      ...fixtureAnswer("buyer"),
      checkedAt: "2026-10-25T11:00:00.000Z",
    } as ByAgentAnswer;
    h.answers[BUYER_AGENT] = later;
    await preflightDispute(h.deps(stage), row.caseId, {});
    const stored = h.cases.find(row.caseId)!;
    expect(h.docStore.get(stored.buyerRecordPath!)).toBe(JSON.stringify(later));
    expect(h.docStore.get(stored.evidencePath!)).toContain(
      "snapshots taken when the case was created, 25 October 2026 and 22 October 2026",
    );
  });
});

describe("the stored evidence is the evidence filed", () => {
  test("a dry run whose reads straddle a filing stores nothing: the files stay the ones filed", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const later = {
      ...fixtureAnswer("buyer"),
      checkedAt: "2026-10-25T11:00:00.000Z",
    } as ByAgentAnswer;
    const held: LookupClient = {
      byAgent: async (id) => {
        await gate;
        return id === BUYER_AGENT ? later : fixtureAnswer("seller");
      },
    };
    // The dry run reads the row at contested, then waits on its lookups while the case is filed.
    const dry = preflightDispute(h.deps(stage, { lookup: held }), row.caseId, {});
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out.outcome).toBe("filed");
    release();
    expect(await dry).toEqual({ ok: false, problem: expect.stringContaining("moved") });

    const done = h.cases.find(row.caseId)!;
    const submitted = kleros.calls.find((c) => c.tool === "evidence_submit")?.args as {
      description: string;
    };
    const stored = h.docStore.get(done.evidencePath!);
    expect(stored).toBe(submitted.description);
    expect(sha256(stringToBytes(stored))).toBe(done.evidenceSha256);
    expect(h.docStore.get(done.buyerRecordPath!)).toBe(JSON.stringify(fixtureAnswer("buyer")));
  });

  test("a filing whose stored evidence changed after its pre-flight sends nothing", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal();
    // Another command stores its own evidence between this filing's pre-flight and its move.
    let storedOnce = false;
    const cases = new Proxy(h.cases, {
      get(target, prop, receiver) {
        if (prop === "recordEvent")
          return (...a: Parameters<typeof target.recordEvent>) => {
            if (a[1] === "evidence" && a[2] === "stored") storedOnce = true;
            target.recordEvent(...a);
          };
        if (prop === "transaction")
          return <T>(fn: () => T): T => {
            if (storedOnce) {
              storedOnce = false;
              target.patch(row.caseId, { evidenceSha256: `0x${"ee".repeat(32)}` });
            }
            return target.transaction(fn);
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = await fileDispute(h.deps(stage, { cases }), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("the stored evidence changed");
    expect(fakeWrites(kleros)).toEqual([]);
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test("a store that fails: not_sent naming the file and not its path, nothing on the row, no write", async () => {
    const h = setup();
    const row = await h.contested();
    // The shape the file system throws: the message and the error carry the absolute path.
    const name = `pilot-${row.caseId}-evidence.txt.tmp-4242-1`;
    const path = join(h.docDir, name);
    const docStore = new Proxy(h.docStore, {
      get(target, prop, receiver) {
        if (prop === "put")
          return () => {
            throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
              errno: -13,
              code: "EACCES",
              syscall: "open",
              path,
            });
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage, { docStore }), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("could not be stored");
    expect(textOf(out)).toContain(`EACCES: permission denied, open '${name}'`);
    expect(textOf(out)).not.toContain(h.docDir);
    expect(textOf(out)).not.toContain(tmpdir());
    const now = h.cases.find(row.caseId)!;
    expect([now.status, now.evidencePath]).toEqual(["contested", null]);
    expect(fakeWrites(kleros)).toEqual([]);
  });
});

describe("the move to filing, and the mark before the create", () => {
  /** The repository, with `before` run once just before the move to filing. */
  function beforeMove(h: Harness, before: () => void) {
    let stored = false;
    return new Proxy(h.cases, {
      get(target, prop, receiver) {
        if (prop === "recordEvent")
          return (...a: Parameters<typeof target.recordEvent>) => {
            if (a[1] === "evidence" && a[2] === "stored") stored = true;
            target.recordEvent(...a);
          };
        if (prop === "transaction")
          return <T>(fn: () => T): T => {
            if (stored) {
              stored = false;
              before();
            }
            return target.transaction(fn);
          };
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  test.each(["evidence.txt", "buyer-record.json", "seller-record.json"])(
    "a stored %s that changed with the same evidence sha256 sends nothing",
    async (file) => {
      const h = setup();
      const row = await h.contested();
      const cases = beforeMove(h, () => h.docStore.put(`pilot-${row.caseId}-${file}`, "{}"));
      const { stage, kleros } = rehearsal();
      const out = await fileDispute(h.deps(stage, { cases }), row.caseId, { confirmedFlag: null });
      expect(notSent(out)).toBe(true);
      expect(textOf(out)).toContain("the stored evidence changed");
      expect(fakeWrites(kleros)).toEqual([]);
      expect(h.cases.find(row.caseId)?.status).toBe("contested");
    },
  );

  test("a move to filing that fails is not_sent, with no write", async () => {
    const h = setup();
    const row = await h.contested();
    const cases = new Proxy(h.cases, {
      get(target, prop, receiver) {
        if (prop === "advance")
          return (...a: Parameters<typeof target.advance>) => {
            if (a[1] === "contested" && a[2] === "filing")
              throw new Error("SQLITE_BUSY: database is locked");
            return target.advance(...a);
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage, { cases }), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("could not be moved to filing");
    expect(fakeWrites(kleros)).toEqual([]);
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test("the create is marked as sending in the trail before its request leaves", async () => {
    const h = setup();
    const row = await h.contested();
    const marked: boolean[] = [];
    class Watching extends FakeDisputeService {
      override async createDispute(p: {
        aliases: Record<string, Address>;
      }): Promise<CreateOutcome> {
        const trailNow = h.cases.events(row.caseId);
        marked.push(trailNow.at(-1)?.step === "create" && trailNow.at(-1)?.status === "sending");
        return super.createDispute(p);
      }
    }
    const kleros = new Watching({ script: "pay" });
    const stage: KlerosStage = {
      mode: "rehearsal",
      service: kleros,
      deployment: null,
      cap: null,
      flag: null,
    };
    await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(marked).toEqual([true]);
  });

  test("a mined create writes an ops line with its ids before the row write, so they survive its failure", async () => {
    const h = setup();
    const row = await h.contested();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
    const cases = new Proxy(h.cases, {
      get(target, prop, receiver) {
        if (prop === "patch")
          return (...a: Parameters<typeof target.patch>) => {
            if (a[1].coreDisputeId !== undefined) throw new Error("SQLITE_IOERR: disk I/O error");
            return target.patch(...a);
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const { stage, kleros } = rehearsal();
    await expect(
      fileDispute(h.deps(stage, { cases }), row.caseId, { confirmedFlag: null }),
    ).rejects.toThrow("SQLITE_IOERR");
    expect(kleros.calls.map((c) => c.tool)).toContain("dispute_create");
    const created = lines
      .map((l) => JSON.parse(l))
      .filter((l) => l.opslog === "pilot_dispute_created");
    expect(created).toEqual([
      expect.objectContaining({
        caseId: row.caseId,
        coreDisputeId: "1000",
        localDisputeId: "1000",
        txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      }),
    ]);
    // The row is left at filing with its create marked as sent: a later command freezes it.
    expect(h.cases.find(row.caseId)?.status).toBe("filing");
  });

  test("a command that saw the row at filing refuses a row that is anything else, with no call", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, {
      confirmedFlag: null,
      onlyAtFiling: true,
    });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("moved from filing");
    expect(kleros.calls).toEqual([]);
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });
});

describe("a filing that stopped part way", () => {
  /** The row as a command leaves it at `filing`, `startedAgo` seconds ago. */
  function atFiling(
    h: Harness,
    row: PilotCaseRecord,
    o: { startedAgo: number; createSent?: boolean; ids?: boolean },
  ): void {
    h.cases.advance(row.caseId, "contested", "filing", {
      filingStartedAt: h.clock() - o.startedAgo,
      klerosChain: "fake",
      klerosPolicyUri: POLICY,
      ...(o.ids ? { coreDisputeId: "77", localDisputeId: "78", createDisputeTx: CREATE_TX } : {}),
    });
    h.cases.recordEvent(row.caseId, "filing", "started", "fake", null);
    if (o.createSent) h.cases.recordEvent(row.caseId, "create", "sending", null, null);
  }

  test("under 30 minutes old, a filing is in progress: wait, with no move and no call", async () => {
    const h = setup();
    const row = await h.contested();
    atFiling(h, row, { startedAgo: 1_799, createSent: true });
    const { stage, kleros } = rehearsal();

    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre).toEqual({
      ok: false,
      problem: expect.stringContaining("a filing is in progress: wait"),
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out).toMatchObject({ outcome: "not_sent", code: "filing_in_progress" });
    expect(textOf(out)).toContain("a filing is in progress: wait");
    expect(h.cases.find(row.caseId)?.status).toBe("filing");
    expect(kleros.calls).toEqual([]);
  });

  test("30 minutes old with a create sent and no dispute id: filing_unknown, with zero calls", async () => {
    const h = setup();
    const row = await h.contested();
    atFiling(h, row, { startedAgo: 1_800, createSent: true });
    const { stage, kleros } = rehearsal();

    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre).toEqual({ ok: false, problem: expect.stringContaining("filing_unknown") });
    expect(h.cases.find(row.caseId)?.status).toBe("filing");

    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out.outcome).toBe("filing_unknown");
    expect(textOf(out)).toContain("its create was marked as sent");
    expect(h.cases.find(row.caseId)?.status).toBe("filing_unknown");
    expect(kleros.calls).toEqual([]);
    const last = h.cases.events(row.caseId).at(-1)!;
    expect([last.step, last.status, last.detail]).toEqual([
      "filing",
      "filing_unknown",
      textOf(out),
    ]);
  });

  test("30 minutes old with no create marked as sent: frozen all the same, never sent back, and it says so", async () => {
    const h = setup();
    const row = await h.contested();
    // A create marked on an earlier attempt is not this attempt's: the text reads this one's.
    h.cases.recordEvent(row.caseId, "create", "sending", null, null);
    atFiling(h, row, { startedAgo: 3_600 });
    const { stage, kleros } = rehearsal();

    const pre = await preflightDispute(h.deps(stage), row.caseId, {});
    expect(pre).toEqual({ ok: false, problem: expect.stringContaining("filing_unknown") });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out.outcome).toBe("filing_unknown");
    expect(textOf(out)).toContain("no create was marked as sent");
    expect(textOf(out)).toContain("check Kleros");
    expect(h.cases.find(row.caseId)?.status).toBe("filing_unknown");
    expect(h.cases.events(row.caseId).at(-1)?.detail).toBe(textOf(out));

    const again = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(again)).toBe(true);
    expect(kleros.calls).toEqual([]);
  });

  test("a create transaction on the row counts as a create marked as sent", async () => {
    const h = setup();
    const row = await h.contested();
    atFiling(h, row, { startedAgo: 1_800 });
    h.cases.patch(row.caseId, { createDisputeTx: CREATE_TX });
    const { stage } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out).toMatchObject({ outcome: "filing_unknown", txHash: CREATE_TX });
    expect(textOf(out)).toContain("its create was marked as sent");
  });

  test("a slow command before its create while another sees the row stale: the other freezes it, and no create at all", async () => {
    const h = setup();
    const row = await h.contested();
    // The first command is held in its pin, after its move to filing and before its create.
    let entered!: () => void;
    const inPin = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowPin extends FakeDisputeService {
      override async pin(p: { bytes: Uint8Array; extension: string }): Promise<PinOutcome> {
        entered();
        await gate;
        return super.pin(p);
      }
    }
    const first = new SlowPin({ script: "pay" });
    const firstStage: KlerosStage = {
      mode: "rehearsal",
      service: first,
      deployment: null,
      cap: null,
      flag: null,
    };
    const running = fileDispute(h.deps(firstStage), row.caseId, { confirmedFlag: null });
    await inPin;

    h.setClock(h.clock() + 31 * 60);
    const second = rehearsal();
    const frozen = await fileDispute(h.deps(second.stage), row.caseId, { confirmedFlag: null });
    expect(frozen.outcome).toBe("filing_unknown");
    expect(textOf(frozen)).toContain("no create was marked as sent");
    expect(h.cases.find(row.caseId)?.status).toBe("filing_unknown");

    const third = rehearsal();
    expect(
      notSent(await fileDispute(h.deps(third.stage), row.caseId, { confirmedFlag: null })),
    ).toBe(true);

    release();
    // The slow command finds the row no longer its own before its create: it sends nothing.
    const slow = await running;
    expect(slow).toMatchObject({ outcome: "not_sent", code: "filing_moved" });
    expect(textOf(slow)).toContain("filing_unknown");
    const fourth = rehearsal();
    expect(
      notSent(await fileDispute(h.deps(fourth.stage), row.caseId, { confirmedFlag: null })),
    ).toBe(true);

    const creates = [first, second.kleros, third.kleros, fourth.kleros].flatMap((k) =>
      k.calls.filter((c) => c.tool === "dispute_create"),
    );
    expect(creates).toEqual([]);
    const done = h.cases.find(row.caseId)!;
    // The row is left as the other command froze it: no dispute behind the freeze.
    expect([done.status, done.coreDisputeId, done.createDisputeTx]).toEqual([
      "filing_unknown",
      null,
      null,
    ]);
    expect(done.error).toContain("no create was marked as sent");
    const trailNow = h.cases.events(row.caseId);
    expect(trailNow.filter((e) => e.step === "create" && e.status === "sending")).toEqual([]);
    expect(trailNow.at(-1)).toMatchObject({ step: "create", status: "filing_moved" });
  });

  test("a slow command whose row another command is filing again (a new filing start) sends nothing", async () => {
    const h = setup();
    const row = await h.contested();
    /** A fake held in its pin until released, with a signal once it is there. */
    const heldInPin = () => {
      let entered!: () => void;
      const inPin = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      class SlowPin extends FakeDisputeService {
        override async pin(p: { bytes: Uint8Array; extension: string }): Promise<PinOutcome> {
          entered();
          await gate;
          return super.pin(p);
        }
      }
      const kleros = new SlowPin({ script: "pay" });
      const stage: KlerosStage = {
        mode: "rehearsal",
        service: kleros,
        deployment: null,
        cap: null,
        flag: null,
      };
      return { kleros, stage, inPin, release };
    };
    const first = heldInPin();
    const running = fileDispute(h.deps(first.stage), row.caseId, { confirmedFlag: null });
    await first.inPin;

    // The row goes back to contested by a hand outside this module, and another command starts
    // filing it: the row is at filing again, with the other command's start.
    h.cases.advance(row.caseId, "filing", "contested");
    h.setClock(h.clock() + 60);
    const other = heldInPin();
    const otherRunning = fileDispute(h.deps(other.stage), row.caseId, { confirmedFlag: null });
    await other.inPin;
    const othersFiling = h.cases.find(row.caseId)!;
    expect(othersFiling.status).toBe("filing");

    first.release();
    const slow = await running;
    expect(slow).toMatchObject({ outcome: "not_sent", code: "filing_moved" });
    expect(first.kleros.calls.filter((c) => c.tool === "dispute_create")).toEqual([]);

    other.release();
    expect((await otherRunning).outcome).toBe("filed");
    expect(other.kleros.calls.filter((c) => c.tool === "dispute_create")).toHaveLength(1);
    const done = h.cases.find(row.caseId)!;
    expect([done.status, done.filingStartedAt]).toEqual(["filed", othersFiling.filingStartedAt]);
  });

  test("a slow command whose pin fails after another command re-filed its row leaves that filing untouched", async () => {
    const h = setup();
    const row = await h.contested();
    /** A fake held in its pin until released; `fails` makes the pin refuse once released. */
    const heldInPin = (fails: boolean) => {
      let entered!: () => void;
      const inPin = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      class SlowPin extends FakeDisputeService {
        override async pin(p: { bytes: Uint8Array; extension: string }): Promise<PinOutcome> {
          entered();
          await gate;
          if (fails) throw new KlerosRefusal("evidence_pin", "FILE_TOO_LARGE: over the limit");
          return super.pin(p);
        }
      }
      const kleros = new SlowPin({ script: "pay" });
      const stage: KlerosStage = {
        mode: "rehearsal",
        service: kleros,
        deployment: null,
        cap: null,
        flag: null,
      };
      return { kleros, stage, inPin, release };
    };
    const slow = heldInPin(true);
    const slowRunning = fileDispute(h.deps(slow.stage), row.caseId, { confirmedFlag: null });
    await slow.inPin;

    // An outside hand moves the row back, and another command starts filing it again.
    h.cases.advance(row.caseId, "filing", "contested");
    h.setClock(h.clock() + 60);
    const other = heldInPin(false);
    const otherRunning = fileDispute(h.deps(other.stage), row.caseId, { confirmedFlag: null });
    await other.inPin;
    const othersFiling = h.cases.find(row.caseId)!;

    slow.release();
    const out = await slowRunning;
    expect(out).toMatchObject({ outcome: "not_sent", code: "FILE_TOO_LARGE" });
    expect(textOf(out)).toContain("no longer this command's filing");
    const untouched = h.cases.find(row.caseId)!;
    expect([untouched.status, untouched.filingStartedAt]).toEqual([
      "filing",
      othersFiling.filingStartedAt,
    ]);
    expect(h.cases.events(row.caseId).at(-1)).toMatchObject({
      step: "filing",
      status: "not_its_own",
    });

    // A command now finds the other's filing in progress and waits: it creates nothing.
    const fourth = rehearsal();
    expect(
      await fileDispute(h.deps(fourth.stage), row.caseId, { confirmedFlag: null }),
    ).toMatchObject({
      outcome: "not_sent",
      code: "filing_in_progress",
    });

    other.release();
    expect((await otherRunning).outcome).toBe("filed");
    const creates = [slow.kleros, other.kleros, fourth.kleros].flatMap((k) =>
      k.calls.filter((c) => c.tool === "dispute_create"),
    );
    expect(creates).toHaveLength(1);
    expect(h.cases.find(row.caseId)?.status).toBe("filed");
  });

  test("30 minutes old with a dispute id: filed with its evidence in doubt, an ops line, zero calls", async () => {
    const h = setup();
    const row = await h.contested();
    atFiling(h, row, { startedAgo: 1_800, createSent: true, ids: true });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out).toEqual({
      outcome: "filed",
      coreDisputeId: "77",
      localDisputeId: "78",
      evidenceStatus: "unknown",
    });
    expect(h.cases.find(row.caseId)?.status).toBe("evidence_unknown");
    expect(kleros.calls).toEqual([]);
    const filed = lines.map((l) => JSON.parse(l)).filter((l) => l.opslog === "pilot_case_filed");
    expect(filed).toEqual([expect.objectContaining({ caseId: row.caseId, coreDisputeId: "77" })]);
  });
});

describe("a case filed once is never filed again", () => {
  test.each([
    ["a 401", { evidence_submit: () => httpStatus(401) }],
    ["a network failure", "network"],
  ] as const)(
    "%s on the submit after a mined create: evidence_unknown, then zero creates",
    async (_what, how) => {
      const h = setup();
      const row = await h.contested("testnet");
      const { stage, seen } = http(
        "testnet",
        how === "network"
          ? {
              every: (s) => {
                if (s.tool === "evidence_submit") throw new TypeError("fetch failed");
                return undefined;
              },
            }
          : { answers: how },
      );
      const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
      expect(out).toEqual({
        outcome: "filed",
        coreDisputeId: "186",
        localDisputeId: "42",
        evidenceStatus: "unknown",
      });
      const done = h.cases.find(row.caseId)!;
      expect([done.status, done.coreDisputeId]).toEqual(["evidence_unknown", "186"]);

      const again = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
      expect(notSent(again)).toBe(true);
      expect(seen.filter((s) => s.tool === "dispute_create")).toHaveLength(1);
    },
  );

  test("a raw simulated submit after a mined create: evidence_unknown, never mined, then zero creates", async () => {
    const h = setup();
    const row = await h.contested();
    class Simulating extends FakeDisputeService {
      override async submitEvidence(): Promise<SubmitOutcome> {
        return { status: "simulated" };
      }
    }
    const kleros = new Simulating({ script: "pay" });
    const stage: KlerosStage = {
      mode: "rehearsal",
      service: kleros,
      deployment: null,
      cap: null,
      flag: null,
    };
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out).toMatchObject({ outcome: "filed", evidenceStatus: "unknown" });
    const done = h.cases.find(row.caseId)!;
    expect([done.status, done.evidenceStatus, done.evidenceTx]).toEqual([
      "evidence_unknown",
      "unknown",
      null,
    ]);
    await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(kleros.calls.filter((c) => c.tool === "dispute_create")).toHaveLength(1);
  });

  test.each([
    ["a dispute id", { coreDisputeId: "186" }],
    ["a create transaction", { createDisputeTx: CREATE_TX }],
  ] as const)("a contested row that already holds %s is never filed", async (_what, patch) => {
    const h = setup();
    const row = await h.contested();
    h.cases.patch(row.caseId, patch);
    const { stage, kleros } = rehearsal();
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toContain("never filed again");
    expect(kleros.calls).toEqual([]);
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });
});

describe("filing again after nothing was sent", () => {
  test("after insufficient-balance: the same deployment, the same attachment, filed", async () => {
    const h = setup();
    const row = await h.contested();
    await fileDispute(h.deps(rehearsal("insufficient-balance").stage), row.caseId, {
      confirmedFlag: null,
    });
    const first = h.cases.find(row.caseId)!;
    expect(first.status).toBe("contested");

    const { stage, kleros } = rehearsal("pay");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out.outcome).toBe("filed");
    const done = h.cases.find(row.caseId)!;
    expect([done.klerosChain, done.klerosCourtId, done.klerosPolicyUri]).toEqual([
      first.klerosChain,
      first.klerosCourtId,
      first.klerosPolicyUri,
    ]);
    expect(done.attachmentUri).toBe(first.attachmentUri);
    expect(kleros.calls.map((c) => c.tool)).not.toContain("evidence_pin");
    expect(kleros.calls.find((c) => c.tool === "evidence_submit")?.args).toMatchObject({
      fileUri: first.attachmentUri,
    });
  });

  test("a testnet case started on another court refuses before any call", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage: first } = http("testnet", {
      answers: { dispute_create: () => refusal("INSUFFICIENT_BALANCE: the fee wallet is empty") },
    });
    const out = await fileDispute(h.deps(first), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "not_sent", code: "INSUFFICIENT_BALANCE" });
    expect(h.cases.find(row.caseId)?.klerosCourtId).toBe(8);

    const { stage, seen } = http("testnet", { courtId: 9 });
    const again = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(notSent(again)).toBe(true);
    expect(textOf(again)).toMatch(
      /^this case was started on another deployment: arbitrum-sepolia-testnet/,
    );
    expect(seen).toEqual([]);
  });

  test("a re-filing whose policy URI changed refuses before any call", async () => {
    const h = setup();
    const row = await h.contested();
    await fileDispute(h.deps(rehearsal("insufficient-balance").stage), row.caseId, {
      confirmedFlag: null,
    });
    expect(h.cases.find(row.caseId)?.klerosPolicyUri).toBe(POLICY);
    const { stage, kleros } = rehearsal();
    const klerosCfg = { ...KLEROS_CFG, policyUri: "/ipfs/another-policy-uri" };
    const out = await fileDispute(h.deps(stage, { klerosCfg }), row.caseId, {
      confirmedFlag: null,
    });
    expect(notSent(out)).toBe(true);
    expect(textOf(out)).toMatch(/^this case was started on another deployment: fake/);
    expect(kleros.calls).toEqual([]);
  });

  test("a testnet re-filing on the same deployment files", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage: first } = http("testnet", {
      answers: { dispute_create: () => refusal("INSUFFICIENT_BALANCE: the fee wallet is empty") },
    });
    await fileDispute(h.deps(first), row.caseId, { confirmedFlag: "--testnet" });
    const { stage } = http("testnet");
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out.outcome).toBe("filed");
    expect(h.cases.find(row.caseId)?.klerosChain).toBe("arbitrum-sepolia-testnet");
  });
});

describe("what the service answers on the writes", () => {
  test("a 401 on a read: not_sent unauthorized, before any write", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet", {
      every: (s) => (s.method === "tools/list" ? httpStatus(401) : undefined),
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "not_sent", code: "unauthorized" });
    expect(writesOf(seen)).toEqual([]);
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test("a 401 on dispute_create: not_sent unauthorized, and the row is contested again", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage } = http("testnet", { answers: { dispute_create: () => httpStatus(401) } });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "not_sent", code: "unauthorized" });
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test.each([
    [
      "a refusal that may have sent (FILING_TIMED_OUT)",
      () => refusal("FILING_TIMED_OUT: stopped after three minutes; it may have been sent"),
    ],
    ["a refusal with no code", () => refusal("something went wrong")],
    ["an HTTP 500", () => httpStatus(500)],
    [
      "an HTTP 502 from a proxy, which may come after the request reached the service",
      () => httpStatus(502),
    ],
  ])("%s on dispute_create freezes the row at filing_unknown", async (_what, answer) => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet", { answers: { dispute_create: answer } });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out.outcome).toBe("filing_unknown");
    expect(h.cases.find(row.caseId)?.status).toBe("filing_unknown");
    expect(seen.filter((s) => s.tool === "dispute_create")).toHaveLength(1);
    expect(seen.map((s) => s.tool)).not.toContain("evidence_submit");
  });

  test.each([
    [429, "http_429"],
    [413, "http_413"],
  ] as const)(
    "an HTTP %s on dispute_create was decided before the call ran: not_sent %s, contested again",
    async (code, named) => {
      const h = setup();
      const row = await h.contested("testnet");
      const { stage, seen } = http("testnet", {
        answers: { dispute_create: () => httpStatus(code) },
      });
      const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
      expect(out).toMatchObject({ outcome: "not_sent", code: named });
      expect(textOf(out)).toContain("nothing was sent");
      const done = h.cases.find(row.caseId)!;
      expect([done.status, done.klerosChain]).toEqual(["contested", "arbitrum-sepolia-testnet"]);
      expect(seen.filter((s) => s.tool === "dispute_create")).toHaveLength(1);
    },
  );

  test("an HTTP 429 on the pin: not_sent http_429, nothing created", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet", { answers: { evidence_pin: () => httpStatus(429) } });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "not_sent", code: "http_429" });
    expect(seen.map((s) => s.tool)).not.toContain("dispute_create");
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test("an HTTP 429 on the submit: evidence_unknown, like every submit that is not mined", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage } = http("testnet", { answers: { evidence_submit: () => httpStatus(429) } });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "filed", evidenceStatus: "unknown" });
    expect(h.cases.find(row.caseId)?.status).toBe("evidence_unknown");
  });

  test("a Kleros text keeps its own words: a funds sentence is never rewritten as the platform's", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const text =
      "INSUFFICIENT_BALANCE: insufficient funds in the fee wallet for the arbitration fee";
    const { stage } = http("testnet", { answers: { dispute_create: () => refusal(text) } });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "not_sent", code: "INSUFFICIENT_BALANCE" });
    expect(textOf(out)).toContain(text);
    expect(textOf(out)).not.toContain("platform");
    expect(h.cases.events(row.caseId).at(-1)?.detail).toBe(text);
  });

  test("a mined create the client could not read keeps the service's text past 300 characters, ids included", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage } = http("testnet", {
      answers: {
        dispute_create: () =>
          toolResult({
            note: "n".repeat(600),
            status: "mined",
            coreDisputeID: "186",
            localDisputeID: "42",
            txHash: "not-a-hash",
          }),
      },
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out.outcome).toBe("filing_unknown");
    const done = h.cases.find(row.caseId)!;
    expect(done.status).toBe("filing_unknown");
    expect(done.error).toContain('"coreDisputeID":"186","localDisputeID":"42"');
    const event = h.cases.events(row.caseId).at(-1)!;
    expect([event.step, event.status]).toEqual(["create", "unknown"]);
    expect(event.detail).toContain('"coreDisputeID":"186"');
  });

  test("a Kleros text has its URL paths and labelled credentials redacted", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const text =
      "UNKNOWN: the upstream https://rpc.example.test/v2/path-k3y-0123456789abcdef failed; authorization: Bearer abcdefghijklmnopqrstuvwx";
    const { stage } = http("testnet", { answers: { dispute_create: () => refusal(text) } });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "not_sent", code: "UNKNOWN" });
    const detail = h.cases.events(row.caseId).at(-1)?.detail ?? "";
    for (const shown of [textOf(out), detail]) {
      expect(shown).toContain("https://rpc.example.test");
      expect(shown).not.toContain("path-k3y-0123456789abcdef");
      expect(shown).not.toContain("abcdefghijklmnopqrstuvwx");
    }
  });

  test("a network failure on dispute_create freezes the row at filing_unknown", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage } = http("testnet", {
      every: (s) => {
        if (s.tool === "dispute_create") throw new TypeError("fetch failed");
        return undefined;
      },
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out.outcome).toBe("filing_unknown");
    expect(h.cases.find(row.caseId)?.status).toBe("filing_unknown");
  });

  test("an unknown create carries the service's hash onto the row", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage } = http("testnet", {
      answers: {
        dispute_create: () => ({
          content: [
            {
              type: "text",
              text: `Warning: no receipt in time.\n${JSON.stringify({ status: "unknown", txHash: CREATE_TX })}`,
            },
          ],
        }),
      },
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "filing_unknown", txHash: CREATE_TX });
    expect(h.cases.find(row.caseId)?.createDisputeTx).toBe(CREATE_TX);
  });

  test("a create the fake answers without a script's words: a raw simulated is a nothing-sent refusal", async () => {
    const h = setup();
    const row = await h.contested();
    const { stage } = rehearsalWithCreate(async () => ({ status: "simulated" }));
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: null });
    expect(out).toMatchObject({ outcome: "not_sent", code: "PRESET_SIMULATES" });
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });

  test("a nothing-sent refusal of evidence_submit is not retried: evidence_unknown with the code", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet", {
      answers: {
        evidence_submit: () => refusal("NAME_INVALID: name must be 1 to 1024 UTF-8 bytes"),
      },
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toEqual({
      outcome: "filed",
      coreDisputeId: "186",
      localDisputeId: "42",
      evidenceStatus: "unknown",
    });
    expect(seen.filter((s) => s.tool === "evidence_submit")).toHaveLength(1);
    const done = h.cases.find(row.caseId)!;
    expect(done.status).toBe("evidence_unknown");
    expect(done.error).toContain("NAME_INVALID");
    expect(h.cases.events(row.caseId).at(-1)?.detail).toContain("NAME_INVALID");
  });

  test("a pin the key only checked: not_sent pin_checked_only, nothing created", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet", {
      answers: { evidence_pin: () => toolResult({ status: "checked" }) },
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "not_sent", code: "pin_checked_only" });
    expect(seen.map((s) => s.tool)).not.toContain("dispute_create");
    const done = h.cases.find(row.caseId)!;
    expect([done.status, done.attachmentUri]).toEqual(["contested", null]);
  });

  test("a pin that fails: not_sent, the row contested, nothing created", async () => {
    const h = setup();
    const row = await h.contested("testnet");
    const { stage, seen } = http("testnet", {
      answers: { evidence_pin: () => refusal("FILE_TOO_LARGE: the file is over the limit") },
    });
    const out = await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: "--testnet" });
    expect(out).toMatchObject({ outcome: "not_sent", code: "FILE_TOO_LARGE" });
    expect(seen.map((s) => s.tool)).not.toContain("dispute_create");
    expect(h.cases.find(row.caseId)?.status).toBe("contested");
  });
});

test("no key reaches an outcome, a row, an event, a stored file or a log line", async () => {
  const h = setup();
  seenTestnetCase(h);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
  const outcomes: unknown[] = [];
  const run = async (mode: PilotMode, stage: KlerosStage, flag: "--testnet" | "--live") => {
    const row = await h.contested(mode);
    outcomes.push(await fileDispute(h.deps(stage), row.caseId, { confirmedFlag: flag }));
    outcomes.push(await preflightDispute(h.deps(stage), row.caseId, {}));
  };
  // Filed, refused on a read, frozen on a failure whose text names the key, and filed on live.
  await run("testnet", http("testnet").stage, "--testnet");
  await run("testnet", http("testnet", { every: () => httpStatus(401) }).stage, "--testnet");
  await run(
    "testnet",
    http("testnet", {
      every: (s) => {
        if (s.tool === "dispute_create")
          throw new TypeError(`fetch failed: authorization Bearer ${TESTNET_KEY}`);
        return undefined;
      },
    }).stage,
    "--testnet",
  );
  await run(
    "testnet",
    http("testnet", {
      answers: { evidence_submit: () => httpStatus(401) },
    }).stage,
    "--testnet",
  );
  await run("live", http("live").stage, "--live");
  expect(outcomes.map((o) => (o as { outcome?: string }).outcome)).toContain("filing_unknown");

  const everything = [
    JSON.stringify(outcomes),
    JSON.stringify(h.cases.list()),
    JSON.stringify(h.cases.list().map((r) => h.cases.events(r.caseId))),
    ...readdirSync(h.docDir).map((f) => readFileSync(join(h.docDir, f), "utf8")),
    ...lines,
  ].join("\n");
  for (const key of [TESTNET_KEY, LIVE_KEY]) expect(everything).not.toContain(key);
});
