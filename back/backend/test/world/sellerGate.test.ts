import Database from "better-sqlite3";
import { Hono } from "hono";
import type { Hex } from "viem";
import { beforeEach, describe, expect, test } from "vitest";
import {
  agentkitSignerFromKey,
  wrapFetchWithAgentkit,
} from "../../src/adapters/worldid/agentkitSigner";
import { buildPaywall } from "../../src/payments/seller";
import type { AgentkitSellerConfig } from "../../src/payments/worldVerifier";
import { mintAgentkitExtension, verifyAgentkitRequest } from "../../src/payments/worldVerifier";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Address } from "../../src/types";

const RESOURCE_URL = "https://example.com/x402-demo/quote";
const HUMAN = "0x051dbcb350abbe853a25ef35c88c7a582281f88d1d8e26ed014bad0e34a7d234";

let store: SqliteWorldStore;
beforeEach(() => {
  const db = new Database(":memory:");
  migrate(db);
  store = new SqliteWorldStore(db);
});

function cfg(over: Partial<AgentkitSellerConfig> = {}): AgentkitSellerConfig {
  return {
    domain: "example.com",
    resourceUrl: RESOURCE_URL,
    network: "eip155:5042002",
    store,
    allowancePerHuman: 2,
    agentBook: { lookupHuman: async () => HUMAN },
    ...over,
  };
}

describe("mintAgentkitExtension", () => {
  test("hand-mints nonce/issuedAt/expirationTime (SDK omits them; client rejects without)", () => {
    const ext = mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    }) as { agentkit: { info: Record<string, unknown>; supportedChains: unknown[] } };
    expect(ext.agentkit.info.nonce).toBeTruthy();
    expect(ext.agentkit.info.issuedAt).toBeTruthy();
    expect(ext.agentkit.info.expirationTime).toBeTruthy();
    expect(ext.agentkit.info.domain).toBe("example.com");
    expect(ext.agentkit.supportedChains.length).toBeGreaterThan(0);
  });

  test("REGRESSION: nonce is alphanumeric (SIWE rejects hyphens -> silent skip)", () => {
    // randomUUID() is the obvious choice and is what World's own example shows, but its hyphens
    // make the client's createHeader throw a SiweError, which it swallows as `agentkit_skipped`:
    // the agent is never authorized and nothing surfaces the reason. Keep this alphanumeric.
    for (let i = 0; i < 20; i++) {
      const ext = mintAgentkitExtension({
        domain: "example.com",
        resourceUrl: RESOURCE_URL,
        network: "eip155:5042002",
        allowancePerHuman: 3,
      }) as { agentkit: { info: { nonce: string } } };
      expect(ext.agentkit.info.nonce).toMatch(/^[a-zA-Z0-9]{8,}$/);
    }
  });

  test("each mint carries a fresh nonce (no cross-response replay)", () => {
    const a = mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    }) as { agentkit: { info: { nonce: string } } };
    const b = mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    }) as { agentkit: { info: { nonce: string } } };
    expect(a.agentkit.info.nonce).not.toBe(b.agentkit.info.nonce);
  });
});

const AGENT_KEY = `0x${"7".repeat(64)}` as Hex;

/**
 * Mint a REAL signed `agentkit` header by driving the SDK against a throwaway paywall and
 * capturing what the agent sends on the retry.
 *
 * WHY THIS EXISTS: hand-written payloads (`{nope:1}`) are rejected by `parseAgentkitHeader` long
 * before the gate ever consults AgentBook, so a test built on one cannot say anything about the
 * lookup. Three tests below previously did exactly that — they passed for the wrong reason and
 * would not have caught an AgentBook regression. Every test that claims to exercise the lookup now
 * asserts `calls` as well as the verdict, so it can never silently decay back into a vacuous test.
 *
 * The captured header's nonce is consumed in the THROWAWAY store, so it is still fresh against the
 * per-test store (`consumeNonce` is first-use-wins). One header is good for exactly one verify.
 */
