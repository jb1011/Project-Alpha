/**
 * doola client contract (design §2/§5). Six properties are load-bearing enough to pin here:
 *  1. the API key rides RAW in Authorization — a "Bearer " prefix 401s every call;
 *  2. Idempotency-Key goes on the two CREATE endpoints and NOWHERE else (doola honors it nowhere
 *     else — sending it elsewhere would imply crash safety that does not exist);
 *  3. their error envelope maps to a typed error carrying code + requestId, with validation
 *     distinguishable from internal WITHOUT string-sniffing;
 *  4. the base URL comes from the environment, and the playground calls refuse production;
 *  5. the deadline covers the BODY READ and aborts the request (review A1);
 *  6. bodies are size-capped, and a 2xx that is not a `{payload}` envelope is an ERROR, never a
 *     silently-resolved `undefined` (review A2/A3).
 *
 * The fakes below build NATIVE `Response` objects (the sibling fetch fakes' convention, e.g.
 * test/payments/buyer.test.ts): a cast object cannot exercise `res.body`, `res.headers` or the
 * streaming read the client actually performs, so a hand-rolled stub would pin a client that
 * does not exist.
 */
import { expect, test, vi } from "vitest";
import { DoolaApiError, buildDoolaApi } from "../../../src/adapters/doola/doolaClient";
import { DOOLA_BASE_URLS } from "../../../src/config/env";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface FakeResponse {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** A fetch fake that records every call and replies with a queued NATIVE Response. */
function fakeFetch(responses: FakeResponse[]): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const r = responses[Math.min(i++, responses.length - 1)] ?? { status: 200 };
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, { status: r.status, headers: r.headers });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const CUSTOMER = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  address: {
    line1: "1 Analytical Way",
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
  },
};

test("the API key is sent RAW in Authorization — never with a Bearer prefix", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { payload: { id: "cus_1" } } }]);
  const api = buildDoolaApi({
    apiKey: "dk_test_abc",
    baseUrl: DOOLA_BASE_URLS.sandbox,
    environment: "sandbox",
    fetchImpl,
  });
  await api.createCustomer(CUSTOMER, "formation:e1:create_provider:0");
  expect(calls[0]!.headers.Authorization).toBe("dk_test_abc");
  expect(calls[0]!.headers.Authorization).not.toMatch(/^Bearer /);
});

test("Idempotency-Key is set on the two CREATE endpoints and on NOTHING else", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { payload: {} } }]);
  const api = buildDoolaApi({
    apiKey: "dk_test",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });

  await api.createCustomer(CUSTOMER, "key-customer");
  await api.createCompany(
    { customerId: "cus_1", nameOptions: ["Novi Agent LLC"], entityType: "LLC", state: "WY" },
    "key-company",
  );
  await api.getCompany("cmp_1");
  await api.listDocuments("cmp_1");
  await api.getDocumentDownloadUrl("cmp_1", "doc_1");
  await api.listRequiredActions("cmp_1");
  await api.getComplianceCalendar("cmp_1");
  await api.playgroundCompleteFormation("cmp_1");
  await api.playgroundCompleteEin("cmp_1");

  const withKey = calls.filter((c) => c.headers["Idempotency-Key"] !== undefined);
  expect(withKey.map((c) => c.url)).toEqual([
    "https://doola.test/customers",
    "https://doola.test/companies",
  ]);
  expect(withKey.map((c) => c.headers["Idempotency-Key"])).toEqual(["key-customer", "key-company"]);
  expect(calls).toHaveLength(9);
});

test("request shape: creates POST JSON, reads GET, ISO-3 country and 2-letter state survive", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { payload: { id: "cmp_1" } } }]);
  const api = buildDoolaApi({
    apiKey: "dk_test",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  await api.createCustomer(CUSTOMER, "k");
  const sent = JSON.parse(calls[0]!.body!);
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
  expect(sent.address.country).toBe("USA"); // alpha-3, not "US"
  expect(sent.address.region).toBe("WY"); // 2-letter state

  await api.getCompany("cmp_1");
  expect(calls[1]!.method).toBe("GET");
  expect(calls[1]!.body).toBeUndefined();
  expect(calls[1]!.headers["Content-Type"]).toBeUndefined();
});

