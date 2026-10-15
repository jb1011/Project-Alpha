/**
 * The legal-body calls, against a stubbed `fetch`.
 *
 * Every authenticated door goes through `API_URL` (the site's proxy by default) with the session's
 * bearer token. The two public reads, the by-agent record and the transparency page, go to the
 * API's own origin with no header at all: the browser is then its own caller to the public
 * limiter, and the read stays a simple cross-origin GET with nothing to preflight.
 *
 * The config module reads the environment once, when it is first imported. Each test stubs the
 * public origin to a host that differs from `API_URL`, drops the module cache and imports fresh
 * copies of what it calls, `ApiError` included, so `instanceof` compares a class with itself.
 * Every stub, of the environment and of `fetch`, is removed after its test.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { apiKeys } from "@/lib/api/keys";
import type { PublicRead } from "@/lib/api/legalBodyClient";
import type {
  Address,
  BindingView,
  Hex,
  LegalBodyAgreement,
  LegalBodyByAgent,
  LegalBodyOrderView,
  LinkMessageResult,
  LinkRefusal,
  LinkTypedDataWire,
  StatementMessageAnswer,
  TransparencyView,
} from "@/lib/api/types";

/** An invented host: the public origin as an operator would set it, with a trailing slash. */
const PUBLIC_ORIGIN = "https://api.example.test";
const TOKEN = "session-token-for-tests";

/** The testnet factory, anvil's first account as the guardian, the live test body. */
const FACTORY: Address = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456";
const GUARDIAN: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BODY: Address = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE";
const AGENT = "897126";
const SIGNATURE: Hex = `0x${"11".repeat(65)}`;
const TX_HASH: Hex = `0x${"cd".repeat(32)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Fresh modules under a public origin that is not `API_URL`. */
async function load() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_URL", undefined);
  vi.stubEnv("NEXT_PUBLIC_PUBLIC_API_ORIGIN", `${PUBLIC_ORIGIN}/`);
  const config = await import("@/lib/api/config");
  const calls = await import("@/lib/api/legalBodyClient");
  const client = await import("@/lib/api/client");
  const { ApiError } = await import("@/lib/api/types");
  return {
    API_URL: config.API_URL,
    PUBLIC_API_ORIGIN: config.PUBLIC_API_ORIGIN,
    calls,
    client,
    ApiError,
  };
}

type Seen = { url: string; init: RequestInit };

/** Installs a `fetch` that records each request and answers with `answer()`. */
function stubFetch(answer: () => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(url), init });
      return answer();
    }),
  );
  return seen;
}

/** Installs a `fetch` that throws `error` instead of answering. */
function stubFetchThrowing(error: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw error;
    }),
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(seen: Seen): Headers {
  return new Headers(seen.init.headers);
}

function bodyOf(seen: Seen): unknown {
  return seen.init.body === undefined ? undefined : JSON.parse(String(seen.init.body));
}

/** An order view: a draft unless the overrides say otherwise. */
const view = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "ord_1",
  publicId: "pub_1",
  companyId: "co_a",
  state: "draft",
  chainId: 5042002,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"ab".repeat(32)}`, version: 1 },
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: "2026-10-15T09:00:00.000Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

const RESERVED = view({
  state: "reserved",
  agentId: AGENT,
  identityOwner: GUARDIAN,
  linkDeadline: 1_760_522_400,
});
const DEPLOYED = view({
  ...RESERVED,
  state: "deployed",
  bodyAddress: BODY,
  createTxHash: TX_HASH,
  deployedAt: 1_760_519_000,
});

const LINK_MESSAGE: LinkTypedDataWire["message"] = {
  agentId: AGENT,
  guardian: GUARDIAN,
  amendmentDelay: "172800",
  operatingAgreementHash: `0x${"ab".repeat(32)}`,
  deadline: "1760522400",
};

const BINDING: BindingView = {
  state: "deployed",
  agentId: AGENT,
  bodyAddress: BODY,
  intent: { action: "setLegalBodyPointer", agentId: AGENT, body: BODY, chainId: 5042002 },
  pointerSeenAt: null,
  nextCheckAt: 1_760_519_060_000,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
};

