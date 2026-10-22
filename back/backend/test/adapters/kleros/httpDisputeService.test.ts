/**
 * The HTTP client of the Kleros Dispute Service, against a stubbed `fetch` that records every
 * request and answers scripted native `Response`s.
 *
 * What is pinned is what the Kleros docs make load-bearing ("Calling the service as raw HTTP
 * JSON-RPC" and "One dispute, from creation to a ruling"): one JSON-RPC object per POST with the
 * three headers, the HTTP status read before anything else, the SSE `data:` line, `isError` before
 * the payload, the last JSON object of a prefixed `unknown` text, reads bound to the instance's
 * chain, one write at a time per key, and the retry rules that keep a filing from going out twice.
 * Time is injected (`now`, `sleep`), so nothing waits in real time except the deadline tests,
 * which use a deadline of a few milliseconds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KLEROS_DEPLOYMENTS } from "../../../src/adapters/kleros/deployments";
import {
  KlerosHttpError,
  KlerosRefusal,
  KlerosTransportError,
  KlerosWrongDeploymentError,
  PRESET_SIMULATES,
  sentOf,
} from "../../../src/adapters/kleros/errors";
import {
  HttpDisputeService,
  type HttpDisputeServiceDeps,
  normaliseRulingValue,
  parseSseFrame,
  parseToolPayload,
} from "../../../src/adapters/kleros/httpDisputeService";

// Every deadline the client asks for, so the default of each kind of call is observable. The
// real `withDeadline` still runs underneath. `vi.hoisted` because vi.mock factories are hoisted.
const deadlineMs = vi.hoisted(() => [] as number[]);
type DeadlineModule = typeof import("../../../src/util/deadline");
vi.mock("../../../src/util/deadline", async (importOriginal) => {
  const actual = await importOriginal<DeadlineModule>();
  return {
    ...actual,
    withDeadline: <T>(
      ms: number,
      work: (signal: AbortSignal) => Promise<T>,
      onTimeout?: () => Error,
    ): Promise<T> => {
      deadlineMs.push(ms);
      return actual.withDeadline(ms, work, onTimeout);
    },
  };
});

const API_URL = "https://dispute-service.example.test/mcp";
const KEY = "test-key-testnet";
const LIVE_KEY = "test-key-live";
const TESTNET = KLEROS_DEPLOYMENTS.testnet.chain;
const ARBITRUM_ONE = KLEROS_DEPLOYMENTS.live.chain;
const TX = `0x${"ab".repeat(32)}`;
const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
/** "%PDF-": five bytes, so the base64 carries one padding character. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
  at: number;
}

type Reply = Response | Error | ((req: Sent) => Response | Promise<Response>);

/** A client on the testnet key whose fetch records every request and answers `replies` in order. */
function harness(replies: Reply[], deps: Partial<HttpDisputeServiceDeps> = {}) {
  const clock = { t: 1_790_000_000_000 };
  const sleeps: number[] = [];
  const requests: Sent[] = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    const req: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)),
      signal: init?.signal ?? undefined,
      at: clock.t,
    };
    requests.push(req);
    const reply = replies[requests.length - 1];
    if (reply === undefined) throw new Error(`no scripted answer for request ${requests.length}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(req) : reply;
  };
  const svc = new HttpDisputeService({
    apiUrl: API_URL,
    apiKey: KEY,
    deployment: "testnet",
    fetch: fetchStub as typeof fetch,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    ...deps,
  });
  return { svc, requests, sleeps, clock };
}

/** The documented 200: one SSE frame, then the connection closes. */
function sse(message: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
const result = (r: unknown) => sse({ result: r, jsonrpc: "2.0", id: 1 });
const toolText = (text: string) => result({ content: [{ type: "text", text }] });
const tool = (payload: unknown) => toolText(JSON.stringify(payload));
const refused = (text: string) => result({ content: [{ type: "text", text }], isError: true });
const http = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });
const netDown = () => new TypeError("fetch failed");
const times = (n: number, make: () => Reply): Reply[] => Array.from({ length: n }, make);
/** Let every queued microtask run (the lock, the limiter and the fetch call are all promises). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function argsOf(req: Sent | undefined): unknown {
  return (req?.body as { params?: { arguments?: unknown } } | undefined)?.params?.arguments;
}

const PUBLISHED = {
  status: "published",
  fileURI: "/ipfs/bafytestcid",
  cid: "bafytestcid",
  verified: true,
};
const MINED_CREATE = { status: "mined", coreDisputeID: "186", localDisputeID: "42", txHash: TX };
const UNKNOWN_PREFIX =
  "Warning: the transaction was broadcast but no receipt arrived in time. Do not send it again.";
const WIP = "WRITE_IN_PROGRESS: another write on this key is still running";
const ITEM = {
  id: "186",
  chain: TESTNET,
  status: "Appeal",
  ruling: "1",
  tied: false,
  ruled: false,
  ruledSemantics: "onchain",
  roundCount: 1,
  rulingLabel: "Pay the provider",
  // Out of index order on purpose: an option is matched on its value, never on its position.
  rulingOptions: [
    { value: "0x02", title: "Refund the client" },
    { value: "0x00", title: "Refuse to arbitrate" },
    { value: "0x01", title: "Pay the provider" },
  ],
  deadline: "2026-10-22T13:00:00.000Z",
  lastPeriodChange: "2026-10-22T12:15:00.000Z",
  unresolvedFields: [],
  unresolvedReason: null,
};
const disputes = (...items: unknown[]) => ({
  items,
  nextCursor: null,
  hasMore: false,
  chainStatus: [{ chain: TESTNET, ok: true }],
});
const COURT = { id: "8", timesPerPeriod: ["900", "2700", "1800", "2700"], hiddenVotes: true };

/** Every error any test provokes, checked at the end for the key. */
const provoked: unknown[] = [];
async function failure(p: Promise<unknown>): Promise<Error> {
  let value: unknown;
  try {
    value = await p;
  } catch (e) {
    provoked.push(e);
    return e as Error;
  }
  throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseSseFrame", () => {
  it("parses the data: line of the documented frame", () => {
    const body = 'event: message\ndata: {"result":{"ok":true},"jsonrpc":"2.0","id":1}\n\n';
    expect(parseSseFrame(body)).toEqual({ result: { ok: true }, jsonrpc: "2.0", id: 1 });
  });

  it("reads CRLF frames and takes the first data: line", () => {
    expect(parseSseFrame('event: message\r\ndata: {"n":1}\r\ndata: {"n":2}\r\n\r\n')).toEqual({
      n: 1,
    });
  });

  it.each([
    ["an empty body", ""],
    ["a bare JSON body", '{"result":{}}'],
    ["a data: line that is not JSON", "event: message\ndata: {not json\n\n"],
  ])("throws a transport error on %s", (_name, body) => {
    expect(() => parseSseFrame(body)).toThrow(KlerosTransportError);
  });
});

describe("parseToolPayload", () => {
  it("parses a bare JSON payload", () => {
    expect(parseToolPayload(JSON.stringify(MINED_CREATE))).toEqual(MINED_CREATE);
  });

  it("takes the last JSON object after the warning sentence of an unknown result", () => {
    const payload = { status: "unknown", txHash: TX, detail: { stage: "receipt" } };
    expect(parseToolPayload(`${UNKNOWN_PREFIX}\n${JSON.stringify(payload)}`)).toEqual(payload);
  });

  it("skips braces in the prose and earlier objects", () => {
    const text = `Note {sic}: an object {"status":"draft"} came first. {"status":"unknown"}`;
    expect(parseToolPayload(text)).toEqual({ status: "unknown" });
  });

  it.each([[""], ["no JSON here"], ["[1, 2]"]])("throws when %j holds no JSON object", (text) => {
    expect(() => parseToolPayload(text)).toThrow(KlerosTransportError);
  });
});

describe("normaliseRulingValue", () => {
  it.each([["1"], ["0x01"], [1], [1n], [" 1 "], ["0x1"]])("reads %s as ruling 1", (v) => {
    expect(normaliseRulingValue(v)).toBe(1n);
  });

  it("reads 0, decimal and hex alike", () => {
    expect(normaliseRulingValue("0")).toBe(0n);
    expect(normaliseRulingValue("0x00")).toBe(0n);
    expect(normaliseRulingValue("0x0A")).toBe(10n);
    expect(normaliseRulingValue("10")).toBe(10n);
  });

  it.each([["abc"], [""], [" "], ["0x"], ["-1"], ["1.5"], [-1], [1.5], [-1n], [null], [{}]])(
    "answers null for %s",
    (v) => {
      expect(normaliseRulingValue(v)).toBeNull();
    },
  );
});

describe("one POST per call", () => {
  it("sends one JSON-RPC object with the three documented headers and no session", async () => {
    const { svc, requests } = harness([tool(disputes(ITEM)), tool(disputes(ITEM))]);
    await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(API_URL);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    expect(requests[0]?.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispute_get", arguments: { id: "186", chain: TESTNET } },
    });
    // The id counts up per instance.
    expect((requests[1]?.body as { id: number }).id).toBe(2);
  });

  it("sends each tool its documented arguments and nothing else", async () => {
    const { svc, requests } = harness([
      tool(COURT),
      tool(PUBLISHED),
      tool(MINED_CREATE),
      tool({ status: "mined", txHash: TX }),
      tool({ status: "mined", txHash: TX }),
    ]);
    await svc.getCourt({ chain: TESTNET, courtId: 8 });
    await svc.pin({ bytes: PDF, extension: "pdf" });
    await svc.createDispute({ aliases: { client: CLIENT, provider: PROVIDER } });
    await svc.submitEvidence({
      coreDisputeId: "186",
      name: "Job 7: what was delivered",
      description: "The provider delivered the report on time.",
      fileUri: "/ipfs/bafytestcid",
      fileTypeExtension: "pdf",
    });
    await svc.submitEvidence({
      coreDisputeId: "186",
      name: "Job 7: a note",
      description: "No attachment.",
    });
    expect(requests.map((r) => (r.body as { params: { name: string } }).params.name)).toEqual([
      "court_get",
      "evidence_pin",
      "dispute_create",
      "evidence_submit",
      "evidence_submit",
    ]);
    expect(argsOf(requests[0])).toEqual({ chain: TESTNET, id: "8" });
    // Standard padded base64 (RFC 4648 section 4), never base64url or a data: URI.
    expect(argsOf(requests[1])).toEqual({ attachment: "JVBERi0=", extension: "pdf" });
    expect(argsOf(requests[2])).toEqual({ aliases: { client: CLIENT, provider: PROVIDER } });
    expect(argsOf(requests[3])).toEqual({
      dispute: "186",
      name: "Job 7: what was delivered",
      description: "The provider delivered the report on time.",
      fileUri: "/ipfs/bafytestcid",
      fileTypeExtension: "pdf",
    });
    // No key with an undefined value: the service refuses fileTypeExtension without fileUri.
    expect(Object.keys(argsOf(requests[4]) as object)).toEqual(["dispute", "name", "description"]);
  });

  it("never sends a batch: every body of every kind of call is one JSON-RPC object", async () => {
    const { svc, requests } = harness([
      result({ tools: [{ name: "dispute_get" }] }),
      result({ instructions: "testnet court 8" }),
      tool(COURT),
      tool(disputes(ITEM)),
      tool(PUBLISHED),
      tool(MINED_CREATE),
      tool({ status: "mined", txHash: TX }),
    ]);
    await svc.listTools();
    await svc.instructions();
    await svc.getCourt({ chain: TESTNET, courtId: 8 });
    await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    await svc.pin({ bytes: PDF, extension: "pdf" });
    await svc.createDispute({ aliases: {} });
    await svc.submitEvidence({ coreDisputeId: "186", name: "n", description: "d" });
    expect(requests).toHaveLength(7);
    for (const r of requests) {
      expect(Array.isArray(r.body)).toBe(false);
      expect(typeof r.body).toBe("object");
      expect((r.body as { jsonrpc: string }).jsonrpc).toBe("2.0");
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain("mcp-session-id");
    }
  });
});

describe("tools/list", () => {
  it("answers the tool names, following nextCursor exactly as received", async () => {
    const { svc, requests } = harness([
      result({
        tools: [{ name: "dispute_get", inputSchema: {} }, { name: "court_get" }],
        nextCursor: "page:2:",
      }),
      result({ tools: [{ name: "dispute_create" }, { name: "evidence_pin" }] }),
    ]);
    expect(await svc.listTools()).toEqual([
      "dispute_get",
      "court_get",
      "dispute_create",
      "evidence_pin",
    ]);
    expect(requests.map((r) => r.body)).toEqual([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "page:2:" } },
    ]);
  });

  it("stops after five pages", async () => {
    const { svc, requests } = harness(
      times(6, () => result({ tools: [{ name: "dispute_get" }], nextCursor: "more" })),
    );
    expect(await svc.listTools()).toHaveLength(5);
    expect(requests).toHaveLength(5);
  });
});

describe("instructions", () => {
  const INIT = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "novi-pilot", version: "0" },
    },
  };

  it("reads the instructions string with one stateless initialize POST", async () => {
    const text = "This key files on arbitrum-sepolia-testnet, court 8, 5 jurors, and broadcasts.";
    const { svc, requests } = harness([
      result({ protocolVersion: "2025-06-18", capabilities: {}, instructions: text }),
    ]);
    expect(await svc.instructions()).toBe(text);
    // One POST: no notifications/initialized follows, and nothing is kept.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual(INIT);
  });

  it.each([
    [
      "a JSON-RPC error",
      () => sse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }),
    ],
    ["an HTTP 400", () => http(400, '{"error":"bad request"}')],
    ["an HTTP 401", () => http(401, '{"error":"unauthorized"}')],
    ["an HTTP 429 (never retried)", () => http(429, '{"error":"rate limit exceeded"}')],
    ["a result without the field", () => result({ protocolVersion: "2025-06-18" })],
    ["a network failure", () => netDown()],
  ])("answers null on %s, with one ops line naming the deployment", async (_name, reply) => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const { svc, requests, sleeps } = harness([reply()]);
    expect(await svc.instructions()).toBeNull();
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
    const ops = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.opslog === "kleros_instructions_unavailable");
    expect(ops).toHaveLength(1);
    expect(ops[0]?.deployment).toBe("testnet");
    expect(typeof ops[0]?.reason).toBe("string");
    for (const l of lines) expect(l).not.toContain(KEY);
  });
});

describe("the answer, in order: HTTP status, SSE frame, JSON-RPC, isError, payload", () => {
  it.each([
    [401, '{"error":"unauthorized"}'],
    [429, '{"error":"rate limit exceeded"}'],
    [413, '{"error":"request body too large"}'],
  ])("HTTP %i is a KlerosHttpError, decided before JSON-RPC", async (status, body) => {
    const { svc, requests } = harness([http(status, body)]);
    const e = await failure(svc.createDispute({ aliases: {} }));
    expect(e).toBeInstanceOf(KlerosHttpError);
    expect((e as KlerosHttpError).status).toBe(status);
    expect((e as KlerosHttpError).body).toBe(body);
    expect(e.message).toBe(`Kleros Dispute Service answered HTTP ${status}`);
    expect(requests).toHaveLength(1);
  });

  it.each([[400], [406], [503]])("HTTP %i is a KlerosHttpError with that status", async (s) => {
    const { svc } = harness([http(s, `{"error":"${"x".repeat(2_000)}"}`)]);
    const e = await failure(svc.createDispute({ aliases: {} }));
    expect(e).toBeInstanceOf(KlerosHttpError);
    expect((e as KlerosHttpError).status).toBe(s);
    expect((e as KlerosHttpError).body).toHaveLength(500);
  });

  it("a 200 without a data: line is a transport error", async () => {
    const { svc } = harness([http(200, JSON.stringify({ result: { content: [] } }))]);
    expect(await failure(svc.createDispute({ aliases: {} }))).toBeInstanceOf(KlerosTransportError);
  });

  it("a JSON-RPC error member is a transport error carrying its code and message", async () => {
    const { svc } = harness([
      sse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }),
    ]);
    const e = await failure(svc.createDispute({ aliases: {} }));
    expect(e).toBeInstanceOf(KlerosTransportError);
    expect(e.message).toContain("-32602");
    expect(e.message).toContain("Invalid params");
  });

  it("isError is a refusal whose code is the leading phrase of the joined text", async () => {
    const { svc } = harness([
      result({
        isError: true,
        content: [
          { type: "text", text: "INSUFFICIENT_BALANCE: the wallet cannot cover the fee." },
          { type: "text", text: "Nothing was sent." },
        ],
      }),
    ]);
    const e = await failure(svc.createDispute({ aliases: { client: CLIENT } }));
    expect(e).toBeInstanceOf(KlerosRefusal);
    const r = e as KlerosRefusal;
    expect(r.tool).toBe("dispute_create");
    expect(r.code).toBe("INSUFFICIENT_BALANCE");
    expect(r.text).toBe(
      "INSUFFICIENT_BALANCE: the wallet cannot cover the fee.\nNothing was sent.",
    );
    expect(sentOf("dispute_create", r.code)).toBe("no");
  });

  it("a refusal in prose has no code", async () => {
    const { svc, requests } = harness([
      refused("The dispute could not be resolved on that chain."),
    ]);
    const e = await failure(svc.getDispute({ chain: TESTNET, coreDisputeId: "186" }));
    expect(e).toBeInstanceOf(KlerosRefusal);
    expect((e as KlerosRefusal).tool).toBe("dispute_get");
    expect((e as KlerosRefusal).code).toBeNull();
    // A refusal is an answer, not a transport failure: a read does not retry it.
    expect(requests).toHaveLength(1);
  });
});

describe("dispute_create", () => {
  it("maps a mined filing with both ids", async () => {
    const { svc } = harness([tool(MINED_CREATE)]);
    expect(await svc.createDispute({ aliases: { client: CLIENT, provider: PROVIDER } })).toEqual({
      status: "mined",
      coreDisputeId: "186",
      localDisputeId: "42",
      txHash: TX,
    });
  });

  it("leaves localDisputeId undefined on localDisputeIDUnavailable", async () => {
    const { localDisputeID: _drop, ...rest } = MINED_CREATE;
    const { svc } = harness([
      tool({ ...rest, localDisputeIDUnavailable: "the receipt could not be read back" }),
    ]);
    const out = await svc.createDispute({ aliases: {} });
    expect(out).toEqual({ status: "mined", coreDisputeId: "186", txHash: TX });
    expect("localDisputeId" in out).toBe(false);
  });

  it("maps an unknown filing behind its warning sentence, keeping the text", async () => {
    const text = `${UNKNOWN_PREFIX}\n${JSON.stringify({ status: "unknown", txHash: TX })}`;
    const { svc } = harness([toolText(text)]);
    expect(await svc.createDispute({ aliases: {} })).toEqual({
      status: "unknown",
      txHash: TX,
      text,
    });
  });

  it("raises a simulated filing as a PRESET_SIMULATES refusal (nothing sent)", async () => {
    const { svc, requests } = harness([tool({ status: "simulated", quote: "0.01" })]);
    const e = await failure(svc.createDispute({ aliases: {} }));
    expect(e).toBeInstanceOf(KlerosRefusal);
    const r = e as KlerosRefusal;
    expect(r.tool).toBe("dispute_create");
    expect(r.text).toBe("PRESET_SIMULATES: the key simulated the write; nothing was sent");
    expect(r.code).toBe(PRESET_SIMULATES);
    expect(sentOf("dispute_create", r.code)).toBe("no");
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["coreDisputeID", { status: "mined", txHash: TX }],
    ["txHash", { status: "mined", coreDisputeID: "186" }],
    ["status", { status: "reverted", txHash: TX }],
  ])("a payload without a usable %s is a transport error, never a guess", async (field, p) => {
    const { svc, requests } = harness([tool(p)]);
    const e = await failure(svc.createDispute({ aliases: {} }));
    expect(e).toBeInstanceOf(KlerosTransportError);
    expect(e.message).toContain(field);
    expect(requests).toHaveLength(1);
  });
});

describe("evidence_pin", () => {
  it("maps a published pin's fileURI to fileUri", async () => {
    const { svc } = harness([tool(PUBLISHED)]);
    expect(await svc.pin({ bytes: PDF, extension: "pdf" })).toEqual({
      status: "published",
      fileUri: "/ipfs/bafytestcid",
      cid: "bafytestcid",
    });
  });

  it("maps a checked pin (nothing published, no URI)", async () => {
    const { svc } = harness([tool({ status: "checked", size: 5 })]);
    expect(await svc.pin({ bytes: PDF, extension: "pdf" })).toEqual({ status: "checked" });
  });
});

describe("evidence_submit", () => {
  it("maps a mined submission", async () => {
    const { svc } = harness([tool({ status: "mined", txHash: TX })]);
    expect(await svc.submitEvidence({ coreDisputeId: "186", name: "n", description: "d" })).toEqual(
      { status: "mined", txHash: TX },
    );
  });

  it("maps an unknown submission behind its warning sentence", async () => {
    const text = `${UNKNOWN_PREFIX} ${JSON.stringify({ status: "unknown", txHash: TX })}`;
    const { svc } = harness([toolText(text)]);
    expect(await svc.submitEvidence({ coreDisputeId: "186", name: "n", description: "d" })).toEqual(
      { status: "unknown", txHash: TX, text },
    );
  });

  it("raises a simulated submission as a PRESET_SIMULATES refusal", async () => {
    const { svc } = harness([tool({ status: "simulated" })]);
    const e = await failure(
      svc.submitEvidence({ coreDisputeId: "186", name: "n", description: "d" }),
    );
    expect(e).toBeInstanceOf(KlerosRefusal);
    expect((e as KlerosRefusal).tool).toBe("evidence_submit");
    expect((e as KlerosRefusal).code).toBe(PRESET_SIMULATES);
  });
});

describe("dispute_get", () => {
  it("reads items[0], maps every field, and sends the chain", async () => {
    const { svc, requests } = harness([tool(disputes(ITEM, { ...ITEM, id: "999" }))]);
    const read = await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    expect(read).toEqual({
      status: "Appeal",
      ruling: "1",
      tied: false,
      ruled: false,
      roundCount: 1,
      rulingLabel: "Pay the provider",
      rulingOptions: [
        { value: "0x02", title: "Refund the client" },
        { value: "0x00", title: "Refuse to arbitrate" },
        { value: "0x01", title: "Pay the provider" },
      ],
      deadline: "2026-10-22T13:00:00.000Z",
      lastPeriodChange: "2026-10-22T12:15:00.000Z",
      unresolvedFields: [],
      raw: ITEM,
    });
    // The ruling is matched on the option's value, not on its index ("1" is index 2 here).
    const chosen = read.rulingOptions.find(
      (o) => normaliseRulingValue(o.value) === normaliseRulingValue(read.ruling),
    );
    expect(chosen?.title).toBe("Pay the provider");
    expect(argsOf(requests[0])).toEqual({ id: "186", chain: TESTNET });
  });

  it("keeps tied apart from ruling 0: no majority yet", async () => {
    const tiedItem = {
      ...ITEM,
      status: "Vote",
      ruling: "0",
      tied: true,
      rulingLabel: "Invalid / Refuse to Arbitrate",
    };
    const { svc } = harness([tool(disputes(tiedItem))]);
    const read = await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    expect(read.status).toBe("Vote");
    expect(read.ruling).toBe("0");
    expect(read.tied).toBe(true);
  });

  it("turns numbers into strings, numeric strings into numbers, and reads id/label", async () => {
    const item = {
      ...ITEM,
      ruling: 2,
      roundCount: "2",
      rulingOptions: [
        { id: 1, label: "Pay the provider" },
        { ruling: "2", title: "Refund the client" },
      ],
    };
    const { svc } = harness([tool(disputes(item))]);
    const read = await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    expect(read.ruling).toBe("2");
    expect(read.roundCount).toBe(2);
    expect(read.rulingOptions).toEqual([
      { value: "1", title: "Pay the provider" },
      { value: "2", title: "Refund the client" },
    ]);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["the unix epoch", "1970-01-01T00:00:00.000Z"],
  ])("reads a deadline that is %s as null", async (_name, deadline) => {
    const { svc } = harness([tool(disputes({ ...ITEM, deadline }))]);
    expect((await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" })).deadline).toBeNull();
  });

  it("answers rulingOptions [] when unresolvedFields names it", async () => {
    const { rulingOptions: _drop, ...rest } = ITEM;
    const { svc } = harness([tool(disputes({ ...rest, unresolvedFields: ["rulingOptions"] }))]);
    const read = await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    expect(read.rulingOptions).toEqual([]);
    expect(read.unresolvedFields).toEqual(["rulingOptions"]);
  });

  it("defaults unresolvedFields to [] only when the field is absent", async () => {
    const { unresolvedFields: _drop, ...rest } = ITEM;
    const { svc } = harness([tool(disputes(rest))]);
    expect(
      (await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" })).unresolvedFields,
    ).toEqual([]);
  });

  it.each([
    ["status", { ...ITEM, status: undefined }],
    ["status", { ...ITEM, status: "Unknown" }],
    ["ruling", { ...ITEM, ruling: undefined }],
    ["tied", { ...ITEM, tied: undefined }],
    ["ruled", { ...ITEM, ruled: undefined }],
    ["roundCount", { ...ITEM, roundCount: undefined }],
    ["rulingOptions", { ...ITEM, rulingOptions: undefined }],
    ["rulingOptions", { ...ITEM, rulingOptions: [{ value: "0x01" }] }],
    ["unresolvedFields", { ...ITEM, unresolvedFields: "rulingOptions" }],
    ["deadline", { ...ITEM, deadline: 1_790_000_000 }],
  ])("a read without a usable %s is a transport error naming it", async (field, item) => {
    // A read retries a transport error twice, so the same answer is scripted three times.
    const { svc, requests } = harness(times(3, () => tool(disputes(item))));
    const e = await failure(svc.getDispute({ chain: TESTNET, coreDisputeId: "186" }));
    expect(e).toBeInstanceOf(KlerosTransportError);
    expect(e.message).toContain(field);
    expect(requests).toHaveLength(3);
  });

  it("an empty items is a transport error: not found on the chain", async () => {
    const { svc } = harness(times(3, () => tool(disputes())));
    const e = await failure(svc.getDispute({ chain: TESTNET, coreDisputeId: "186" }));
    expect(e).toBeInstanceOf(KlerosTransportError);
    expect(e.message).toContain(`dispute not found on ${TESTNET}`);
  });
});

describe("court_get", () => {
  it("reads a top-level court with numeric strings, the court id from the argument", async () => {
    const { svc } = harness([tool(COURT)]);
    expect(await svc.getCourt({ chain: TESTNET, courtId: 8 })).toEqual({
      courtId: 8,
      timesPerPeriod: [900, 2700, 1800, 2700],
      hiddenVotes: true,
      raw: COURT,
    });
  });

  it("reads the court from items[0]", async () => {
    const court = { ...COURT, timesPerPeriod: [900, 2700, 1800, 2700], hiddenVotes: false };
    const { svc } = harness([tool({ items: [court], nextCursor: null })]);
    expect(await svc.getCourt({ chain: TESTNET, courtId: 8 })).toEqual({
      courtId: 8,
      timesPerPeriod: [900, 2700, 1800, 2700],
      hiddenVotes: false,
      raw: court,
    });
  });

  it.each([
    ["timesPerPeriod", { ...COURT, timesPerPeriod: undefined }],
    ["timesPerPeriod", { ...COURT, timesPerPeriod: ["900", "2700", "1800"] }],
    ["timesPerPeriod", { ...COURT, timesPerPeriod: ["900", "2700", "1800", "soon"] }],
    ["hiddenVotes", { ...COURT, hiddenVotes: "true" }],
    ["items[0]", { items: [] }],
  ])("a court without a usable %s is a transport error naming it", async (field, payload) => {
    const { svc } = harness(times(3, () => tool(payload)));
    const e = await failure(svc.getCourt({ chain: TESTNET, courtId: 8 }));
    expect(e).toBeInstanceOf(KlerosTransportError);
    expect(e.message).toContain(field);
  });
});

describe("one deployment per instance", () => {
  const instance = (deployment: "testnet" | "live", apiKey: string, replies: Reply[] = []) =>
    harness(replies, { deployment, apiKey });

  it.each([
    ["testnet", KEY, ARBITRUM_ONE],
    ["testnet", KEY, "fake"],
    ["live", LIVE_KEY, TESTNET],
    ["live", LIVE_KEY, "fake"],
  ] as const)("a %s instance refuses reads on %s with zero requests", async (dep, key, chain) => {
    const { svc, requests } = instance(dep, key);
    expect(svc.deployment).toBe(dep);
    for (const read of [
      svc.getDispute({ chain, coreDisputeId: "186" }),
      svc.getCourt({ chain, courtId: 34 }),
    ]) {
      const e = await failure(read);
      expect(e).toBeInstanceOf(KlerosWrongDeploymentError);
      expect((e as KlerosWrongDeploymentError).expected).toBe(KLEROS_DEPLOYMENTS[dep].chain);
      expect((e as KlerosWrongDeploymentError).got).toBe(chain);
    }
    expect(requests).toHaveLength(0);
  });

  it('a "live" instance reads on arbitrum-one', async () => {
    const { svc, requests } = instance("live", LIVE_KEY, [tool({ ...COURT, id: "34" })]);
    await svc.getCourt({ chain: ARBITRUM_ONE, courtId: 34 });
    expect(argsOf(requests[0])).toEqual({ chain: ARBITRUM_ONE, id: "34" });
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${LIVE_KEY}`);
  });
});