test("errors map to DoolaApiError carrying code + requestId; validation != internal", async () => {
  const validation = fakeFetch([
    {
      status: 422,
      body: {
        error: {
          code: "E_VALIDATION_FAILED",
          message: "nameOptions is required",
          fields: { nameOptions: "required" },
          requestId: "req_abc123",
        },
        payload: null,
      },
    },
  ]);
  const api = buildDoolaApi({
    apiKey: "dk_test",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl: validation.fetchImpl,
  });
  const err = (await api
    .createCompany({ customerId: "c", nameOptions: [], entityType: "LLC", state: "WY" }, "k")
    .catch((e) => e)) as DoolaApiError;
  expect(err).toBeInstanceOf(DoolaApiError);
  expect(err.code).toBe("E_VALIDATION_FAILED");
  expect(err.status).toBe(422);
  expect(err.requestId).toBe("req_abc123"); // the first thing doola support asks for
  expect(err.fields).toEqual({ nameOptions: "required" });
  expect(err.isValidation).toBe(true);
  expect(err.isInternal).toBe(false); // a bad body must never be retried as a transient blip

  const internal = fakeFetch([
    { status: 500, body: { error: { code: "E_INTERNAL", message: "boom", requestId: "req_z" } } },
  ]);
  const api2 = buildDoolaApi({
    apiKey: "dk_test",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl: internal.fetchImpl,
  });
  const err2 = (await api2.getCompany("cmp_1").catch((e) => e)) as DoolaApiError;
  expect([err2.isInternal, err2.isValidation]).toEqual([true, false]);
});

test("a reused idempotency key with a different body is its own, non-retryable error", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 409, body: { error: { code: "E_IDEMPOTENCY_KEY_REUSED", message: "reused" } } },
  ]);
  const api = buildDoolaApi({
    apiKey: "dk_test",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  const err = (await api.createCustomer(CUSTOMER, "k").catch((e) => e)) as DoolaApiError;
  expect(err.isIdempotencyConflict).toBe(true);
  expect(err.isInternal).toBe(false);
});

test("a non-JSON failure body (proxy HTML) still surfaces as a typed doola error", async () => {
  const { fetchImpl } = fakeFetch([{ status: 502, text: "<html>Bad Gateway</html>" }]);
  const api = buildDoolaApi({
    apiKey: "dk_test",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  const err = (await api.getCompany("cmp_1").catch((e) => e)) as DoolaApiError;
  expect(err).toBeInstanceOf(DoolaApiError);
  expect(err.code).toBe("E_UNKNOWN");
  expect(err.status).toBe(502);
  expect(err.message).toMatch(/HTTP 502/);
});

test("the base URL comes from the environment, and an explicit override wins", async () => {
  for (const [environment, host] of [
    ["sandbox", DOOLA_BASE_URLS.sandbox],
    ["production", DOOLA_BASE_URLS.production],
  ] as const) {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { payload: {} } }]);
    const api = buildDoolaApi({ apiKey: "dk", baseUrl: host, environment, fetchImpl });
    await api.getCompany("cmp_1");
    expect(calls[0]!.url).toBe(`${host}/companies/cmp_1`);
  }
  // A trailing slash on the configured host must not produce a double slash in the path.
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { payload: {} } }]);
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test/",
    environment: "sandbox",
    fetchImpl,
  });
  await api.getCompany("cmp_1");
  expect(calls[0]!.url).toBe("https://doola.test/companies/cmp_1");
});

test("playground calls are SANDBOX-ONLY and refuse a production-pinned client", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200 }]);
  const api = buildDoolaApi({
    apiKey: "dk_live",
    baseUrl: DOOLA_BASE_URLS.production,
    environment: "production",
    fetchImpl,
  });
  await expect(api.playgroundCompleteFormation("cmp_1")).rejects.toThrow(/SANDBOX-ONLY/);
  await expect(api.playgroundCompleteEin("cmp_1")).rejects.toThrow(/SANDBOX-ONLY/);
  expect(calls).toHaveLength(0); // refused BEFORE any network call
});

test("list reads unwrap doola's payload envelope; a null payload is an empty list", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 200, body: { payload: [{ id: "doc_1", type: "OperatingAgreement" }] } },
    { status: 200, body: { payload: null } },
  ]);
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  expect(await api.listDocuments("cmp_1")).toEqual([{ id: "doc_1", type: "OperatingAgreement" }]);
  // `payload: null` is doola saying "nothing yet" — an ENVELOPE with no content, which is a
  // different thing from a body with no envelope (that one throws, below).
  expect(await api.listRequiredActions("cmp_1")).toEqual([]);
});

test("every call is deadline-bounded — a hung socket cannot wedge the entity lock", async () => {
  const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    timeoutMs: 20,
    fetchImpl: hang,
  });
  await expect(api.getCompany("cmp_1")).rejects.toThrow(/did not respond within 20ms/);
});

// ── A1: the deadline covers the BODY READ, and it aborts ────────────────────────────────────

test("A1: a response whose BODY never resolves still times out, and the signal is ABORTED", async () => {
  // The realistic hang: headers arrive fast, the body stalls forever. A deadline wrapped around
  // `fetch` alone has already resolved by then and would wait on the read with no bound at all —
  // while the caller holds the per-entity lock.
  let seen: AbortSignal | undefined;
  const stalledBody = new ReadableStream<Uint8Array>({
    start() {
      /* never enqueues, never closes */
    },
  });
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    seen = init?.signal ?? undefined;
    return new Response(stalledBody, { status: 200 });
  }) as unknown as typeof fetch;

  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    timeoutMs: 20,
    fetchImpl,
  });
  await expect(api.getCompany("cmp_1")).rejects.toThrow(/did not respond within 20ms/);
  // The rejection is what the caller sees; the abort is what frees the socket.
  expect(seen?.aborted).toBe(true);
});