const AGREEMENT: LegalBodyAgreement = {
  termsDoc: "terms",
  manifest: "{}",
  manifestHash: `0x${"ab".repeat(32)}`,
  textId: "operating-agreement",
  textVersion: "1",
  textStatus: "draft",
};

const STATEMENT_INPUT = { companyName: "Example Test Holdings LLC", filingNumber: "TEST-0001" };

/** Only the parts of the answers these calls pass through untouched. */
const STATEMENT_ANSWER = {
  typedData: { primaryType: "StatementOfAuthority" },
  wordingVersion: "1",
  textStatus: "draft",
} as unknown as StatementMessageAnswer;
const LINK_MESSAGE_ANSWER = {
  typedData: { primaryType: "LegalBodyLink", message: LINK_MESSAGE },
  identityOwner: GUARDIAN,
  deadline: 1_760_522_400,
} as unknown as LinkMessageResult;

type Calls = Awaited<ReturnType<typeof load>>["calls"];

/** One row per authenticated door: what is called, what must leave, and what comes back. */
type DoorCase = {
  name: string;
  call: (c: Calls) => Promise<unknown>;
  method: "GET" | "POST";
  path: string;
  /** The JSON body sent, or `undefined` for a door that reads none. */
  body: unknown;
  answer: () => Response;
  result: unknown;
};

const DOORS: DoorCase[] = [
  {
    name: "requestStatementMessage",
    call: (c) => c.requestStatementMessage(TOKEN, STATEMENT_INPUT),
    method: "POST",
    path: "/companies/customer/statement-message",
    body: STATEMENT_INPUT,
    answer: () => json(200, STATEMENT_ANSWER),
    result: STATEMENT_ANSWER,
  },
  {
    name: "createCustomerCompany",
    call: (c) =>
      c.createCustomerCompany(TOKEN, {
        ...STATEMENT_INPUT,
        issuedAt: "1760519000",
        signature: SIGNATURE,
      }),
    method: "POST",
    path: "/companies/customer",
    body: { ...STATEMENT_INPUT, issuedAt: "1760519000", signature: SIGNATURE },
    answer: () => json(201, { companyId: "co_a" }),
    result: { companyId: "co_a" },
  },
  {
    name: "abandonCompany",
    call: (c) => c.abandonCompany(TOKEN, "co_a"),
    method: "POST",
    path: "/companies/co_a/abandon",
    body: undefined,
    answer: () => new Response(null, { status: 204 }),
    result: undefined,
  },
  {
    name: "listLegalBodyOrders",
    call: (c) => c.listLegalBodyOrders(TOKEN),
    method: "GET",
    path: "/legal-body-orders",
    body: undefined,
    answer: () => json(200, { orders: [view()] }),
    result: { orders: [view()] },
  },
  {
    name: "createLegalBodyOrder",
    call: (c) => c.createLegalBodyOrder(TOKEN, "co_a"),
    method: "POST",
    path: "/legal-body-orders",
    body: { companyId: "co_a" },
    answer: () => json(201, view()),
    result: view(),
  },
  {
    name: "getLegalBodyOrder",
    call: (c) => c.getLegalBodyOrder(TOKEN, "ord_1"),
    method: "GET",
    path: "/legal-body-orders/ord_1",
    body: undefined,
    answer: () => json(200, RESERVED),
    result: RESERVED,
  },
  {
    name: "getLegalBodyAgreement",
    call: (c) => c.getLegalBodyAgreement(TOKEN, "ord_1"),
    method: "GET",
    path: "/legal-body-orders/ord_1/agreement",
    body: undefined,
    answer: () => json(200, AGREEMENT),
    result: AGREEMENT,
  },
  {
    name: "abandonLegalBodyOrder",
    call: (c) => c.abandonLegalBodyOrder(TOKEN, "ord_1"),
    method: "POST",
    path: "/legal-body-orders/ord_1/abandon",
    body: undefined,
    answer: () => json(200, view({ state: "abandoned" })),
    result: view({ state: "abandoned" }),
  },
  {
    name: "requestLinkMessage with a lifetime",
    call: (c) => c.requestLinkMessage(TOKEN, "ord_1", { agentId: AGENT, ttlSeconds: 21_600 }),
    method: "POST",
    path: "/legal-body-orders/ord_1/link-message",
    body: { agentId: AGENT, ttlSeconds: 21_600 },
    answer: () => json(200, LINK_MESSAGE_ANSWER),
    result: LINK_MESSAGE_ANSWER,
  },
  {
    name: "requestLinkMessage without one",
    call: (c) => c.requestLinkMessage(TOKEN, "ord_1", { agentId: AGENT }),
    method: "POST",
    path: "/legal-body-orders/ord_1/link-message",
    body: { agentId: AGENT },
    answer: () => json(200, LINK_MESSAGE_ANSWER),
    result: LINK_MESSAGE_ANSWER,
  },
  {
    name: "submitLink",
    call: (c) => c.submitLink(TOKEN, "ord_1", { message: LINK_MESSAGE, signature: SIGNATURE }),
    method: "POST",
    path: "/legal-body-orders/ord_1/link",
    body: { message: LINK_MESSAGE, signature: SIGNATURE },
    answer: () => json(200, DEPLOYED),
    result: { status: 200, body: DEPLOYED },
  },
  {
    name: "getBinding",
    call: (c) => c.getBinding(TOKEN, "ord_1"),
    method: "GET",
    path: "/legal-body-orders/ord_1/binding",
    body: undefined,
    answer: () => json(200, BINDING),
    result: BINDING,
  },
  {
    name: "refreshBinding",
    call: (c) => c.refreshBinding(TOKEN, "ord_1"),
    method: "POST",
    path: "/legal-body-orders/ord_1/binding/refresh",
    body: undefined,
    answer: () => json(200, BINDING),
    result: BINDING,
  },
  {
    name: "requestGasSeed",
    call: (c) => c.requestGasSeed(TOKEN, "ord_1"),
    method: "POST",
    path: "/legal-body-orders/ord_1/gas-seed",
    body: undefined,
    answer: () => json(200, { status: "sent", txHash: TX_HASH }),
    result: { status: "sent", txHash: TX_HASH },
  },
];

