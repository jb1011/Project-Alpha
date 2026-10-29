/**
 * The pilot's legal-body lookup client: one GET to the public by-agent route, bounded by a
 * deadline, and the three answers it can return read the same way the pre-flight reads them.
 */
import { afterEach, expect, test, vi } from "vitest";
import type { ByAgentAnswer } from "../../src/api/routes/legalBodyStatements";
import type { SignedStatementJson } from "../../src/legalBody/publicStatement";
import { activeLegalName, httpLookupClient } from "../../src/pilot/lookup";

const BASE = "https://api.example.com";

const none: ByAgentAnswer = {
  agentId: "12",
  legalBody: false,
  standing: null,
  checkedAt: "2026-10-28T00:00:00.000Z",
};
const unknown: ByAgentAnswer = {
  agentId: "12",
  legalBody: true,
  standing: "unknown",
  publicId: null,
  network: "testnet",
  links: { transparency: `${BASE}/transparency` },
  checkedAt: "2026-10-28T00:00:00.000Z",
  statement: null,
};
const active: ByAgentAnswer = {
  agentId: "12",
  legalBody: true,
  standing: "active",
  publicId: "nc_abc",
  network: "testnet",
  links: { transparency: `${BASE}/transparency`, statement: `${BASE}/statement` },
  checkedAt: "2026-10-28T00:00:00.000Z",
  statement: { message: { legalName: "Buyer Agent DAO LLC" } } as unknown as SignedStatementJson,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.useRealTimers();
});

test("GETs <base>/legal-bodies/by-agent/<id> with an abort signal", async () => {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse(active),
  );
  const answer = await httpLookupClient(BASE, fetchImpl as unknown as typeof fetch).byAgent("12");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe(`${BASE}/legal-bodies/by-agent/12`);
  expect(init?.method ?? "GET").toBe("GET");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(answer).toEqual(active);
});

test("a base with a trailing slash does not double the slash", async () => {
  const fetchImpl = vi.fn(async () => jsonResponse(none));
  await httpLookupClient(`${BASE}/`, fetchImpl as unknown as typeof fetch).byAgent("12");
  expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(
    `${BASE}/legal-bodies/by-agent/12`,
  );
});

test("the call is bounded at 15 seconds and the request is aborted", async () => {
  vi.useFakeTimers();
  let seen: AbortSignal | undefined;
  const fetchImpl = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>(() => {
        seen = init?.signal ?? undefined;
      }),
  );
  const pending = httpLookupClient(BASE, fetchImpl as unknown as typeof fetch).byAgent("12");
  const outcome = expect(pending).rejects.toThrow(/15 s|15000|15 seconds/);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(seen?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await outcome;
  expect(seen?.aborted).toBe(true);
});

test.each([404, 429, 500, 503])("a %i answer throws, naming the status", async (status) => {
  const fetchImpl = vi.fn(async () => jsonResponse({ error: "x" }, status));
  await expect(
    httpLookupClient(BASE, fetchImpl as unknown as typeof fetch).byAgent("12"),
  ).rejects.toThrow(String(status));
});

test("the three answer kinds come back as sent, and only the active one names a body", async () => {
  for (const a of [none, unknown, active]) {
    const fetchImpl = vi.fn(async () => jsonResponse(a));
    expect(
      await httpLookupClient(BASE, fetchImpl as unknown as typeof fetch).byAgent("12"),
    ).toEqual(a);
  }
  expect(activeLegalName(none)).toBeUndefined();
  expect(activeLegalName(unknown)).toBeUndefined();
  expect(activeLegalName(active)).toEqual({ legalName: "Buyer Agent DAO LLC", standing: "active" });
});

test("activeLegalName returns the name and the standing whatever the standing is", () => {
  const pending = { ...active, standing: "pending" } as ByAgentAnswer;
  expect(activeLegalName(pending)).toEqual({
    legalName: "Buyer Agent DAO LLC",
    standing: "pending",
  });
});