// ── A2: the response size cap, both enforcement paths ───────────────────────────────────────

test("A2: a declared Content-Length over 4 MiB is refused before a byte is buffered", async () => {
  const { fetchImpl } = fakeFetch([
    {
      status: 200,
      body: { payload: { id: "cmp_1" } },
      headers: { "content-length": String(4 * 1024 * 1024 + 1) },
    },
  ]);
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  const err = (await api.getCompany("cmp_1").catch((e) => e)) as DoolaApiError;
  expect(err).toBeInstanceOf(DoolaApiError);
  expect(err.code).toBe("E_RESPONSE_TOO_LARGE");
});

test("A2: a CHUNKED body that lies about its length is cut off by the running byte counter", async () => {
  // No content-length at all (or a small one) is the normal chunked case — the header check is
  // simply absent, so the stream counter is the only thing standing between this process and an
  // unbounded allocation.
  // 256 KiB per chunk; the stream would happily emit 400 of them (100 MiB) if nothing stopped it.
  const chunk = new Uint8Array(256 * 1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 400) return controller.close();
      sent += 1;
      controller.enqueue(chunk);
    },
  });
  const fetchImpl = vi.fn(
    async () => new Response(stream, { status: 200, headers: { "content-length": "12" } }),
  ) as unknown as typeof fetch;
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  const err = (await api.getCompany("cmp_1").catch((e) => e)) as DoolaApiError;
  expect(err).toBeInstanceOf(DoolaApiError);
  expect(err.code).toBe("E_RESPONSE_TOO_LARGE");
  // ~17 chunks reach the cap; the point is that it stopped there instead of draining 100 MiB.
  expect(sent).toBeLessThan(100);
});

test("A2: a normal-sized body is unaffected by the cap", async () => {
  const { fetchImpl } = fakeFetch([{ status: 200, body: { payload: { id: "cmp_1" } } }]);
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  expect(await api.getCompany("cmp_1")).toEqual({ id: "cmp_1" });
});

// ── A3: a 2xx that is not an envelope is an ERROR, never `undefined` ────────────────────────

test("A3: a 2xx with an empty / non-JSON / envelope-less body throws E_BAD_RESPONSE", async () => {
  const cases: { name: string; res: FakeResponse }[] = [
    { name: "empty", res: { status: 200, text: "" } },
    { name: "html from a proxy", res: { status: 200, text: "<html>ok</html>" } },
    { name: "no payload key", res: { status: 200, body: { id: "cmp_1" } } },
  ];
  for (const c of cases) {
    const { fetchImpl } = fakeFetch([c.res]);
    const api = buildDoolaApi({
      apiKey: "dk",
      baseUrl: "https://doola.test",
      environment: "sandbox",
      fetchImpl,
    });
    const err = (await api.getCompany("cmp_1").catch((e) => e)) as DoolaApiError;
    expect(err, c.name).toBeInstanceOf(DoolaApiError);
    expect(err.code, c.name).toBe("E_BAD_RESPONSE");
    expect(err.status, c.name).toBe(200);
  }
});

test("A3: E_BAD_RESPONSE carries the requestId when the response has one", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 200, text: "<html>stripped by a CDN</html>", headers: { "x-request-id": "req_cdn" } },
  ]);
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  const err = (await api.getCompany("cmp_1").catch((e) => e)) as DoolaApiError;
  expect(err.requestId).toBe("req_cdn"); // the first thing doola support asks for
});

test("A3: no read EVER resolves undefined — the whole point of the envelope check", async () => {
  const { fetchImpl } = fakeFetch([{ status: 200, text: "" }]);
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  // A stripped 200 must never read as "there is no such company" — that is how a live formation
  // silently becomes a hole in the DB.
  await expect(api.getCompany("cmp_1")).rejects.toThrow(DoolaApiError);
  await expect(api.listDocuments("cmp_1")).rejects.toThrow(DoolaApiError);
  await expect(api.getDocumentDownloadUrl("cmp_1", "doc_1")).rejects.toThrow(DoolaApiError);
});

test("A3: the VOID playground calls still accept an empty 2xx body", async () => {
  // They return nothing by contract, so there is no payload to demand.
  const { fetchImpl, calls } = fakeFetch([{ status: 200, text: "" }]);
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  await expect(api.playgroundCompleteFormation("cmp_1")).resolves.toBeUndefined();
  await expect(api.playgroundCompleteEin("cmp_1")).resolves.toBeUndefined();
  expect(calls).toHaveLength(2);
});