describe("the authenticated doors go through API_URL with the bearer token", () => {
  test.each(DOORS)("$name: $method $path", async (door) => {
    const { API_URL, calls } = await load();
    const seen = stubFetch(door.answer);

    await expect(door.call(calls)).resolves.toEqual(door.result);

    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request!.url).toBe(`${API_URL}${door.path}`);
    expect(request!.init.method).toBe(door.method);
    const headers = headersOf(request!);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(bodyOf(request!)).toEqual(door.body);
    // A JSON content type only where there is JSON to read.
    expect(headers.get("content-type")).toBe(door.body === undefined ? null : "application/json");
  });

  test("the doors are not the public origin", async () => {
    const { API_URL, PUBLIC_API_ORIGIN } = await load();
    expect(PUBLIC_API_ORIGIN).toBe(PUBLIC_ORIGIN);
    expect(API_URL).not.toBe(PUBLIC_API_ORIGIN);
  });

  test("an id is encoded into its path segment", async () => {
    const { API_URL, calls } = await load();
    const seen = stubFetch(() => json(200, view()));
    await calls.getLegalBodyOrder(TOKEN, "ord/1?x");
    expect(seen[0]!.url).toBe(`${API_URL}/legal-body-orders/ord%2F1%3Fx`);
  });

  test("a refusal in the house envelope is an ApiError with its code", async () => {
    const { calls, ApiError } = await load();
    stubFetch(() =>
      json(403, { error: { code: "real_human_required", message: "A verified human is needed." } }),
    );
    const err = await calls.listLegalBodyOrders(TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe("real_human_required");
    expect((err as InstanceType<typeof ApiError>).status).toBe(403);
  });
});

