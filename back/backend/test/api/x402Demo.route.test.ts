import Database from "better-sqlite3";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { agentkitSignerFromKey } from "../../src/adapters/worldid/agentkitSigner";
import type { X402DemoDeps } from "../../src/api/routes/x402Demo";
import { buildX402DemoDeps, mountX402DemoRoutes } from "../../src/api/routes/x402Demo";
import type { Config } from "../../src/config/env";
import { AGENT_BOOK_CHAIN_ID } from "../../src/payments/agentBookReader";
import { buyWithX402 } from "../../src/payments/buyer";
import type { LegalBodyResolution } from "../../src/payments/legalBody";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Address } from "../../src/types";

const DEPS = {
  payTo: "0x00000000000000000000000000000000000000ab",
  asset: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
  price: 10000n,
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  resourceUrl: "https://example.test/backend/x402-demo/quote",
} as const;

test("no X-PAYMENT -> 402 with well-formed Arc requirements", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, DEPS);
  const res = await app.request("/x402-demo/quote");
  expect(res.status).toBe(402);
  const body = (await res.json()) as { accepts: Array<Record<string, unknown>> };
  expect(body.accepts[0]).toMatchObject({
    network: "eip155:5042002",
    asset: DEPS.asset,
    payTo: DEPS.payTo,
    maxAmountRequired: "10000",
  });
});

test("malformed X-PAYMENT -> 402 malformed", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, DEPS);
  const res = await app.request("/x402-demo/quote", { headers: { "X-PAYMENT": "not-valid!!" } });
  expect(res.status).toBe(402);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe("malformed X-PAYMENT");
});

test("buildX402DemoDeps returns undefined when the flag is off", () => {
  const cfg = { enableX402Demo: false } as unknown as Config;
  expect(buildX402DemoDeps(cfg)).toBeUndefined();
});

test("buildX402DemoDeps builds Arc deps from config when on", () => {
  const cfg = {
    enableX402Demo: true,
    x402DemoPayTo: DEPS.payTo,
    usdc: DEPS.asset,
    chainId: 5042002,
    x402DemoPriceUsdc: "0.01",
    gatewayFacilitatorUrl: DEPS.facilitatorUrl,
    metadataBaseUrl: "https://example.test/backend",
  } as unknown as Config;
  const deps = buildX402DemoDeps(cfg);
  expect(deps).toBeDefined();
  expect(deps?.price).toBe(10000n);
  expect(deps?.network).toBe("eip155:5042002");
  expect(deps?.resourceUrl).toBe("https://example.test/backend/x402-demo/quote");
});

// ── the pinned legal-bodies wall and its two refusal legs (design 2026-09-10 D5) ──────────────
//
// The demo's whole claim is that the two refusals are REAL: produced by the same paywall code a
// buyer would hit, against a policy that is pinned here and cannot be softened by the box's
// X402_TRUST_POLICY. Both tests below therefore drive the actual routes, with only the two things
// that would otherwise reach the network stubbed — AgentBook and the legal-body resolver.

/** One leg of the run: the name, what the wall answered, and its body verbatim. */
type Leg = {
  name: string;
  status: number | null;
  body: Record<string, unknown> | null;
  skipped?: boolean;
  reason?: string;
};

const PROOF_KEY = `0x${"7".repeat(64)}` as const;
const HUMAN = "0x051dbcb350abbe853a25ef35c88c7a582281f88d1d8e26ed014bad0e34a7d234";
const LOOKUP_BASE = "https://api.novicorpus.test";

function legalDemoDeps(over: Partial<X402DemoDeps> = {}): X402DemoDeps {
  const db = new Database(":memory:");
  migrate(db);
  return {
    ...DEPS,
    payTo: DEPS.payTo as Address,
    asset: DEPS.asset as Address,
    // "open" on purpose: the pinned wall must ignore whatever the deployment configured.
    trustPolicy: "open",
    agentkit: {
      domain: new URL(DEPS.resourceUrl).hostname,
      resourceUrl: DEPS.resourceUrl,
      network: DEPS.network,
      store: new SqliteWorldStore(db),
      allowancePerHuman: 3,
      agentBook: { lookupHuman: async () => HUMAN },
    },
    proofAgentKey: PROOF_KEY,
    legalBody: {
      // The proof agent is human-backed and has NO legal body — which is exactly the second leg.
      resolver: { resolve: async () => ({ kind: "none" }) as LegalBodyResolution },
      lookupBaseUrl: LOOKUP_BASE,
      onboardUrl: "https://www.novicorpus.test/",
      transparencyUrl: "https://www.novicorpus.test/transparency",
    },
    ...over,
  };
}

