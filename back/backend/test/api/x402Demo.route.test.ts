import Database from "better-sqlite3";
import { Hono } from "hono";
import { expect, test } from "vitest";
import type { X402DemoDeps } from "../../src/api/routes/x402Demo";
import { buildX402DemoDeps, mountX402DemoRoutes } from "../../src/api/routes/x402Demo";
import type { Config } from "../../src/config/env";
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
