import { describe, expect, test } from "vitest";
import { createLegalBodyAgentBook } from "../../src/payments/legalBodyAgentBook";

const ADDRESS = "0xeE85Fd00521d1Aa4c510BDdAb78F375830119354";
const HUMAN = "0x51db";
const BASE = "https://api.novicorpus.com";

/** A minimal stand-in for the AgentBook verifier (`{ lookupHuman }`), with a call counter so no
 *  test can pass vacuously by never reaching the reader. */
function agentBook(script: (address: string) => Promise<string | null>) {
  let calls = 0;
  return {
    calls: () => calls,
    lookupHuman: async (address: string) => {
      calls++;
      return script(address);
    },
  };
}

type FetchCall = { url: string; init: RequestInit | undefined };

/** A fake `fetch` recording every call. `script` returns whatever the checker should see. */
function fakeFetch(script: (call: FetchCall) => Promise<unknown>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return script(call);
  }) as unknown as typeof fetch;
  return Object.assign(impl, { calls: () => calls });
}

/** A fake `Response`: only `status` and `json()` are ever touched by the checker. */
function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const activeBody = {
  address: ADDRESS,
  legalBody: true,
  standing: "active",
  agentId: 843704,
  publicId: "pub-1",
  name: "TestMB2",
  network: "testnet",
  links: { transparency: "https://www.novicorpus.com/transparency" },
  formation: { filed: false },
  checkedAt: "2026-09-10T00:00:00.000Z",
};

function checker(over: {
  book?: ReturnType<typeof agentBook>;
  fetchImpl?: ReturnType<typeof fakeFetch>;
  lookupBaseUrl?: string;
  timeoutMs?: number;
}) {
  const book = over.book ?? agentBook(async () => HUMAN);
  const fetchImpl = over.fetchImpl ?? fakeFetch(async () => res(200, activeBody));
  const subject = createLegalBodyAgentBook({
    agentBook: book,
    lookupBaseUrl: over.lookupBaseUrl ?? BASE,
    fetch: fetchImpl,
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
  });
  return { subject, book, fetchImpl };
}

describe("createLegalBodyAgentBook", () => {
  test("both questions answered yes -> the human id", async () => {
    const { subject, book, fetchImpl } = checker({});
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBe(HUMAN);
    expect(book.calls()).toBe(1);
    expect(fetchImpl.calls().length).toBe(1);
  });

  test("no human -> null, and the lookup is never called", async () => {
    const book = agentBook(async () => null);
    const { subject, fetchImpl } = checker({ book });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
    expect(book.calls()).toBe(1);
    expect(fetchImpl.calls().length).toBe(0);
  });

  test("AgentBook throws -> null, and the lookup is never called", async () => {
    const book = agentBook(async () => {
      throw new Error("world chain rpc down");
    });
    const { subject, fetchImpl } = checker({ book });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
    expect(fetchImpl.calls().length).toBe(0);
  });

  test("200 with a legal body in good standing -> the human id", async () => {
    const fetchImpl = fakeFetch(async () => res(200, { ...activeBody, standing: "active" }));
    const { subject } = checker({ fetchImpl });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBe(HUMAN);
  });

  test("200 but the body is inactive -> null", async () => {
    const fetchImpl = fakeFetch(async () => res(200, { ...activeBody, standing: "inactive" }));
    const { subject } = checker({ fetchImpl });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
  });

  test("200 but standing is unknown -> null (a failed read is never a yes)", async () => {
    const fetchImpl = fakeFetch(async () => res(200, { ...activeBody, standing: "unknown" }));
    const { subject } = checker({ fetchImpl });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
  });

  test("200 for an address with no legal body -> null", async () => {
    const fetchImpl = fakeFetch(async () =>
      res(200, { address: ADDRESS, legalBody: false, standing: null, checkedAt: "2026-09-10T…Z" }),
    );
    const { subject } = checker({ fetchImpl });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
  });

  test("200 with legalBody false but standing active -> null (both fields must agree)", async () => {
    const fetchImpl = fakeFetch(async () => res(200, { ...activeBody, legalBody: false }));
    const { subject } = checker({ fetchImpl });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
  });

  test("200 with a body that is not the contract at all -> null", async () => {
    for (const body of [null, "active", 7, [], { legalBody: "true", standing: "active" }, {}]) {
      const fetchImpl = fakeFetch(async () => res(200, body));
      const { subject } = checker({ fetchImpl });
      await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
    }
  });

  test("404, 400 and 500 -> null", async () => {
    for (const status of [400, 404, 500, 503, 301, 204]) {
      const fetchImpl = fakeFetch(async () => res(status, activeBody));
      const { subject } = checker({ fetchImpl });
      await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
    }
  });

  test("malformed JSON -> null", async () => {
    const fetchImpl = fakeFetch(
      async () =>
        ({
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          },
        }) as unknown as Response,
    );
    const { subject } = checker({ fetchImpl });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
  });

  test("a network error -> null", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const { subject } = checker({ fetchImpl });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
  });

  test("a lookup that never answers -> null once the timeout elapses, and it is aborted", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = fakeFetch((call) => {
      signal = call.init?.signal ?? undefined;
      return new Promise<never>(() => {
        /* never settles, and never observes the signal either */
      });
    });
    const { subject } = checker({ fetchImpl, timeoutMs: 5 });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  test("the request is a GET for the contract url, JSON, with the address encoded", async () => {
    const fetchImpl = fakeFetch(async () => res(200, activeBody));
    const { subject } = checker({ fetchImpl });
    await subject.lookupHuman(ADDRESS);
    const call = fetchImpl.calls()[0];
    expect(call?.url).toBe(`${BASE}/legal-bodies/${ADDRESS}`);
    expect(call?.init?.method ?? "GET").toBe("GET");
    expect(new Headers(call?.init?.headers).get("accept")).toBe("application/json");
  });

  test("a base url with a trailing slash does not produce a double slash", async () => {
    const fetchImpl = fakeFetch(async () => res(200, activeBody));
    const { subject } = checker({ fetchImpl, lookupBaseUrl: `${BASE}/` });
    await subject.lookupHuman(ADDRESS);
    expect(fetchImpl.calls()[0]?.url).toBe(`${BASE}/legal-bodies/${ADDRESS}`);
  });

  test("a hostile 'address' is URL-encoded, never pasted into the path", async () => {
    const fetchImpl = fakeFetch(async () => res(200, activeBody));
    const { subject } = checker({ fetchImpl });
    await subject.lookupHuman("../admin?x=1 #2");
    expect(fetchImpl.calls()[0]?.url).toBe(
      `${BASE}/legal-bodies/${encodeURIComponent("../admin?x=1 #2")}`,
    );
  });

  test("never throws, whatever the two reads do", async () => {
    const book = agentBook(async () => {
      throw "not even an Error";
    });
    const { subject } = checker({ book });
    await expect(subject.lookupHuman(ADDRESS)).resolves.toBeNull();
  });
});