describe("rate limit", () => {
  it("admits 20 POSTs in a rolling minute: the 21st waits for the oldest to age 60 s", async () => {
    const { svc, requests, sleeps, clock } = harness(times(21, () => tool(disputes(ITEM))));
    const t0 = clock.t;
    for (let i = 0; i < 21; i++) await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    expect(sleeps).toEqual([60_000]);
    expect(requests.slice(0, 20).every((r) => r.at === t0)).toBe(true);
    expect(requests[20]?.at).toBe(t0 + 60_000);
  });

  it("slides: a start stays in the window for a full 60 s, wherever it fell", async () => {
    const { svc, requests, sleeps, clock } = harness(
      times(4, () => tool(disputes(ITEM))),
      {
        requestsPerMinute: 2,
      },
    );
    const t0 = clock.t;
    const read = () => svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    await read();
    clock.t += 40_000;
    await read();
    await read(); // the window holds t0 and t0 + 40 s: wait for t0 to age out
    await read(); // now it holds t0 + 40 s and t0 + 60 s: wait for t0 + 40 s
    expect(sleeps).toEqual([20_000, 40_000]);
    expect(requests.map((r) => r.at - t0)).toEqual([0, 40_000, 60_000, 100_000]);
  });

  it("counts every POST: initialize, list pages and retries alike", async () => {
    const { svc, requests, sleeps, clock } = harness(
      [result({ instructions: "x" }), result({ tools: [] }), netDown(), tool(disputes(ITEM))],
      { requestsPerMinute: 3 },
    );
    const t0 = clock.t;
    await svc.instructions();
    await svc.listTools();
    await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    // The read's retry is the fourth POST: after its 2 s backoff it still waits for the window.
    expect(sleeps).toEqual([2_000, 58_000]);
    expect(requests[3]?.at).toBe(t0 + 60_000);
  });

  it("a 429 on a read waits 15 s and retries once", async () => {
    const { svc, requests, sleeps } = harness([
      http(429, '{"error":"rate limit exceeded"}'),
      tool(disputes(ITEM)),
    ]);
    expect((await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" })).status).toBe("Appeal");
    expect(sleeps).toEqual([15_000]);
    expect(requests).toHaveLength(2);
  });

  it("a second 429 on a read is thrown", async () => {
    const { svc, requests } = harness(times(2, () => http(429, '{"error":"rate limit exceeded"}')));
    const e = await failure(svc.getDispute({ chain: TESTNET, coreDisputeId: "186" }));
    expect((e as KlerosHttpError).status).toBe(429);
    expect(requests).toHaveLength(2);
  });

  it.each([
    ["evidence_pin", (s: HttpDisputeService) => s.pin({ bytes: PDF, extension: "pdf" })],
    ["dispute_create", (s: HttpDisputeService) => s.createDispute({ aliases: {} })],
    [
      "evidence_submit",
      (s: HttpDisputeService) =>
        s.submitEvidence({ coreDisputeId: "186", name: "n", description: "d" }),
    ],
  ])("a 429 on %s is thrown, never retried", async (_tool, call) => {
    const { svc, requests, sleeps } = harness(
      times(2, () => http(429, '{"error":"rate limit exceeded"}')),
    );
    const e = await failure(call(svc));
    expect((e as KlerosHttpError).status).toBe(429);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("one write at a time per key", () => {
  it("serialises writes: the second pin's request starts after the first answer", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { svc, requests } = harness([
      async () => {
        events.push("start 1");
        await gate;
        events.push("answer 1");
        return tool(PUBLISHED);
      },
      () => {
        events.push("start 2");
        return tool(PUBLISHED);
      },
    ]);
    const first = svc.pin({ bytes: PDF, extension: "pdf" });
    const second = svc.pin({ bytes: PDF, extension: "pdf" });
    await settle();
    expect(requests).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["start 1", "answer 1", "start 2"]);
  });

  it("holds the lock per key across instances, and never across keys", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = harness([
      async () => {
        await gate;
        return tool(PUBLISHED);
      },
    ]);
    const b = harness([tool(MINED_CREATE)]);
    const live = harness([tool(PUBLISHED)], { deployment: "live", apiKey: LIVE_KEY });
    const pending = [
      a.svc.pin({ bytes: PDF, extension: "pdf" }),
      b.svc.createDispute({ aliases: {} }),
      live.svc.pin({ bytes: PDF, extension: "pdf" }),
    ];
    await settle();
    expect([a.requests.length, b.requests.length, live.requests.length]).toEqual([1, 0, 1]);
    release();
    await Promise.all(pending);
    expect(b.requests).toHaveLength(1);
  });

  it("never holds a read back behind a write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { svc } = harness([
      async () => {
        await gate;
        return tool(PUBLISHED);
      },
      tool(disputes(ITEM)),
    ]);
    const pin = svc.pin({ bytes: PDF, extension: "pdf" });
    await settle();
    expect((await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" })).status).toBe("Appeal");
    release();
    await pin;
  });

  it("waits out WRITE_IN_PROGRESS (nothing sent) 5 s at a time, then succeeds", async () => {
    const { svc, requests, sleeps } = harness([refused(WIP), refused(WIP), tool(MINED_CREATE)]);
    expect((await svc.createDispute({ aliases: {} })).status).toBe("mined");
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(requests).toHaveLength(3);
  });

  it("throws the WRITE_IN_PROGRESS refusal after 120 s of waiting", async () => {
    const { svc, requests, sleeps } = harness(times(26, () => refused(WIP)));
    const e = await failure(
      svc.submitEvidence({ coreDisputeId: "186", name: "n", description: "d" }),
    );
    expect(e).toBeInstanceOf(KlerosRefusal);
    expect((e as KlerosRefusal).code).toBe("WRITE_IN_PROGRESS");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(120_000);
    expect(requests).toHaveLength(25);
  });

  it("does not spend the pin's retries on WRITE_IN_PROGRESS", async () => {
    const { svc, requests, sleeps } = harness([
      ...times(4, () => refused(WIP)),
      ...times(3, netDown),
      tool(PUBLISHED),
    ]);
    expect((await svc.pin({ bytes: PDF, extension: "pdf" })).status).toBe("published");
    expect(requests).toHaveLength(8);
    expect(sleeps).toEqual([5_000, 5_000, 5_000, 5_000]);
  });
});

describe("retries", () => {
  it("retries a pin on a transport error", async () => {
    const { svc, requests } = harness([netDown(), tool(PUBLISHED)]);
    expect((await svc.pin({ bytes: PDF, extension: "pdf" })).status).toBe("published");
    expect(requests).toHaveLength(2);
  });

  it.each([
    ["an HTTP 503", () => http(503, "upstream unavailable")],
    ["an in-doubt refusal", () => refused("UPLOAD_FAILED: the response could not be read")],
    ["a refusal in prose", () => refused("The pin did not finish.")],
    ["an unreadable payload", () => toolText("not json")],
    ["a published pin without fileURI", () => tool({ status: "published", cid: "bafytestcid" })],
  ])("retries a pin on %s", async (_name, reply) => {
    const { svc, requests } = harness([reply(), tool(PUBLISHED)]);
    expect((await svc.pin({ bytes: PDF, extension: "pdf" })).status).toBe("published");
    expect(requests).toHaveLength(2);
  });

  it("retries a pin at most 3 times", async () => {
    const { svc, requests } = harness(times(5, netDown));
    expect(await failure(svc.pin({ bytes: PDF, extension: "pdf" }))).toBeInstanceOf(
      KlerosTransportError,
    );
    expect(requests).toHaveLength(4);
  });

  it.each([
    ["an HTTP 401", () => http(401, '{"error":"unauthorized"}')],
    ["an HTTP 413", () => http(413, '{"error":"request body too large"}')],
    ["an HTTP 429", () => http(429, '{"error":"rate limit exceeded"}')],
    ["FILE_TOO_LARGE", () => refused("FILE_TOO_LARGE: the limit that applied was 10 MiB")],
    ["ATTACHMENT_INVALID", () => refused("ATTACHMENT_INVALID: not standard padded base64")],
  ])("does not retry a pin on %s", async (_name, reply) => {
    const { svc, requests } = harness([reply(), tool(PUBLISHED)]);
    await failure(svc.pin({ bytes: PDF, extension: "pdf" }));
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["a transport error", netDown],
    ["an HTTP 503", () => http(503, "upstream unavailable")],
    ["an in-doubt refusal", () => refused("FILING_TIMED_OUT: the transaction may have been sent")],
    ["an unreadable payload", () => toolText("not json")],
  ])("never retries a create on %s", async (_name, reply) => {
    const { svc, requests, sleeps } = harness([reply(), tool(MINED_CREATE)]);
    await failure(svc.createDispute({ aliases: {} }));
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("never retries a submission on a transport error", async () => {
    const { svc, requests } = harness([netDown(), tool({ status: "mined", txHash: TX })]);
    await failure(svc.submitEvidence({ coreDisputeId: "186", name: "n", description: "d" }));
    expect(requests).toHaveLength(1);
  });

  it("retries a read twice on transport errors, after 2 s and 5 s", async () => {
    const { svc, requests, sleeps } = harness([netDown(), netDown(), tool(disputes(ITEM))]);
    expect((await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" })).status).toBe("Appeal");
    expect(sleeps).toEqual([2_000, 5_000]);
    expect(requests).toHaveLength(3);
  });

  it("throws the third transport error of a read", async () => {
    const { svc, requests } = harness(times(4, netDown));
    expect(await failure(svc.getCourt({ chain: TESTNET, courtId: 8 }))).toBeInstanceOf(
      KlerosTransportError,
    );
    expect(requests).toHaveLength(3);
  });

  it("does not retry a read on a 401", async () => {
    const { svc, requests } = harness([http(401, '{"error":"unauthorized"}'), tool(COURT)]);
    await failure(svc.getCourt({ chain: TESTNET, courtId: 8 }));
    expect(requests).toHaveLength(1);
  });
});

describe("deadlines", () => {
  it("gives each kind of call its own default deadline", async () => {
    const { svc } = harness([
      result({ tools: [] }),
      result({ instructions: "x" }),
      tool(COURT),
      tool(disputes(ITEM)),
      tool(PUBLISHED),
      tool(MINED_CREATE),
      tool({ status: "mined", txHash: TX }),
    ]);
    deadlineMs.length = 0;
    await svc.listTools();
    await svc.instructions();
    await svc.getCourt({ chain: TESTNET, courtId: 8 });
    await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    await svc.pin({ bytes: PDF, extension: "pdf" });
    await svc.createDispute({ aliases: {} });
    await svc.submitEvidence({ coreDisputeId: "186", name: "n", description: "d" });
    expect(deadlineMs).toEqual([30_000, 30_000, 30_000, 30_000, 120_000, 240_000, 240_000]);
  });

  it("fires on a fetch that never answers, aborts it, and names the tool and the ms", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { svc, requests } = harness(
      [
        (req) => {
          signals.push(req.signal);
          return new Promise<Response>(() => {});
        },
      ],
      { deadlines: { createMs: 5 } },
    );
    const e = await failure(svc.createDispute({ aliases: {} }));
    expect(e).toBeInstanceOf(KlerosTransportError);
    expect(e.message).toContain("dispute_create");
    expect(e.message).toContain("5 ms");
    expect(signals[0]?.aborted).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("gives each attempt of a read its own deadline", async () => {
    const hang = (req: Sent) =>
      new Promise<Response>((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { svc, requests, sleeps } = harness([hang, hang, hang], { deadlines: { readMs: 5 } });
    const e = await failure(svc.getDispute({ chain: TESTNET, coreDisputeId: "186" }));
    expect(e.message).toContain("dispute_get");
    expect(e.message).toContain("5 ms");
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.signal?.aborted === true)).toBe(true);
    expect(sleeps).toEqual([2_000, 5_000]);
  });
});

describe("the key", () => {
  it("is scrubbed from a network error that happens to quote it", async () => {
    const { svc } = harness([new TypeError(`fetch failed (authorization: Bearer ${KEY})`)]);
    const e = await failure(svc.createDispute({ aliases: {} }));
    expect(e).toBeInstanceOf(KlerosTransportError);
    expect(e.message).toContain("fetch failed");
    expect(e.message).not.toContain(KEY);
  });

  it("is not held in any visible property of the service", () => {
    const { svc } = harness([]);
    expect(JSON.stringify(svc)).not.toContain(KEY);
    for (const name of Object.getOwnPropertyNames(svc)) {
      expect(String((svc as unknown as Record<string, unknown>)[name])).not.toContain(KEY);
    }
  });

  // Last in the file: by now every test above has added the errors it provoked.
  it("appears in no thrown error's message or own properties", () => {
    expect(provoked.length).toBeGreaterThan(40);
    for (const e of provoked) expect(leaks(e)).toEqual([]);
  });
});

/** The paths under `v` (own properties, recursively; the stack aside) whose text holds a key. */
function leaks(v: unknown, path = "error", seen = new Set<unknown>()): string[] {
  if (typeof v === "string") return v.includes(KEY) || v.includes(LIVE_KEY) ? [path] : [];
  if (typeof v !== "object" || v === null || seen.has(v)) return [];
  seen.add(v);
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(v)) {
    if (name === "stack") continue;
    out.push(...leaks((v as Record<string, unknown>)[name], `${path}.${name}`, seen));
  }
  return out;
}
