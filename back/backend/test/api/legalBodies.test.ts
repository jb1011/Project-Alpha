import { getAddress } from "viem";
import { beforeEach, expect, test } from "vitest";
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

const get = (app: ReturnType<typeof buildApiApp>, address: string) =>
  app.request(`/legal-bodies/${address}`);

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

test("D7: nothing about the guardian, the human, or AgentBook is on this surface", async () => {
  const app = makeApp({ answers: body() });
  const raw = await (await get(app, POCKET)).text();
  for (const forbidden of ["guardian", "human", "nullifier", "credential", "tenant", "ein"])
    expect(raw.toLowerCase()).not.toContain(forbidden);
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
