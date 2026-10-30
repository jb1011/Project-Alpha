/**
 * The Kleros check: what the stage's service answers to the three reads a filing believes
 * (tools/list, the instructions string, court_get on the stage's own chain and court), and every
 * problem it names. The fake answers for a rehearsal; the HTTP client answers over a recording
 * `fetch` for the two real deployments. Nothing here writes, and a test proves the check never
 * calls a write tool.
 */
import type { Address } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  KLEROS_DEPLOYMENTS,
  type KlerosDeploymentName,
  deploymentFor,
} from "../../src/adapters/kleros/deployments";
import type { CourtClock } from "../../src/adapters/kleros/disputeService";
import { FakeDisputeService } from "../../src/adapters/kleros/fakeDisputeService";
import { HttpDisputeService } from "../../src/adapters/kleros/httpDisputeService";
import type { Config, KlerosConfig } from "../../src/config/env";
import { type KlerosStage, buildKlerosService } from "../../src/pilot/composition";
import {
  MIN_EVIDENCE_PERIOD_SECONDS,
  UNAUTHORIZED_PROBLEM,
  checkKleros,
} from "../../src/pilot/klerosCheck";

const API_URL = "https://dispute-service.example.test/mcp";
const TESTNET_KEY = "test-key-testnet";
const LIVE_KEY = "test-key-live";
const ALL_TOOLS = ["dispute_create", "evidence_pin", "evidence_submit", "dispute_get", "court_get"];
const INSTRUCTIONS: Record<KlerosDeploymentName, string> = {
  testnet:
    "This key files on arbitrum-sepolia-testnet, court 8, with 5 jurors; the preset broadcasts.",
  live: "This key files on arbitrum-one, Court ID 34, with 5 jurors; the preset broadcasts.",
};

interface Seen {
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
  authorization: string | null;
}

type Answer = (args: Record<string, unknown>) => Response | unknown;

/** The documented 200: one SSE frame carrying the JSON-RPC result. */
const frame = (id: unknown, result: unknown) =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const toolResult = (payload: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});
const refusal = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const status = (code: number) =>
  new Response(JSON.stringify({ error: `status ${code}` }), {
    status: code,
    headers: { "content-type": "application/json" },
  });

/** A fetch that answers the service's three reads (and nothing else) and records every request. */
function klerosFetch(
  o: {
    tools?: string[];
    /** null: initialize answers a result without an instructions string. */
    instructions?: string | null;
    court?: Answer;
    every?: () => Response | undefined;
  } = {},
  deployment: KlerosDeploymentName = "testnet",
) {
  const seen: Seen[] = [];
  const fetchStub = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: unknown;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const tool = body.method === "tools/call" ? body.params?.name : undefined;
    seen.push({
      method: body.method,
      tool,
      args: body.params?.arguments,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const forced = o.every?.();
    if (forced) return forced;
    if (body.method === "initialize")
      return frame(
        body.id,
        o.instructions === null
          ? { protocolVersion: "2025-06-18", capabilities: {} }
          : {
              protocolVersion: "2025-06-18",
              instructions: o.instructions ?? INSTRUCTIONS[deployment],
            },
      );
    if (body.method === "tools/list")
      return frame(body.id, { tools: (o.tools ?? ALL_TOOLS).map((name) => ({ name })) });
    if (tool === "court_get") {
      const args = body.params?.arguments ?? {};
      const answer = o.court
        ? o.court(args)
        : toolResult({
            id: args.id,
            timesPerPeriod: ["900", "2700", "1800", "2700"],
            hiddenVotes: true,
          });
      return answer instanceof Response ? answer : frame(body.id, answer);
    }
    throw new Error(`the check sent ${body.method} ${tool ?? ""}: it reads only`);
  };
  return { fetch: fetchStub as typeof fetch, seen };
}

function httpStage(
  mode: KlerosDeploymentName,
  fetchImpl: typeof fetch,
  o: { courtId?: number } = {},
): KlerosStage {
  return {
    mode,
    service: new HttpDisputeService({
      apiUrl: API_URL,
      apiKey: mode === "testnet" ? TESTNET_KEY : LIVE_KEY,
      deployment: mode,
      fetch: fetchImpl,
      sleep: async () => {},
    }),
    deployment: deploymentFor(mode, o.courtId),
    cap: mode === "testnet" ? 10 : 5,
    flag: mode === "testnet" ? "--testnet" : "--live",
  };
}

function fakeStage(court?: Partial<CourtClock>): KlerosStage & { service: FakeDisputeService } {
  return {
    mode: "rehearsal",
    service: new FakeDisputeService({ script: "pay", court }),
    deployment: null,
    cap: null,
    flag: null,
  };
}

const writeCalls = (seen: Seen[]) =>
  seen.filter((s) => ["dispute_create", "evidence_pin", "evidence_submit"].includes(s.tool ?? ""));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the clean case", () => {
  test("a rehearsal: the fake lists the write tools, answers its own instructions and court 8's clock", async () => {
    const stage = fakeStage();
    const r = await checkKleros(stage);
    expect(r.problems).toEqual([]);
    expect(r.deployment).toBeNull();
    expect(r.tools).toEqual(
      expect.arrayContaining(["dispute_create", "evidence_pin", "evidence_submit"]),
    );
    expect(r.instructions).toBe(await new FakeDisputeService({ script: "pay" }).instructions());
    expect(r.court?.courtId).toBe(KLEROS_DEPLOYMENTS.testnet.courtId);
    expect(r.court?.timesPerPeriod).toEqual([900, 2700, 1800, 2700]);
    // Reads only, and the court read on the rehearsal's own chain.
    expect(stage.service.calls.map((c) => c.tool)).toEqual([
      "tools/list",
      "initialize",
      "court_get",
    ]);
    expect(stage.service.calls[2]?.args).toEqual({ chain: "fake", courtId: 8 });
  });

  test.each(["testnet", "live"] as const)(
    "%s: the stage's own chain and court are read, with the stage's key, and nothing else",
    async (mode) => {
      const { fetch, seen } = klerosFetch({}, mode);
      const r = await checkKleros(httpStage(mode, fetch));
      expect(r.problems).toEqual([]);
      expect(r.deployment).toEqual(deploymentFor(mode));
      expect(r.instructions).toBe(INSTRUCTIONS[mode]);
      expect(r.court?.courtId).toBe(KLEROS_DEPLOYMENTS[mode].courtId);
      expect(seen.map((s) => s.tool ?? s.method)).toEqual([
        "tools/list",
        "initialize",
        "court_get",
      ]);
      expect(seen[2]?.args).toEqual({
        chain: KLEROS_DEPLOYMENTS[mode].chain,
        id: String(KLEROS_DEPLOYMENTS[mode].courtId),
      });
      const key = mode === "testnet" ? TESTNET_KEY : LIVE_KEY;
      expect(new Set(seen.map((s) => s.authorization))).toEqual(new Set([`Bearer ${key}`]));
    },
  );

  test("an instructions string naming the stage's own chain and court passes, in any spelling of the court", async () => {
    for (const text of [
      "arbitrum-sepolia-testnet, court #8",
      "Court ID 8 on arbitrum-sepolia-testnet",
      "court8; the testnet deployment",
      "no chain or court named here",
    ]) {
      const { fetch } = klerosFetch({ instructions: text });
      expect((await checkKleros(httpStage("testnet", fetch))).problems).toEqual([]);
    }
  });
});