describe("submitLink reads the link door's own answers", () => {
  const submit = (c: Calls) =>
    c.submitLink(TOKEN, "ord_1", { message: LINK_MESSAGE, signature: SIGNATURE });

  test("a 200 is the order as the door left it", async () => {
    const { calls } = await load();
    stubFetch(() => json(200, DEPLOYED));
    await expect(submit(calls)).resolves.toEqual({ status: 200, body: DEPLOYED });
  });

  test("a 202 keeps the order's state: reserved while the create is not confirmed", async () => {
    const { calls } = await load();
    stubFetch(() => json(202, RESERVED));
    const answer = await submit(calls);
    expect(answer).toEqual({ status: 202, body: RESERVED });
    expect(answer.status === 202 && answer.body.state).toBe("reserved");
  });

  test("a flat 422 is an answer, with the order it carries", async () => {
    const { calls } = await load();
    const refusal: LinkRefusal = {
      code: "bad_signature",
      message: "The signature does not match the identity's owner.",
      detail: {},
      order: view(),
    };
    stubFetch(() => json(422, refusal));
    await expect(submit(calls)).resolves.toEqual({ status: 422, body: refusal });
  });

  test("a 422 in the house envelope is an ApiError with its code, not a refusal", async () => {
    const { calls, ApiError } = await load();
    stubFetch(() =>
      json(422, { error: { code: "validation_error", message: "The body is not valid." } }),
    );
    const err = await submit(calls).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe("validation_error");
    expect((err as InstanceType<typeof ApiError>).status).toBe(422);
  });

  test("a 409 in the house envelope is an ApiError with code order_expired", async () => {
    const { calls, ApiError } = await load();
    stubFetch(() =>
      json(409, { error: { code: "order_expired", message: "This order has expired." } }),
    );
    const err = await submit(calls).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe("order_expired");
    expect((err as InstanceType<typeof ApiError>).status).toBe(409);
  });

  test("a 429 is an ApiError with code rate_limited", async () => {
    const { calls, ApiError } = await load();
    stubFetch(() =>
      json(429, { error: { code: "rate_limited", message: "Too many requests. Try again soon." } }),
    );
    const err = await submit(calls).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe("rate_limited");
    expect((err as InstanceType<typeof ApiError>).status).toBe(429);
  });

  test("only the message and the signature leave", async () => {
    const { calls } = await load();
    const seen = stubFetch(() => json(200, DEPLOYED));
    const extra = { message: LINK_MESSAGE, signature: SIGNATURE, ttlSeconds: 600 };
    await calls.submitLink(TOKEN, "ord_1", extra);
    expect(bodyOf(seen[0]!)).toEqual({ message: LINK_MESSAGE, signature: SIGNATURE });
  });
});