async function realAgentkitHeader(): Promise<string> {
  const throwawayDb = new Database(":memory:");
  migrate(throwawayDb);
  let captured = "";

  const app = new Hono();
  app.route(
    "/",
    buildPaywall({
      price: 10_000n,
      payTo: "0x0000000000000000000000000000000000000001" as Address,
      asset: "0x3600000000000000000000000000000000000000" as Address,
      network: "eip155:5042002",
      resource: "/x402-demo/quote",
      resourceUrl: RESOURCE_URL,
      agentkit: {
        domain: new URL(RESOURCE_URL).hostname,
        resourceUrl: RESOURCE_URL,
        network: "eip155:5042002",
        store: new SqliteWorldStore(throwawayDb),
        allowancePerHuman: 99,
        agentBook: { lookupHuman: async () => HUMAN },
      },
      serve: () => ({ ok: true }),
    }),
  );

  const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers =
      input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers ?? {});
    if (input instanceof Request)
      new Headers(init?.headers ?? {}).forEach((v, k) => headers.set(k, v));
    const h = headers.get("agentkit");
    if (h) captured = h;
    const url = input instanceof Request ? input.url : String(input);
    return app.request(new URL(url).pathname, {
      method: input instanceof Request ? (init?.method ?? input.method) : init?.method,
      headers,
    });
  }) as typeof fetch;

  await wrapFetchWithAgentkit(
    capturingFetch,
    agentkitSignerFromKey(AGENT_KEY, 5042002),
  )(RESOURCE_URL);
  if (!captured) throw new Error("failed to capture a signed agentkit header");
  return captured;
}

describe("verifyAgentkitRequest — fail-closed", () => {
  test("malformed header -> refused before any AgentBook lookup", async () => {
    let calls = 0;
    const r = await verifyAgentkitRequest(
      "not-base64-json",
      cfg({
        agentBook: {
          lookupHuman: async () => {
            calls++;
            return HUMAN;
          },
        },
      }),
    );
    expect(r.authorized).toBe(false);
    expect(calls).toBe(0); // rejected at parse — no RPC spent on garbage
  });

  test("garbage base64 payload -> refused before any AgentBook lookup", async () => {
    let calls = 0;
    const bad = Buffer.from(JSON.stringify({ nope: 1 })).toString("base64");
    const r = await verifyAgentkitRequest(
      bad,
      cfg({
        agentBook: {
          lookupHuman: async () => {
            calls++;
            return HUMAN;
          },
        },
      }),
    );
    expect(r.authorized).toBe(false);
    expect(calls).toBe(0);
  });

  test("AgentBook RPC failure is refused, never granted (lookup REALLY reached)", async () => {
    const header = await realAgentkitHeader();
    let calls = 0;
    const r = await verifyAgentkitRequest(
      header,
      cfg({
        agentBook: {
          lookupHuman: async () => {
            calls++;
            throw new Error("world chain down");
          },
        },
      }),
    );
    expect(calls).toBe(1); // the whole point: the throw happened INSIDE the gate
    expect(r.authorized).toBe(false);
  });

  test("unregistered agent (null) is refused with not-human-backed", async () => {
    const header = await realAgentkitHeader();
    let calls = 0;
    const r = await verifyAgentkitRequest(
      header,
      cfg({
        agentBook: {
          lookupHuman: async () => {
            calls++;
            return null;
          },
        },
      }),
    );
    expect(calls).toBe(1);
    expect(r.authorized).toBe(false);
    expect((r as { reason: string }).reason).toBe("not-human-backed");
  });

  test("zero-address humanId is refused (a zero read is not a human)", async () => {
    const header = await realAgentkitHeader();
    const r = await verifyAgentkitRequest(
      header,
      cfg({ agentBook: { lookupHuman: async () => `0x${"0".repeat(64)}` } }),
    );
    expect(r.authorized).toBe(false);
    expect((r as { reason: string }).reason).toBe("not-human-backed");
  });

  test("a DEFINITIVE unregistered answer is cached — the second call spends no RPC", async () => {
    let calls = 0;
    const book = {
      lookupHuman: async () => {
        calls++;
        return null;
      },
    };
    const a = await verifyAgentkitRequest(await realAgentkitHeader(), cfg({ agentBook: book }));
    const b = await verifyAgentkitRequest(await realAgentkitHeader(), cfg({ agentBook: book }));
    expect(a.authorized).toBe(false);
    expect(b.authorized).toBe(false);
    expect(calls).toBe(1); // the contract already told us nobody vouches — don't ask again
  });

  test("an AgentBook OUTAGE is NEVER cached — the next call retries the lookup", async () => {
    // The dangerous case: caching an outage as "unregistered" would lock a legitimately
    // registered agent out for the whole TTL, turning one bad minute of RPC into an hour of
    // wrongly-refused commerce.
    let calls = 0;
    const book = {
      lookupHuman: async () => {
        calls++;
        throw new Error("HTTP 429 Too Many Requests");
      },
    };
    const a = await verifyAgentkitRequest(await realAgentkitHeader(), cfg({ agentBook: book }));
    const b = await verifyAgentkitRequest(await realAgentkitHeader(), cfg({ agentBook: book }));
    expect(a.authorized).toBe(false);
    expect(b.authorized).toBe(false);
    expect(calls).toBe(2); // we still don't know — ask again rather than cache a guess
  });

  test("an outage does not poison an existing cached positive", async () => {
    let mode: "ok" | "down" = "ok";
    const book = {
      lookupHuman: async () => {
        if (mode === "down") throw new Error("world chain down");
        return HUMAN;
      },
    };
    const first = await verifyAgentkitRequest(await realAgentkitHeader(), cfg({ agentBook: book }));
    expect(first.authorized).toBe(true);
    mode = "down";
    const second = await verifyAgentkitRequest(
      await realAgentkitHeader(),
      cfg({ agentBook: book }),
    );
    expect(second.authorized).toBe(true); // served from the positive cache, never hits the RPC
  });

  test("a valid proof for a registered human IS authorized (positive control)", async () => {
    const header = await realAgentkitHeader();
    let calls = 0;
    const r = await verifyAgentkitRequest(
      header,
      cfg({
        agentBook: {
          lookupHuman: async () => {
            calls++;
            return HUMAN;
          },
        },
      }),
    );
    expect(calls).toBe(1);
    expect(r.authorized).toBe(true);
    expect((r as { humanId: string }).humanId).toBe(HUMAN);
  });
});

