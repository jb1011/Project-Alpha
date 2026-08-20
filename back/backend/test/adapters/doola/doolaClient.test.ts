/**
 * doola client contract (design §2/§5). Four properties are load-bearing enough to pin here:
 *  1. the API key rides RAW in Authorization — a "Bearer " prefix 401s every call;
 *  2. Idempotency-Key goes on the two CREATE endpoints and NOWHERE else (doola honors it nowhere
 *     else — sending it elsewhere would imply crash safety that does not exist);
 *  3. their error envelope maps to a typed error carrying code + requestId, with validation
 *     distinguishable from internal WITHOUT string-sniffing;
 *  4. the base URL comes from the environment, and the playground calls refuse production.
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

/** A fetch fake that records every call and replies with a queued response. */
function fakeFetch(responses: { status: number; body?: unknown; text?: string }[]): {
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
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => text,
    } as Response;
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

test("list reads unwrap doola's payload envelope and tolerate an empty body", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 200, body: { payload: [{ id: "doc_1", type: "OperatingAgreement" }] } },
    { status: 200, text: "" },
  ]);
  const api = buildDoolaApi({
    apiKey: "dk",
    baseUrl: "https://doola.test",
    environment: "sandbox",
    fetchImpl,
  });
  expect(await api.listDocuments("cmp_1")).toEqual([{ id: "doc_1", type: "OperatingAgreement" }]);
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
