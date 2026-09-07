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
import { COMPLIANCE_TTL_MS } from "../../src/api/routes/compliance";
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
