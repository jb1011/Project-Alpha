import { getAddress } from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import type { FormationSummary } from "../../src/formation/status";
import type { LegalBodyResolution, LegalBodyStanding } from "../../src/payments/legalBody";
import type { EntityRecord } from "../../src/types";

/**
 * GET /legal-bodies/:address — the public lookup (design 2026-09-10 D3, D7, D8).
 *
 * The whole point of this surface is that a seller who has never heard of us can ask one question
 * about one address and get an answer it can act on. So the tests here are about the CONTRACT: the
 * exact response shape, no authentication, CORS `*`, and the two things D8 forbids — a `unknown`
 * standing being remembered, and a guess where a read failed.
 */

const POCKET = "0xeE85Fd00521d1Aa4c510BDdAb78F375830119354";
const TREASURY = "0xAD0F7d07Fe643e65dA4a6aB79560fbdB19d69A7d";
const STRANGER = "0x000000000000000000000000000000000000dEaD";
const WEB = "https://www.novicorpus.test";
const METADATA_BASE = "https://api.novicorpus.test";
const PUBLIC_ID = "22222222-2222-2222-2222-222222222222";

const entity = (over: Partial<EntityRecord> = {}): EntityRecord =>
  ({
    idempotencyKey: "tenant-a:agent",
    name: "TestMB2",
    status: "funded",
    manager: "0x0000000000000000000000000000000000000001",
    guardian: "0x0000000000000000000000000000000000000002",
    operator: null,
    pocketAddress: POCKET,
    amendmentDelay: "0",
    ein: "12-3456789",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: "843704",
    proxy: "0x0b92fe9A51f04784A96ed8346bF876EBE93163eE",
    treasury: TREASURY,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: "tenant-a",
    walletProvider: "circle",
    publicId: PUBLIC_ID,
    ...over,
  }) as EntityRecord;

const body = (
  over: Partial<EntityRecord> = {},
  standing: LegalBodyStanding = "active",
): LegalBodyResolution =>
  ({ kind: "body", entity: entity(over), standing, matchedBy: "pocket" }) as LegalBodyResolution;

let clock: number;
let calls: string[];
beforeEach(() => {
  clock = 1_757_500_000_000;
  calls = [];
});

function makeApp(opts: {
  answers?: LegalBodyResolution | LegalBodyResolution[];
  readBudget?: TokenBucket;
  formationSummary?: (companyId: string) => FormationSummary | null;
  wired?: boolean;
}) {
  const queue = Array.isArray(opts.answers)
    ? [...opts.answers]
    : opts.answers
      ? [opts.answers]
      : [{ kind: "none" } as LegalBodyResolution];
  return buildApiApp({
    webOrigin: WEB,
    jwtSecret: "s",
    now: () => clock,
    legalBody:
      opts.wired === false
        ? undefined
        : {
            resolver: {
              resolve: async (address: string) => {
                calls.push(address);
                return queue.length > 1 ? queue.shift()! : queue[0]!;
              },
            },
            readBudget: opts.readBudget ?? new TokenBucket(30, 1),
            links: { transparency: `${WEB}/transparency`, metadataBase: METADATA_BASE },
            formationSummary: opts.formationSummary,
            network: "testnet" as const,
          },
  } as never);
}

const get = (
  app: ReturnType<typeof buildApiApp>,
  address: string,
  headers?: Record<string, string>,
) => app.request(`/legal-bodies/${address}`, headers ? { headers } : undefined);

/** A distinct valid lowercase address per index — the memo and the per-client budget are both
 *  keyed on real input, so exercising them needs real, different addresses. */
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
/** Each caller its OWN forwarded-for, so a test that means "many requests" does not accidentally
 *  mean "one client's whole budget". */
const from = (client: string) => ({ "x-forwarded-for": `${client}, 10.0.0.1` });

// ── the answer itself ───────────────────────────────────────────────────────────────────────

test("a payer address of a live legal body answers exactly what a seller can verify", async () => {
  const app = makeApp({ answers: body() });
  const res = await get(app, POCKET); // no authorization header — this surface has none
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    address: POCKET,
    legalBody: true,
    standing: "active",
    agentId: "843704",
    publicId: PUBLIC_ID,
    name: "TestMB2",
    network: "testnet",
    links: {
      transparency: `${WEB}/transparency`,
      metadata: `${METADATA_BASE}/metadata/${PUBLIC_ID}`,
    },
    formation: null,
    checkedAt: new Date(clock).toISOString(),
  });
});

test("the address is echoed CHECKSUMMED however it was supplied, and the resolver is asked for it", async () => {
  const app = makeApp({ answers: body() });
  const res = await get(app, POCKET.toLowerCase());
  expect((await res.json()).address).toBe(getAddress(POCKET));
  expect(calls).toEqual([getAddress(POCKET)]);
});