describe("paywall integration — World gate before payment", () => {
  function app(agentkit?: AgentkitSellerConfig, trustPolicy?: "open" | "accountable-only") {
    const a = new Hono();
    a.route(
      "/",
      buildPaywall({
        trustPolicy,
        price: 10_000n,
        payTo: "0x0000000000000000000000000000000000000001" as Address,
        asset: "0x3600000000000000000000000000000000000000" as Address,
        network: "eip155:5042002",
        resource: "/x402-demo/quote",
        resourceUrl: RESOURCE_URL,
        agentkit,
        serve: () => ({ quote: "demo" }),
      }),
    );
    return a;
  }

  test("no agentkit header -> normal 402 challenge, now carrying the extension", async () => {
    const res = await app(cfg()).request("/x402-demo/quote");
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: unknown[];
      extensions?: { agentkit?: { info?: { nonce?: string } } };
    };
    expect(body.accepts.length).toBe(1); // Arc payment requirements unchanged
    expect(body.extensions?.agentkit?.info?.nonce).toBeTruthy();
  });

  test("invalid agentkit header -> still 402 (fail-closed), with a reason header", async () => {
    const res = await app(cfg()).request("/x402-demo/quote", {
      headers: { agentkit: "garbage" },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("X-AGENTKIT-REASON")).toBeTruthy();
  });

  test("World gate absent -> paywall behaves exactly as before (no extensions key)", async () => {
    const res = await app(undefined).request("/x402-demo/quote");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { extensions?: unknown };
    expect(body.extensions).toBeUndefined();
  });
});

describe("authorization allowance (NOT a discount — an execution limit)", () => {
  test("allowance is consumed per human, then refuses -> settlement required", () => {
    const r = () => store.tryIncrementUsage(HUMAN, RESOURCE_URL, 2, Date.now());
    expect(r().allowed).toBe(true);
    expect(r().allowed).toBe(true);
    expect(r().allowed).toBe(false); // beyond allowance: agent must pay through its treasury
  });

  test("allowance is per-human, not per-agent-address (one human, many agents)", () => {
    // Two agent wallets backed by the SAME human share one allowance.
    store.cacheHuman("0xAGENT1", HUMAN, Date.now());
    store.cacheHuman("0xAGENT2", HUMAN, Date.now());
    expect(store.getCachedHuman("0xagent1", Date.now(), 60_000)).toBe(HUMAN);
    expect(store.getCachedHuman("0xagent2", Date.now(), 60_000)).toBe(HUMAN);
    const r = () => store.tryIncrementUsage(HUMAN, RESOURCE_URL, 1, Date.now());
    expect(r().allowed).toBe(true);
    expect(r().allowed).toBe(false); // second agent, same human -> same budget
  });
});