test("the pinned wall refuses an anonymous caller even though the deployment says 'open'", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps());

  const wall = await app.request("/x402-demo/legal-bodies-wall");
  expect(wall.status).toBe(403);
  expect(((await wall.json()) as { error: string; reason: string }).error).toBe(
    "human_backing_required",
  );

  // …and the configured seller next door is untouched: still an invoice, not a door.
  const configured = await app.request("/x402-demo/quote");
  expect(configured.status).toBe(402);
});

test("legal-bodies-run returns both refusal legs, signed for real", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps());
  const res = await app.request("/x402-demo/legal-bodies-run");
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    policy: string;
    legs: Leg[];
    expected: unknown;
    thirdLeg: string;
  };
  expect(out.policy).toBe("legal-bodies-only");
  expect(out.legs.length).toBe(2);

  const anon = out.legs[0] as Leg;
  const agent = out.legs[1] as Leg;
  expect(anon.status).toBe(403);
  expect(anon.body?.error).toBe("human_backing_required");
  expect(anon.body?.reason).toBe("no-proof-presented");

  // The second leg is the one that costs something to fake: a real SIWE proof from a key
  // AgentBook vouches for, refused only because no legal body stands behind it.
  expect(agent.skipped).toBeFalsy();
  expect(agent.status).toBe(403);
  expect(agent.body?.error).toBe("legal_body_required");
  expect(agent.body?.reason).toBe("not-legal-body");
  const how = agent.body?.how as { lookup: string; onboard: string; transparency: string };
  expect(how.lookup.startsWith(`${LOOKUP_BASE}/legal-bodies/0x`)).toBe(true);

  expect(out.expected).toBeTruthy();
  expect(out.thirdLeg).toContain("this endpoint spends nothing");
});

test("no proof key configured -> the second leg is reported skipped, not faked", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps({ proofAgentKey: undefined }));
  const res = await app.request("/x402-demo/legal-bodies-run");
  const out = (await res.json()) as { legs: Leg[] };
  expect(out.legs.length).toBe(2);
  expect((out.legs[0] as Leg).status).toBe(403);
  expect((out.legs[1] as Leg).skipped).toBe(true);
  expect((out.legs[1] as Leg).reason).toBeTruthy();
});

test("no legal-body resolver wired -> the wall refuses 503 rather than serving on a guess", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps({ legalBody: undefined }));
  const res = await app.request("/x402-demo/legal-bodies-wall");
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe("legal_body_check_unavailable");
});

/** Mint a real AgentKit header for `path` from that route's own 403 challenge. */
async function mintForWall(app: Hono, path: string) {
  const probe = await app.request(path);
  const body = (await probe.json()) as { extensions?: { agentkit?: unknown } };
  const { createAgentkitClient } = await import("@worldcoin/agentkit");
  const client = createAgentkitClient({
    signer: agentkitSignerFromKey(PROOF_KEY, AGENT_BOOK_CHAIN_ID),
    // biome-ignore lint/suspicious/noExplicitAny: client options typing varies across SDK versions.
  } as any) as { createHeader(ext: unknown): Promise<string> };
  return client.createHeader(body.extensions?.agentkit);
}

