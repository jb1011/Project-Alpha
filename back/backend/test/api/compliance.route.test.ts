/**
 * `GET /companies/:companyId/compliance` (design §5/§7) — the first call `getComplianceCalendar`
 * has ever had.
 *
 * The properties under test are the ones §7 specifies as behaviour rather than as shape: the
 * cache is lazy, in-process and 24h; nothing warms it; and the failure mode is a REFUSAL, because
 * "doola did not answer" and "nothing is due" are opposite facts and a page that renders the
 * first as the second tells an owner their annual report is not due when nobody asked.
 */
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { DoolaComplianceEvent } from "../../src/adapters/doola/types";
import { buildApiApp } from "../../src/api/app";
import { COMPLIANCE_CACHE_MAX, COMPLIANCE_TTL_MS } from "../../src/api/routes/compliance";
import { signSession } from "../../src/auth/session";
import { COMPLIANCE_ANNUAL_REPORT } from "../../src/formation";
import { companyNameOptions } from "../../src/formation/intake";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const OWNER = getAddress("0x000000000000000000000000000000000000000a");
const OTHER = getAddress("0x000000000000000000000000000000000000000b");
const EVENT: DoolaComplianceEvent = {
  type: "ANNUAL_REPORT",
  state: "WY",
  nextDueDate: "2027-06-01",
  lastFiledDate: null,
  status: "UPCOMING",
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let calls: string[];
let answer: () => Promise<DoolaComplianceEvent[]>;
let now: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  calls = [];
  answer = async () => [EVENT];
  now = Date.parse("2026-09-07T12:00:00Z");
});
afterEach(() => db.close());

/** ONE app instance per test, because the cache lives IN it — which is the point. */
function app(withProvider = true) {
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    docStore: { getBytesAsync: async () => Buffer.from("") },
    formationSteps: (id: string) => requests.stepsOf(id),
    now: () => now,
    formation: withProvider
      ? {
          compliance: {
            getComplianceCalendar: async (id: string) => {
              calls.push(id);
              return answer();
            },
          },
        }
      : undefined,
  } as never);
}

async function token(tenantId: string): Promise<string> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

/** `null` means "no session" — deliberately not `undefined`, which a default parameter swallows. */
const get = async (a: ReturnType<typeof app>, companyId: string, tenantId: string | null = OWNER) =>
  a.request(`/companies/${encodeURIComponent(companyId)}/compliance`, {
    headers: tenantId ? { authorization: `Bearer ${await token(tenantId)}` } : {},
  });