test("a treasury match is the same legal body (D2: two keys, one entity)", async () => {
  const app = makeApp({
    answers: { kind: "body", entity: entity(), standing: "active", matchedBy: "treasury" },
  });
  const res = await get(app, TREASURY);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    address: getAddress(TREASURY),
    legalBody: true,
    standing: "active",
    agentId: "843704",
  });
});

test("a suspended body is a definitive NO, not a missing one", async () => {
  const app = makeApp({ answers: body({}, "inactive") });
  expect(await (await get(app, POCKET)).json()).toMatchObject({
    legalBody: true,
    standing: "inactive",
  });
});

test("an address we know nothing about answers legalBody:false and nothing else", async () => {
  const app = makeApp({ answers: { kind: "none" } });
  const res = await get(app, STRANGER);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    address: getAddress(STRANGER),
    legalBody: false,
    standing: null,
    checkedAt: new Date(clock).toISOString(),
  });
});

test("D7: nothing about the guardian, the human, the tenant or the EIN is on this surface", async () => {
  // Scanned on the RICHEST response too (review R3): a projection that leaks does it through the
  // formation block, and a fixture with no company never renders one. The EIN needle is the
  // fixture's actual value, not the three letters — `einIssued` is a legitimate key.
  const rich = makeApp({
    answers: body({ companyId: "company-1" }),
    formationSummary: () => ({
      provider: "doola",
      environment: "production",
      status: "complete",
      providerRef: "co_secret",
      filedAt: 1_757_000_000,
      filingNumber: "2026-123456",
      requiredActions: ["FORMATION_NAME_OPTIONS_EXHAUSTED"],
    }),
  });
  for (const app of [makeApp({ answers: body() }), rich]) {
    const raw = (await (await get(app, POCKET)).text()).toLowerCase();
    for (const forbidden of [
      "guardian",
      "human",
      "nullifier",
      "credential",
      "tenant",
      "12-3456789", // the EIN itself
      "co_secret", // doola's company id
      "2026-123456", // the filing number
      "required", // the open action codes
      "0x0000000000000000000000000000000000000002", // the guardian address
    ])
      expect(raw).not.toContain(forbidden);
  }
});

test("formation is reported when the entity has a filing, and never gates the answer", async () => {
  const app = makeApp({
    answers: body({ companyId: "company-1" }),
    formationSummary: () => ({
      provider: "doola",
      environment: "sandbox",
      status: "filed",
      providerRef: "co_secret",
      filedAt: 1_757_000_000,
      filingNumber: "2026-123456",
      requiredActions: [],
    }),
  });
  const json = await (await get(app, POCKET)).json();
  expect(json.formation).toEqual({
    filed: true,
    einIssued: false,
    status: "filed",
    environment: "sandbox",
  });
  // The provider reference and the filing number are the filing's own identifiers; the public
  // surfaces (`/transparency`, `/metadata`) serve neither, and neither does this one.
  expect(JSON.stringify(json)).not.toContain("co_secret");
  expect(JSON.stringify(json)).not.toContain("2026-123456");
});

test("formation is null for an entity with no company, and on a box that cannot read filings", async () => {
  expect((await (await get(makeApp({ answers: body() }), POCKET)).json()).formation).toBeNull();
  const noReader = makeApp({ answers: body({ companyId: "company-1" }) });
  expect((await (await get(noReader, POCKET)).json()).formation).toBeNull();
});

// ── validation ──────────────────────────────────────────────────────────────────────────────

test("a malformed address is a 400, never a lookup", async () => {
  const app = makeApp({ answers: body() });
  for (const bad of ["notanaddress", "0x1234", `${POCKET}00`, "0x", `${POCKET.slice(0, 41)}g`]) {
    const res = await get(app, bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_error",
      message: expect.stringContaining("address"),
    });
  }
  expect(calls).toEqual([]);
});