test("the run survives repetition: four loads, four identical second legs (R2)", async () => {
  // The failure this pins: the run's second leg spends a unit of the proof agent's allowance, and
  // prod's default is 3 per 24 h — so from the fourth page view the endpoint would answer 429
  // beside an `expected` block still promising 403, publicly contradicting itself mid-demo.
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps());
  // A second ahead of the real clock, which the challenge's `issuedAt` still reads (`new Date()`):
  // frozen exactly at "now", the message is minted a few ms into the mocked future and refused.
  let clock = Date.now() + 1_000;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
  try {
    for (let i = 0; i < 4; i++) {
      const res = await app.request("/x402-demo/legal-bodies-run");
      expect(res.status, `run ${i + 1}`).toBe(200);
      const leg = ((await res.json()) as { legs: Leg[] }).legs[1] as Leg;
      expect(leg.status, `run ${i + 1}`).toBe(403);
      expect(leg.body?.error, `run ${i + 1}`).toBe("legal_body_required");
      expect(leg.body?.reason, `run ${i + 1}`).toBe("not-legal-body");
      clock += 6_000; // past the run's own 5-second throttle
    }
  } finally {
    spy.mockRestore();
  }
});

test("the run cannot spend the real wall's budget (R7.3)", async () => {
  // One unit for the whole window: if the run charged the wall's meter, the buyer below would be
  // rate-capped instead of receiving the legal-body refusal the wall exists to give.
  const deps = legalDemoDeps();
  const app = new Hono();
  mountX402DemoRoutes(app, {
    ...deps,
    agentkit: { ...(deps.agentkit as NonNullable<X402DemoDeps["agentkit"]>), allowancePerHuman: 1 },
  });

  const run = await app.request("/x402-demo/legal-bodies-run");
  expect(((await run.json()) as { legs: Leg[] }).legs[1]?.status).toBe(403);

  const res = await app.request("/x402-demo/legal-bodies-wall", {
    headers: { agentkit: await mintForWall(app, "/x402-demo/legal-bodies-wall") },
  });
  expect(res.status).not.toBe(429);
  expect(((await res.json()) as { error: string }).error).toBe("legal_body_required");
  expect(res.headers.get("X-AGENTKIT-AUTHORIZATION")).toBe("1/1"); // its own first unit
});

test("the wall and the run advertise the API's own origin when PUBLIC_API_URL is set (R1/R5)", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps({ publicApiUrl: "https://api.novicorpus.test" }));
  const out = (await (await app.request("/x402-demo/legal-bodies-run")).json()) as {
    resource: string;
    runUrl: string;
  };
  // Not the www/backend proxy: it strips CORS, Cache-Control and X-NOVI-LEGAL-BODY.
  expect(out.resource).toBe("https://api.novicorpus.test/x402-demo/legal-bodies-wall");
  expect(out.runUrl).toBe("https://api.novicorpus.test/x402-demo/legal-bodies-run");
});

test("buildX402DemoDeps carries PUBLIC_API_URL, falling back to the metadata base", () => {
  const base = {
    enableX402Demo: true,
    x402DemoPayTo: DEPS.payTo,
    usdc: DEPS.asset,
    chainId: 5042002,
    x402DemoPriceUsdc: "0.01",
    gatewayFacilitatorUrl: DEPS.facilitatorUrl,
    metadataBaseUrl: "https://example.test/backend",
  };
  expect(buildX402DemoDeps(base as unknown as Config)?.publicApiUrl).toBe(
    "https://example.test/backend",
  );
  expect(
    buildX402DemoDeps({
      ...base,
      publicApiUrl: "https://api.novicorpus.test",
    } as unknown as Config)?.publicApiUrl,
  ).toBe("https://api.novicorpus.test");
});

// ── the wall signs against the url it ADVERTISES (final pass F1) ──────────────────────────────
//
// `deps.agentkit.domain` is fixed once, from METADATA_BASE_URL's host. The pinned wall overrides
// `resourceUrl` with its own (PUBLIC_API_URL-based) url, and `validateAgentkitMessage` compares the
// signed `domain` against THAT url's hostname — so on the deploy the runbook prescribes (two
// different hosts) every proof was refused "Domain mismatch: expected api…, got www…", i.e. the
// wall could not accept a proof minted from its own challenge.

const PUBLIC_API = "https://api.novicorpus.test";

test("a proof minted from the wall's own challenge is accepted when PUBLIC_API_URL names another host (F1)", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps({ publicApiUrl: PUBLIC_API }));

  const res = await app.request("/x402-demo/legal-bodies-wall", {
    headers: { agentkit: await mintForWall(app, "/x402-demo/legal-bodies-wall") },
  });

  // Past the FIRST gate: the human was verified, and the only thing missing is the legal body.
  // Before the fix this was 403 human_backing_required / invalid-message:Domain mismatch.
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string; reason: string };
  expect(body.error).toBe("legal_body_required");
  expect(body.reason).toBe("not-legal-body");
  expect(res.headers.get("X-AGENTKIT-HUMAN")).toBe(HUMAN);
});