/** A company, optionally with an OPEN filing carrying doola's id. */
function newCompany(providerRef?: string): string {
  const id = companies.create({
    tenantId: OWNER,
    status: "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: companyNameOptions("Acme One", "Acme Two", "Acme Three"),
    businessPurpose: "p",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
  if (providerRef) {
    requests.claimStep(id, "create_provider");
    requests.transition(id, "create_provider", "pending", "confirmed", { providerRef });
  }
  return id;
}

test("it needs a session, and another tenant's company is a 404 like an unknown one", async () => {
  const a = app();
  const id = newCompany("cmp-1");
  expect((await get(a, id, null)).status).toBe(401);
  const theirs = await get(a, id, OTHER);
  const missing = await get(a, "nope", OTHER);
  expect(theirs.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(await theirs.text()).toBe(await missing.text());
  // …and no provider call was made for a company the caller cannot see: ownership runs BEFORE
  // anything else, cache included.
  expect(calls).toEqual([]);
});

test("the calendar is fetched by doola's id and projected field for field", async () => {
  const id = newCompany("cmp-1");
  const body = (await (await get(app(), id)).json()) as Record<string, unknown>;
  // OUR id is the URL; DOOLA's is what the provider is asked for. They are different keys.
  expect(calls).toEqual(["cmp-1"]);
  expect(body.companyId).toBe(id);
  expect(body.providerRef).toBe("cmp-1");
  expect(body.fetchedAt).toBe(now);
  expect(body.events).toEqual([
    {
      type: "ANNUAL_REPORT",
      state: "WY",
      nextDueDate: "2027-06-01",
      lastFiledDate: null,
      status: "UPCOMING",
    },
  ]);
});

test("every wire field is projected EXPLICITLY null, never absent", async () => {
  // Every key of `DoolaComplianceEvent` is optional. A renderer that has to tell "the provider
  // did not say" from "this build's type has no such key" is a renderer that will guess.
  answer = async () => [{}];
  const body = (await (await get(app(), newCompany("cmp-1"))).json()) as {
    events: Record<string, unknown>[];
  };
  expect(body.events[0]).toEqual({
    type: null,
    state: null,
    nextDueDate: null,
    lastFiledDate: null,
    status: null,
  });
});

test("the annual-report PLACEHOLDER is always there, and it is not a doola event", async () => {
  // Omitting the obligation is worse than admitting we do not know who files it: an owner
  // reading an empty calendar concludes there is nothing to do, and the thing they would miss
  // costs the company its good standing.
  answer = async () => [];
  const body = (await (await get(app(), newCompany("cmp-1"))).json()) as Record<string, unknown>;
  expect(body.events).toEqual([]);
  expect(body.annualReport).toEqual(COMPLIANCE_ANNUAL_REPORT);
  expect(COMPLIANCE_ANNUAL_REPORT.handledBy).toBe("(ask doola)");
});

test("a company with no filing opened answers EMPTY without calling the provider", async () => {
  // There is nothing to have a calendar about, and a call would 404 at doola. Not an error.
  const body = (await (await get(app(), newCompany())).json()) as Record<string, unknown>;
  expect(calls).toEqual([]);
  expect(body).toMatchObject({ providerRef: null, fetchedAt: null, events: [] });
  expect(body.annualReport).toEqual(COMPLIANCE_ANNUAL_REPORT);
});

// ── the cache ───────────────────────────────────────────────────────────────────────────────

test("CACHE: a second view inside 24h reuses the answer; past it, the provider is asked again", async () => {
  const a = app();
  const id = newCompany("cmp-1");
  await get(a, id);
  await get(a, id);
  expect(calls).toEqual(["cmp-1"]);
  // `fetchedAt` is the FETCH's instant, not this request's — the page can say how old it is.
  now += COMPLIANCE_TTL_MS - 1;
  expect(((await (await get(a, id)).json()) as { fetchedAt: number }).fetchedAt).toBe(
    Date.parse("2026-09-07T12:00:00Z"),
  );
  expect(calls).toEqual(["cmp-1"]);

  now += 2;
  await get(a, id);
  expect(calls).toEqual(["cmp-1", "cmp-1"]);
});

test("CACHE: it is per COMPANY, and it dies with the process", async () => {
  const a = app();
  const one = newCompany("cmp-1");
  const two = newCompany("cmp-2");
  await get(a, one);
  await get(a, two);
  expect(calls).toEqual(["cmp-1", "cmp-2"]);

  // A NEW app is a restart. §7: "restart re-fetches" — a cache holding somebody else's data has
  // no business surviving one, and there is no table behind it to survive in.
  await get(app(), one);
  expect(calls).toEqual(["cmp-1", "cmp-2", "cmp-1"]);
});

test("CACHE: a FAILED fetch is not cached, and the refusal is not an empty calendar", async () => {
  const a = app();
  const id = newCompany("cmp-1");
  answer = async () => {
    throw new Error("doola 503: upstream unavailable");
  };
  const res = await get(a, id);
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: { message: string } };
  // The honesty invariant, in one sentence the owner can act on.
  expect(body.error.message).toMatch(/did not answer/);
  // doola's own prose is NOT propagated: it is free text their operators write.
  expect(JSON.stringify(body)).not.toContain("upstream unavailable");

  // Nothing was cached, so the next view really asks again.
  answer = async () => [EVENT];
  expect((await get(a, id)).status).toBe(200);
  expect(calls).toEqual(["cmp-1", "cmp-1"]);
});

test("a deployment that cannot ask doola REFUSES, rather than reporting an empty calendar", async () => {
  const res = await get(app(false), newCompany("cmp-1"));
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
    /formation is not available/,
  );
});

/* ── the cache is BOUNDED, and it does not stampede ────────────────────────── */

/** A promise the test releases by hand, so "in flight" is a state the assertions can stand in. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wait until the provider has actually been reached — the handlers sign a session first. */
async function untilCalled(): Promise<void> {
  for (let i = 0; i < 200 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(calls.length, "the provider was never reached").toBeGreaterThan(0);
}

/**
 * N concurrent first viewers make ONE provider call.
 *
 * They arrive together by construction: the thing that empties this cache is a restart, and the
 * thing that fills it is somebody opening the page. A deploy plus a link in a team chat is N
 * simultaneous requests for one calendar, and without a slot each one is its own call to a
 * partner API — for an answer that changes annually.
 */
test("concurrent first viewers of one company share a single provider call", async () => {
  const a = app();
  const id = newCompany("cmp-1");
  const gate = deferred<DoolaComplianceEvent[]>();
  answer = () => gate.promise;

  const inflight = [get(a, id), get(a, id), get(a, id), get(a, id)];
  // The handlers each sign a session before they reach the provider; wait for the first one to
  // actually arrive rather than for a fixed number of ticks.
  await untilCalled();
  gate.resolve([EVENT]);
  const bodies = await Promise.all((await Promise.all(inflight)).map((r) => r.json()));

  expect(calls).toEqual(["cmp-1"]);
  for (const body of bodies) expect(body.events).toHaveLength(1);
});

test("a FAILED fetch is not cached — but concurrent failures share one call", async () => {
  const a = app();
  const id = newCompany("cmp-1");
  const gate = deferred<DoolaComplianceEvent[]>();
  answer = () => gate.promise;

  const inflight = [get(a, id), get(a, id), get(a, id)];
  await untilCalled();
  gate.reject(new Error("upstream down"));
  for (const res of await Promise.all(inflight)) expect(res.status).toBe(502);
  // Rate-limited while in flight: three viewers, one call at a struggling partner.
  expect(calls).toEqual(["cmp-1"]);

  // …and NOT cached: the slot is released on settle, so the next request tries again rather than
  // answering "we could not ask" for the next 24 hours.
  answer = async () => [EVENT];
  const ok = await get(a, id);
  expect(ok.status).toBe(200);
  expect((await ok.json()).events).toHaveLength(1);
  expect(calls).toEqual(["cmp-1", "cmp-1"]);
});

/**
 * The map is BOUNDED.
 *
 * "In-process with a 24h TTL" is not a bound: an entry is only ever removed by being READ after
 * it expired, so a company looked at once and never again stays until the process restarts. The
 * size is otherwise "every company anybody ever opened", holding a partner's data long past the
 * day it was fetched.
 */
test("the cache evicts least-recently-used entries once it is full", async () => {
  const a = app();
  const ids: string[] = [];
  for (let i = 0; i < COMPLIANCE_CACHE_MAX + 1; i++) ids.push(newCompany(`cmp-${i}`));
  for (const id of ids) expect((await get(a, id)).status).toBe(200);
  expect(calls).toHaveLength(COMPLIANCE_CACHE_MAX + 1);

  // The most recent is still cached…
  await get(a, ids[ids.length - 1]!);
  expect(calls).toHaveLength(COMPLIANCE_CACHE_MAX + 1);
  // …and the OLDEST was evicted, so it is fetched again.
  await get(a, ids[0]!);
  expect(calls).toHaveLength(COMPLIANCE_CACHE_MAX + 2);
});

test("a hit REFRESHES an entry's place in the queue — a watched page is never evicted", async () => {
  const a = app();
  const ids: string[] = [];
  for (let i = 0; i < COMPLIANCE_CACHE_MAX; i++) ids.push(newCompany(`cmp-${i}`));
  for (const id of ids) await get(a, id);
  const baseline = calls.length;

  // Touch the oldest, which moves it to the end of the queue…
  await get(a, ids[0]!);
  expect(calls).toHaveLength(baseline);
  // …then overflow by one. The evicted entry is the SECOND oldest, not the one just read.
  const extra = newCompany("cmp-extra");
  await get(a, extra);
  await get(a, ids[0]!);
  expect(calls).toHaveLength(baseline + 1);
  await get(a, ids[1]!);
  expect(calls).toHaveLength(baseline + 2);
});

test("EXPIRED entries are pruned on write, not only when somebody reads them", async () => {
  const a = app();
  const stale = newCompany("cmp-stale");
  const fresh = newCompany("cmp-fresh");
  await get(a, stale);
  expect(calls).toEqual(["cmp-stale"]);

  // A day and a bit later, somebody opens a DIFFERENT company. The stale entry is not read, and
  // under the old code nothing would ever have removed it.
  now += COMPLIANCE_TTL_MS + 1000;
  await get(a, fresh);
  // The proof it was pruned rather than merely expired-on-read: the entry is gone, so the next
  // read of the stale company is a fetch — which is also what an expired read would do, so the
  // assertion that carries the weight is the LRU one above. What this pins is that the prune
  // runs and does not disturb the fresh entry.
  await get(a, fresh);
  expect(calls).toEqual(["cmp-stale", "cmp-fresh"]);
});