test("a mixed-case address with a broken EIP-55 checksum is refused (a typo is not a lookup)", async () => {
  const app = makeApp({ answers: body() });
  const flipped = "0xEe85Fd00521d1Aa4c510BDdAb78F375830119354"; // one case flip off EIP-55
  const res = await get(app, flipped);
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

// ── load: the bucket and the memo (D3, D8) ──────────────────────────────────────────────────

test("an empty read budget is a 429, not a guess", async () => {
  const app = makeApp({ answers: body(), readBudget: new TokenBucket(0, 0) });
  const res = await get(app, POCKET);
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({
    error: "rate_limited",
    message: "try again in a few seconds",
  });
  expect(calls).toEqual([]);
});

test("a definitive answer is memoised for 15 s — same answer, no second resolve", async () => {
  const app = makeApp({ answers: body() });
  const first = await (await get(app, POCKET)).json();
  clock += 14_999;
  const second = await (await get(app, POCKET)).json();
  expect(calls).toHaveLength(1);
  // The memo replays the answer AS CHECKED — restamping `checkedAt` would claim a freshness this
  // response does not have.
  expect(second).toEqual(first);
});

test("the memo expires at 15 s and the chain is asked again", async () => {
  const app = makeApp({ answers: [body(), body({}, "inactive")] });
  expect((await (await get(app, POCKET)).json()).standing).toBe("active");
  clock += 15_000;
  expect((await (await get(app, POCKET)).json()).standing).toBe("inactive");
  expect(calls).toHaveLength(2);
});

test("the memo is per address: one body's answer never answers for another", async () => {
  const app = makeApp({ answers: [body(), { kind: "none" }] });
  expect((await (await get(app, POCKET)).json()).legalBody).toBe(true);
  expect((await (await get(app, STRANGER)).json()).legalBody).toBe(false);
  expect(calls).toHaveLength(2);
});

test("D8: `unknown` is served but NEVER memoised — the next call re-reads", async () => {
  const app = makeApp({ answers: [body({}, "unknown"), body()] });
  const first = await (await get(app, POCKET)).json();
  expect(first).toMatchObject({ legalBody: true, standing: "unknown" });
  const second = await (await get(app, POCKET)).json();
  expect(second.standing).toBe("active");
  expect(calls).toHaveLength(2);
});

// ── the surface itself ──────────────────────────────────────────────────────────────────────

test("cross-origin preflight gets ACAO: * — any seller's page may ask", async () => {
  const res = await makeApp({ answers: body() }).request(`/legal-bodies/${POCKET}`, {
    method: "OPTIONS",
    headers: { Origin: "https://some-seller.example", "Access-Control-Request-Method": "GET" },
  });
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const get = await makeApp({ answers: body() }).request(`/legal-bodies/${POCKET}`, {
    headers: { Origin: "https://some-seller.example" },
  });
  expect(get.headers.get("access-control-allow-origin")).toBe("*");
});

test("a deployment with no resolver wired does not mount the route at all", async () => {
  const res = await get(makeApp({ wired: false }), POCKET);
  expect(res.status).toBe(404);
});

// ── the freshness contract on the wire (R1) ─────────────────────────────────────────────────

test("a definitive answer states its own 15 s window; a memo hit repeats it", async () => {
  const app = makeApp({ answers: body() });
  const first = await get(app, POCKET);
  expect(first.headers.get("cache-control")).toBe("public, max-age=15");
  clock += 1_000;
  const hit = await get(app, POCKET);
  expect(calls).toHaveLength(1); // the memo answered
  expect(hit.headers.get("cache-control")).toBe("public, max-age=15");
  // …and so does a definitive negative: "not one of ours" is an answer, not an absence.
  const stranger = await get(makeApp({ answers: { kind: "none" } }), STRANGER);
  expect(stranger.headers.get("cache-control")).toBe("public, max-age=15");
});

test("everything that is NOT a definitive answer is no-store", async () => {
  const unknown = await get(makeApp({ answers: body({}, "unknown") }), POCKET);
  expect(unknown.status).toBe(200);
  expect(unknown.headers.get("cache-control")).toBe("no-store");

  const bad = await get(makeApp({ answers: body() }), "notanaddress");
  expect(bad.status).toBe(400);
  expect(bad.headers.get("cache-control")).toBe("no-store");

  const empty = await get(makeApp({ answers: body(), readBudget: new TokenBucket(0, 0) }), POCKET);
  expect(empty.status).toBe(429);
  expect(empty.headers.get("cache-control")).toBe("no-store");
});

// ── the two budgets (R2) ────────────────────────────────────────────────────────────────────

test("a scanner runs out of ITS OWN budget first; the next caller is served normally", async () => {
  // A generous shared bucket, so the only thing that can refuse the scanner is its own.
  const app = makeApp({ answers: body(), readBudget: new TokenBucket(5_000, 0) });
  const scanner = from("203.0.113.9");
  const statuses: number[] = [];
  for (let i = 1; i <= 11; i += 1) statuses.push((await get(app, addr(i), scanner)).status);
  expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200)); // the burst
  expect(statuses[10]).toBe(429); // …and then its own allowance is gone
  // A different caller, an address the scanner never touched: unaffected.
  expect((await get(app, addr(500), from("198.51.100.4"))).status).toBe(200);
});