describe("accountable-only trust policy", () => {
  function strictApp(agentkit: AgentkitSellerConfig) {
    const a = new Hono();
    a.route(
      "/",
      buildPaywall({
        trustPolicy: "accountable-only",
        price: 10_000n,
        payTo: "0x0000000000000000000000000000000000000001" as Address,
        asset: "0x3600000000000000000000000000000000000000" as Address,
        network: "eip155:5042002",
        resource: "/x402-demo/quote",
        resourceUrl: RESOURCE_URL,
        agentkit,
        serve: () => ({ quote: "demo" }),
      }),
    );
    return a;
  }

  test("anonymous bot -> 403 doorway (never 402): remediation + challenge in the body", async () => {
    const res = await strictApp(cfg()).request("/x402-demo/quote");
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      how?: { register?: string; agentBook?: string };
      extensions?: { agentkit?: { info?: { nonce?: string } } };
    };
    expect(body.error).toBe("human_backing_required");
    expect(body.how?.register).toContain("agentkit-cli register");
    // The refusal teaches the proof format — a capable agent can fix its situation from it.
    expect(body.extensions?.agentkit?.info?.nonce).toBeTruthy();
  });

  test("garbage proof -> 403 with the failure reason, not 402", async () => {
    const res = await strictApp(cfg()).request("/x402-demo/quote", {
      headers: { agentkit: "garbage" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("human_backing_required");
    expect(body.reason).toBeTruthy();
  });

  test("not-human-backed wallet -> 403 refusal", async () => {
    // A structurally-valid header cannot be minted here without the full SIWE dance, so drive
    // verifyAgentkitRequest's outcome via a null AgentBook: header parse fails first with
    // invalid-message — still a refusal, which is the property under test: strict NEVER falls
    // through to a 402 for an unproven caller.
    const res = await strictApp(cfg({ agentBook: { lookupHuman: async () => null } })).request(
      "/x402-demo/quote",
      { headers: { agentkit: "garbage" } },
    );
    expect(res.status).toBe(403);
  });

  test("open mode with same config stays byte-identical: bot gets a 402 challenge", async () => {
    const a = new Hono();
    a.route(
      "/",
      buildPaywall({
        trustPolicy: "open",
        price: 10_000n,
        payTo: "0x0000000000000000000000000000000000000001" as Address,
        asset: "0x3600000000000000000000000000000000000000" as Address,
        network: "eip155:5042002",
        resource: "/x402-demo/quote",
        resourceUrl: RESOURCE_URL,
        agentkit: cfg(),
        serve: () => ({ quote: "demo" }),
      }),
    );
    const res = await a.request("/x402-demo/quote");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: unknown[] };
    expect(body.accepts.length).toBe(1);
  });
});

describe("windowed per-human rate cap", () => {
  test("counter resets after the window elapses", () => {
    const H = "human-1";
    const W = 60_000;
    const t0 = 1_000_000;
    expect(store.tryIncrementUsage(H, RESOURCE_URL, 2, t0, W).allowed).toBe(true);
    expect(store.tryIncrementUsage(H, RESOURCE_URL, 2, t0 + 1000, W).allowed).toBe(true);
    const t = t0 + 2000;
    const over = store.tryIncrementUsage(H, RESOURCE_URL, 2, t, W);
    expect(over.allowed).toBe(false);
    expect(over.resetAt).toBeGreaterThan(t); // 429 can carry Retry-After
    // window elapses -> budget returns
    const fresh = store.tryIncrementUsage(H, RESOURCE_URL, 2, t + W + 1, W);
    expect(fresh.allowed).toBe(true);
    expect(fresh.used).toBe(1);
  });

  test("no window -> legacy lifetime behavior unchanged", () => {
    const H = "human-2";
    expect(store.tryIncrementUsage(H, RESOURCE_URL, 1, 1_000).allowed).toBe(true);
    // a year later, still capped: lifetime semantics preserved for callers that pass no window
    expect(store.tryIncrementUsage(H, RESOURCE_URL, 1, 32_000_000_000).allowed).toBe(false);
  });
});

describe("rate budgets are keyed independently", () => {
  const H = "human-1";
  const RESOURCE = "https://x/x402-demo/quote";

  test("a separate rateKey does not spend the resource's budget", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteWorldStore(db);
    const t = 1_000_000;

    // The /proof demo runs on its own key…
    expect(store.tryIncrementUsage(H, `${RESOURCE}#proof-run`, 2, t).allowed).toBe(true);
    expect(store.tryIncrementUsage(H, `${RESOURCE}#proof-run`, 2, t).allowed).toBe(true);
    expect(store.tryIncrementUsage(H, `${RESOURCE}#proof-run`, 2, t).allowed).toBe(false);

    // …and the real seller's budget for the same human is untouched.
    expect(store.tryIncrementUsage(H, RESOURCE, 2, t).allowed).toBe(true);
  });

  test("nonces older than the replay window are swept away", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteWorldStore(db);
    const t0 = 1_000_000;

    // Enough inserts to trip the amortised sweep, all stamped long ago.
    for (let i = 0; i < 60; i++) expect(store.consumeNonce(`old-${i}`, t0)).toBe(true);
    const before = db.prepare("SELECT COUNT(*) AS n FROM world_nonces").get() as { n: number };
    expect(before.n).toBe(60);

    // A much later insert triggers a sweep that drops the stale rows.
    const later = t0 + 60 * 60_000;
    for (let i = 0; i < 50; i++) expect(store.consumeNonce(`new-${i}`, later)).toBe(true);
    const after = db.prepare("SELECT COUNT(*) AS n FROM world_nonces").get() as { n: number };
    expect(after.n).toBeLessThan(60);
  });
});