describe("getLegalBodyByAgent reads the public origin and never answers a negative it did not get", () => {
  const NO_BODY: LegalBodyByAgent = {
    agentId: AGENT,
    legalBody: false,
    standing: null,
    checkedAt: "2026-10-15T09:00:00.000Z",
  };

  test("it asks the API's own origin, with no header at all", async () => {
    const { PUBLIC_API_ORIGIN, calls } = await load();
    const seen = stubFetch(() => json(200, NO_BODY));
    await calls.getLegalBodyByAgent(AGENT);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${PUBLIC_API_ORIGIN}/legal-bodies/by-agent/897126`);
    expect(seen[0]!.url).toBe("https://api.example.test/legal-bodies/by-agent/897126");
    expect(seen[0]!.init.method).toBe("GET");
    expect(headersOf(seen[0]!).get("authorization")).toBeNull();
    expect([...headersOf(seen[0]!).keys()]).toEqual([]);
  });

  test("a 200 is the answer, as served", async () => {
    const { calls } = await load();
    stubFetch(() => json(200, NO_BODY));
    const read: PublicRead<LegalBodyByAgent> = await calls.getLegalBodyByAgent(AGENT);
    expect(read).toEqual({ kind: "answer", body: NO_BODY });
  });

  test.each([
    [429, "rate_limited"],
    [503, "unavailable"],
    [400, "validation_error"],
  ] as const)("a flat %i is could_not_check: %s", async (status, error) => {
    const { calls } = await load();
    stubFetch(() => json(status, { error, message: "A sentence." }));
    await expect(calls.getLegalBodyByAgent(AGENT)).resolves.toEqual({
      kind: "could_not_check",
      reason: error,
    });
  });

  test("a fetch that throws is could_not_check: network", async () => {
    const { calls } = await load();
    stubFetchThrowing(new TypeError("fetch failed"));
    await expect(calls.getLegalBodyByAgent(AGENT)).resolves.toEqual({
      kind: "could_not_check",
      reason: "network",
    });
  });

  test("a request the runtime timed out is could_not_check: timeout", async () => {
    const { calls } = await load();
    stubFetchThrowing(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(calls.getLegalBodyByAgent(AGENT)).resolves.toEqual({
      kind: "could_not_check",
      reason: "timeout",
    });
  });

  test.each([
    ["a 404 in the house envelope", () => json(404, { error: { code: "not_found", message: "x" } })],
    ["a 500 with an error string it does not know", () => json(500, { error: "internal_error" })],
    ["a 200 that is not JSON", () => new Response("<html></html>", { status: 200 })],
    ["a 200 that is not a record", () => json(200, { agentId: AGENT })],
    ["a 200 shaped like a refusal", () => json(200, { error: "rate_limited", message: "x" })],
    ["a 204", () => new Response(null, { status: 204 })],
  ])("%s is could_not_check: malformed", async (_name, answer) => {
    const { calls } = await load();
    stubFetch(answer);
    await expect(calls.getLegalBodyByAgent(AGENT)).resolves.toEqual({
      kind: "could_not_check",
      reason: "malformed",
    });
  });
});

describe("getTransparency reads the public origin", () => {
  const PAGE = { stats: {} } as unknown as TransparencyView;

  test("it asks the API's own origin, with no authorization header", async () => {
    const { PUBLIC_API_ORIGIN, client } = await load();
    const seen = stubFetch(() => json(200, PAGE));
    await expect(client.getTransparency()).resolves.toEqual(PAGE);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${PUBLIC_API_ORIGIN}/transparency`);
    expect(seen[0]!.url).toBe("https://api.example.test/transparency");
    expect(headersOf(seen[0]!).get("authorization")).toBeNull();
  });

  test("a failure still throws, so the page's one catch still shows it", async () => {
    const { client, ApiError } = await load();
    stubFetch(() => json(503, { error: { code: "unavailable", message: "Try again." } }));
    const err = await client.getTransparency().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(503);
  });
});

describe("the query keys", () => {
  test("the order, agreement and binding keys are scoped to the session's token", () => {
    const keys = [
      (t: string) => apiKeys.legalBodyOrders(t),
      (t: string) => apiKeys.legalBodyOrder(t, "ord_1"),
      (t: string) => apiKeys.legalBodyAgreement(t, "ord_1"),
      (t: string) => apiKeys.legalBodyBinding(t, "ord_1"),
    ];
    for (const key of keys) {
      expect(key("token-a")).toContain("token-a");
      expect(key("token-a")).not.toEqual(key("token-b"));
    }
  });

  test("the two public reads carry no token, and each key names one thing", () => {
    expect(apiKeys.legalBodyByAgent(AGENT)).toEqual(["api", "legalBodyByAgent", AGENT]);
    expect(apiKeys.transparency()).toEqual(["api", "transparency"]);
    const all = [
      apiKeys.legalBodyOrders(TOKEN),
      apiKeys.legalBodyOrder(TOKEN, "ord_1"),
      apiKeys.legalBodyAgreement(TOKEN, "ord_1"),
      apiKeys.legalBodyBinding(TOKEN, "ord_1"),
      apiKeys.legalBodyByAgent(AGENT),
      apiKeys.transparency(),
    ].map((k) => k[1]);
    expect(new Set(all).size).toBe(all.length);
  });
});