test("the run's second leg is the legal refusal, not a domain mismatch, on the prescribed deploy (F1)", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps({ publicApiUrl: PUBLIC_API }));
  const out = (await (await app.request("/x402-demo/legal-bodies-run")).json()) as { legs: Leg[] };
  const agent = out.legs[1] as Leg;
  expect(agent.skipped).toBeFalsy();
  expect(agent.status).toBe(403);
  // The public self-contradiction this pins: `expected` promises legal_body_required beside a leg
  // that answered human_backing_required.
  expect(agent.body?.error).toBe("legal_body_required");
  expect(agent.body?.reason).toBe("not-legal-body");
});

test("our own buyer's origin check accepts the wall's challenge on the advertised host (F1)", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, legalDemoDeps({ publicApiUrl: PUBLIC_API }));
  const wallUrl = `${PUBLIC_API}/x402-demo/legal-bodies-wall`;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers =
      input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers ?? {});
    if (input instanceof Request)
      new Headers(init?.headers ?? {}).forEach((v, k) => headers.set(k, v));
    const url = input instanceof Request ? input.url : String(input);
    return app.request(new URL(url).pathname, { headers });
  }) as typeof fetch;

  const err = await buyWithX402(
    {
      fetchImpl,
      directFetch: fetchImpl,
      authorize: async () => ({ ok: false as const, reason: "never-reached" }),
      agentkitSigner: agentkitSignerFromKey(PROOF_KEY, AGENT_BOOK_CHAIN_ID),
    },
    wallUrl,
  ).catch((e: Error) => e);

  // The buyer refuses to sign a challenge that names another site (T6-R3). A wall whose challenge
  // says `www` while the url being bought says `api` is exactly that, so leg 3 died here — before
  // any payment — rather than at the seller.
  expect((err as Error).message).not.toContain("challenge-origin-mismatch");
  expect((err as Error).message).toContain("resource-403-after-proof");
  expect((err as Error).message).toContain("legal_body_required");
});

// ── the configured policy survives a missing World config (final pass C3) ─────────────────────
//
// `trustPolicy` used to be assigned only inside main.ts's `cfg.worldChain` block, so a box that
// dropped its World config while its env still said `legal-bodies-only` ran `open` — the documented
// fail-closed 503 was unreachable from the composition root, and neither mount warning printed.

test("X402_TRUST_POLICY reaches the deps even with no World config (C3)", () => {
  const base = {
    enableX402Demo: true,
    x402DemoPayTo: DEPS.payTo,
    usdc: DEPS.asset,
    chainId: 5042002,
    x402DemoPriceUsdc: "0.01",
    gatewayFacilitatorUrl: DEPS.facilitatorUrl,
    metadataBaseUrl: "https://example.test/backend",
  };
  expect(buildX402DemoDeps(base as unknown as Config)?.trustPolicy).toBe("open");
  expect(
    buildX402DemoDeps({
      ...base,
      x402TrustPolicy: "legal-bodies-only",
    } as unknown as Config)?.trustPolicy,
  ).toBe("legal-bodies-only");
});

test("legal-bodies-only with no World config refuses 503 — never an OPEN seller (C3)", async () => {
  const deps = buildX402DemoDeps({
    enableX402Demo: true,
    x402DemoPayTo: DEPS.payTo,
    usdc: DEPS.asset,
    chainId: 5042002,
    x402DemoPriceUsdc: "0.01",
    gatewayFacilitatorUrl: DEPS.facilitatorUrl,
    metadataBaseUrl: "https://example.test/backend",
    x402TrustPolicy: "legal-bodies-only",
  } as unknown as Config) as X402DemoDeps;
  // Exactly what main.ts would have: no agentkit and no legal-body resolver, because both hang off
  // the World config this box has lost.
  const app = new Hono();
  mountX402DemoRoutes(app, deps);
  const res = await app.request("/x402-demo/quote");
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe("legal_body_check_unavailable");
});