describe("the problems", () => {
  test("a missing write tool is named", async () => {
    const { fetch } = klerosFetch({ tools: ["dispute_create", "dispute_get", "court_get"] });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("evidence_pin");
    expect(r.problems[0]).toContain("evidence_submit");
    expect(r.problems[0]).not.toContain("dispute_create");
  });

  test.each([
    ["testnet", "This key files on arbitrum-one, court 8.", "arbitrum-one"],
    ["live", "This key files on arbitrum-sepolia-testnet, court 34.", "arbitrum-sepolia-testnet"],
  ] as const)(
    "%s: an instructions string naming the other deployment's chain is a problem",
    async (mode, text, other) => {
      const { fetch } = klerosFetch({ instructions: text }, mode);
      const r = await checkKleros(httpStage(mode, fetch));
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toContain(other);
      expect(r.instructions).toBe(text);
    },
  );

  test("the other chain counts as a whole word only", async () => {
    const { fetch } = klerosFetch({
      instructions: "court 8; see arbitrum-one-archive for history",
    });
    expect((await checkKleros(httpStage("testnet", fetch))).problems).toEqual([]);
  });

  test.each([
    ["court 34", "34"],
    ["Court ID 34", "34"],
    ["court #9", "9"],
  ])("an instructions string naming another court (%s) is a problem", async (phrase, named) => {
    const { fetch } = klerosFetch({ instructions: `arbitrum-sepolia-testnet, ${phrase}` });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(`court ${named}`);
    expect(r.problems[0]).toContain("court 8");
  });

  test("a court id overridden in config is the one the instructions must name", async () => {
    const { fetch, seen } = klerosFetch({ instructions: "arbitrum-sepolia-testnet, court 8" });
    const r = await checkKleros(httpStage("testnet", fetch, { courtId: 9 }));
    expect(r.problems).toEqual([expect.stringContaining("court 8")]);
    expect(seen.at(-1)?.args).toEqual({ chain: "arbitrum-sepolia-testnet", id: "9" });
  });

  test("on a real deployment, no instructions string is a problem", async () => {
    const { fetch } = klerosFetch({ instructions: null });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.instructions).toBeNull();
    expect(r.problems).toEqual([expect.stringContaining("instructions")]);
  });

  test("a court that does not answer is a problem", async () => {
    for (const court of [
      () => refusal("COURT_NOT_FOUND: no court 8 on this chain"),
      () => status(500),
      () => toolResult({ id: "8", hiddenVotes: true }),
    ]) {
      const { fetch } = klerosFetch({ court });
      const r = await checkKleros(httpStage("testnet", fetch));
      expect(r.court).toBeNull();
      expect(r.problems).toEqual([expect.stringContaining("court_get")]);
    }
  });

  test(`an evidence period under ${MIN_EVIDENCE_PERIOD_SECONDS} s is a problem, and ${MIN_EVIDENCE_PERIOD_SECONDS} s is not`, async () => {
    const under = await checkKleros(fakeStage({ timesPerPeriod: [299, 2700, 1800, 2700] }));
    expect(under.problems).toEqual([expect.stringContaining("299 s")]);
    const at = await checkKleros(fakeStage({ timesPerPeriod: [300, 2700, 1800, 2700] }));
    expect(at.problems).toEqual([]);
  });

  test("a problem carries the service's words with no em dash", async () => {
    const dash = String.fromCodePoint(0x2014);
    const { fetch } = klerosFetch({
      court: () => refusal(`COURT_NOT_FOUND: no court 8 ${dash} try another chain`),
    });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toEqual([expect.stringContaining("COURT_NOT_FOUND: no court 8")]);
    expect(r.problems.join("").includes(dash)).toBe(false);
  });

  test("a problem names a file, never its absolute path; an IPFS address stays whole", async () => {
    const { fetch } = klerosFetch({
      court: () =>
        refusal(
          "COURT_NOT_FOUND: see /var/lib/kleros/courts/8.json, or the policy /ipfs/bafypolicy",
        ),
    });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toEqual([
      expect.stringContaining("see 8.json, or the policy /ipfs/bafypolicy"),
    ]);
    expect(r.problems.join("")).not.toContain("/var/lib");
  });

  test("a rehearsal stage that does not hold the fake reads nothing", async () => {
    const { fetch, seen } = klerosFetch();
    const stage: KlerosStage = {
      ...httpStage("testnet", fetch),
      mode: "rehearsal",
      deployment: null,
    };
    const r = await checkKleros(stage);
    expect(r.problems).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  test("a rehearsal whose service answers other instructions than the fake's is a problem", async () => {
    class Impostor extends FakeDisputeService {
      override async instructions(): Promise<string | null> {
        return "arbitrum-sepolia-testnet, court 8";
      }
    }
    const stage: KlerosStage = { ...fakeStage(), service: new Impostor({ script: "pay" }) };
    expect((await checkKleros(stage)).problems).toEqual([expect.stringContaining("fake")]);
  });

  test("a refused key is one problem, named without the key", async () => {
    const { fetch } = klerosFetch({ every: () => status(401) });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toContain(UNAUTHORIZED_PROBLEM);
    expect(r.problems.filter((p) => p === UNAUTHORIZED_PROBLEM)).toHaveLength(1);
    const printed = JSON.stringify(r);
    expect(printed).not.toContain(TESTNET_KEY);
    expect(printed).not.toContain(LIVE_KEY);
  });
});

describe("the real-reads client of a rehearsal", () => {
  function rehearsalCfg(): Config {
    const kleros: KlerosConfig = {
      apiKeyTestnet: TESTNET_KEY,
      apiKeyLive: LIVE_KEY,
      apiUrl: API_URL,
      courtIdTestnet: 8,
      courtIdLive: 34,
      aliasClient: "client",
      aliasProvider: "provider",
      expectedOptions: {},
      policyUri: "/ipfs/test-policy",
    };
    return {
      pilot: {
        buyerPrivateKey: generatePrivateKey(),
        sellerPrivateKey: generatePrivateKey(),
        refereePrivateKey: generatePrivateKey(),
        mode: "rehearsal",
        testnetCasesCap: 10,
        liveCasesCap: 5,
        lookupBase: "https://api.example.com",
      },
      kleros,
    } as unknown as Config;
  }

  test.each(["testnet", "live"] as const)(
    "%s: the check reads the named deployment, and its writes throw before any fetch",
    async (name) => {
      const { fetch, seen } = klerosFetch({}, name);
      vi.stubGlobal("fetch", fetch);
      const stage = buildKlerosService(rehearsalCfg(), { realReads: name });
      const r = await checkKleros(stage);
      expect(r.problems).toEqual([]);
      expect(r.deployment?.chain).toBe(KLEROS_DEPLOYMENTS[name].chain);
      expect(seen).toHaveLength(3);

      const before = seen.length;
      const client = "0x1111111111111111111111111111111111111111" as Address;
      await expect(
        stage.service.pin({ bytes: new Uint8Array([1]), extension: "csv" }),
      ).rejects.toThrow(/nothing was sent/);
      await expect(stage.service.createDispute({ aliases: { client } })).rejects.toThrow(
        /nothing was sent/,
      );
      await expect(
        stage.service.submitEvidence({ coreDisputeId: "1", name: "n", description: "d" }),
      ).rejects.toThrow(/nothing was sent/);
      expect(seen).toHaveLength(before);
      expect(writeCalls(seen)).toEqual([]);
    },
  );
});