test("the shared budget still caps everyone, however many clients they come from", async () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const app = makeApp({ answers: body(), readBudget: new TokenBucket(2, 0) });
    expect((await get(app, addr(1), from("1.1.1.1"))).status).toBe(200);
    expect((await get(app, addr(2), from("2.2.2.2"))).status).toBe(200);
    const third = await get(app, addr(3), from("3.3.3.3"));
    expect(third.status).toBe(429);
    // The refusal is the SAME whichever budget ran out — a caller is never told which of our
    // limits it is standing in front of — but the ops line names it.
    expect(await third.json()).toEqual({
      error: "rate_limited",
      message: "try again in a few seconds",
    });
    const line = spy.mock.calls
      .map(([l]) => String(l))
      .find((l) => l.includes("legal_body_lookup_throttled"));
    expect(JSON.parse(line!)).toMatchObject({ bucket: "shared" });
  } finally {
    spy.mockRestore();
  }
});

test("a request with no X-Forwarded-For shares one bucket, and is not an error", async () => {
  const app = makeApp({ answers: body(), readBudget: new TokenBucket(5_000, 0) });
  const statuses: number[] = [];
  for (let i = 1; i <= 11; i += 1) statuses.push((await get(app, addr(i))).status);
  expect(statuses[9]).toBe(200);
  expect(statuses[10]).toBe(429);
});

test("a drain writes ONE ops line per minute, naming the bucket and nothing else", async () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const app = makeApp({ answers: body(), readBudget: new TokenBucket(5_000, 0) });
    const scanner = from("203.0.113.9");
    for (let i = 1; i <= 13; i += 1) await get(app, addr(i), scanner); // 10 served, 3 refused
    const lines = () =>
      spy.mock.calls
        .map(([l]) => String(l))
        .filter((l) => l.includes("legal_body_lookup_throttled"));
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]!)).toMatchObject({ bucket: "client" });
    expect(lines()[0]).not.toContain("203.0.113.9");
    expect(lines()[0]).not.toContain(addr(11));
    // …and the window reopens.
    clock += 60_000;
    await get(app, addr(14), scanner);
    expect(lines()).toHaveLength(2);
  } finally {
    spy.mockRestore();
  }
});

// ── the rules the report claimed but nothing pinned (R4) ────────────────────────────────────

test("a memo hit costs a token from NEITHER budget", async () => {
  // One token in the shared bucket, no refill: a second chain read would be a 429.
  const app = makeApp({ answers: body(), readBudget: new TokenBucket(1, 0) });
  expect((await get(app, POCKET)).status).toBe(200);
  clock += 14_000;
  const second = await get(app, POCKET);
  expect(second.status).toBe(200);
  expect(calls).toHaveLength(1);
});

test("the memo is bounded: the coldest entry is evicted, the newest still answers", async () => {
  const app = makeApp({ answers: body(), readBudget: new TokenBucket(5_000, 0) });
  // 1001 distinct addresses, each from its own client so only the shared budget is in play.
  for (let i = 1; i <= 1001; i += 1) await get(app, addr(i), from(`10.0.${i >> 8}.${i & 0xff}`));
  expect(calls).toHaveLength(1001);
  // The newest is still memoised…
  await get(app, addr(1001), from("10.0.3.233"));
  expect(calls).toHaveLength(1001);
  // …and the oldest was evicted, so it costs a fresh read rather than living in the map forever.
  await get(app, addr(1), from("10.0.0.1"));
  expect(calls).toHaveLength(1002);
});

test("a legacy row with no publicId links to nothing rather than to /metadata/null", async () => {
  const app = makeApp({ answers: body({ publicId: null, agentId: null }) });
  const json = await (await get(app, POCKET)).json();
  expect(json).toMatchObject({ legalBody: true, publicId: null, agentId: null });
  expect(json.links.metadata).toBeNull();
  expect(JSON.stringify(json)).not.toContain("/metadata/null");
});

test("a resolver that THROWS is a flat 503, never the nested envelope and never a standing", async () => {
  const app = buildApiApp({
    webOrigin: WEB,
    jwtSecret: "s",
    now: () => clock,
    legalBody: {
      resolver: {
        resolve: async () => {
          throw new Error("database is locked");
        },
      },
      readBudget: new TokenBucket(30, 1),
      links: { transparency: `${WEB}/transparency`, metadataBase: METADATA_BASE },
      network: "testnet" as const,
    },
  } as never);
  const res = await get(app, POCKET);
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const json = await res.json();
  expect(json.error).toBe("unavailable");
  expect(typeof json.message).toBe("string");
  expect(json.standing).toBeUndefined();
  expect(JSON.stringify(json)).not.toContain("database is locked");
});
