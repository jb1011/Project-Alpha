import Database from "better-sqlite3";
import { Hono } from "hono";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, test } from "vitest";
import {
  agentkitSignerFromKey,
  wrapFetchWithAgentkit,
} from "../../src/adapters/worldid/agentkitSigner";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import type { LegalBodyResolution } from "../../src/payments/legalBody";
import type { SellerLegalBodyConfig } from "../../src/payments/seller";
import { buildPaywall } from "../../src/payments/seller";
import type { AgentkitSellerConfig } from "../../src/payments/worldVerifier";
import {
  chargeAllowance,
  mintAgentkitExtension,
  verifyAgentkitRequest,
} from "../../src/payments/worldVerifier";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Address, EntityRecord } from "../../src/types";

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
  test("hand-mints nonce/issuedAt/expirationTime (SDK omits them; client rejects without)", async () => {
    const ext = (await mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    })) as { agentkit: { info: Record<string, unknown>; supportedChains: unknown[] } };
    expect(ext.agentkit.info.nonce).toBeTruthy();
    expect(ext.agentkit.info.issuedAt).toBeTruthy();
    expect(ext.agentkit.info.expirationTime).toBeTruthy();
    expect(ext.agentkit.info.domain).toBe("example.com");
    expect(ext.agentkit.supportedChains.length).toBeGreaterThan(0);
  });

  test("REGRESSION: nonce is alphanumeric (SIWE rejects hyphens -> silent skip)", async () => {
    // randomUUID() is the obvious choice and is what World's own example shows, but its hyphens
    // make the client's createHeader throw a SiweError, which it swallows as `agentkit_skipped`:
    // the agent is never authorized and nothing surfaces the reason. Keep this alphanumeric.
    for (let i = 0; i < 20; i++) {
      const ext = (await mintAgentkitExtension({
        domain: "example.com",
        resourceUrl: RESOURCE_URL,
        network: "eip155:5042002",
        allowancePerHuman: 3,
      })) as { agentkit: { info: { nonce: string } } };
      expect(ext.agentkit.info.nonce).toMatch(/^[a-zA-Z0-9]{8,}$/);
    }
  });

  test("each mint carries a fresh nonce (no cross-response replay)", async () => {
    const a = (await mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    })) as { agentkit: { info: { nonce: string } } };
    const b = (await mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    })) as { agentkit: { info: { nonce: string } } };
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

  test("chargeAllowance:false verifies the proof WITHOUT moving the meter", async () => {
    // The seam the legal-body policy needs: it has to know who the human is before it can ask the
    // second question, but must not spend the human's budget on an answer we may fail to produce.
    const one = cfg({ allowancePerHuman: 1 });
    const a = await verifyAgentkitRequest(await realAgentkitHeader(), one, {
      chargeAllowance: false,
    });
    const b = await verifyAgentkitRequest(await realAgentkitHeader(), one, {
      chargeAllowance: false,
    });
    expect(a.authorized).toBe(true);
    expect(b.authorized).toBe(true); // a single unit, and it is still there
    expect((a as { used: number }).used).toBe(0);

    // …and the explicit charge is what spends it.
    expect(chargeAllowance(one, HUMAN)).toEqual({ allowed: true, used: 1, limit: 1 });
    expect(chargeAllowance(one, HUMAN)).toEqual({ allowed: false, used: 1, limit: 1 });
  });

  test("chargeAllowance:false still REFUSES an exhausted human (the cap is not skipped)", async () => {
    const one = cfg({ allowancePerHuman: 1 });
    expect(chargeAllowance(one, HUMAN).allowed).toBe(true);
    const r = await verifyAgentkitRequest(await realAgentkitHeader(), one, {
      chargeAllowance: false,
    });
    expect(r.authorized).toBe(false);
    expect((r as { reason: string }).reason).toBe("allowance-exhausted");
    expect((r as { used: number }).used).toBe(1);
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

// ── legal-bodies-only: AgentBook's "is there a human?" PLUS "is there a legal body?" ──────────
// (design 2026-09-10 D4/D7/D8)
//
// The property under test throughout: this policy is accountable-only with a SECOND gate bolted
// after it, and it never softens the first one. A human-backed agent with no legal body is still
// refused; a failed legal read refuses too (fail-closed, D8) rather than waving the agent through.
describe("legal-bodies-only trust policy", () => {
  const PAYOUT = "0x00000000000000000000000000000000000000ab" as Address;
  const LOOKUP_BASE = "https://api.novicorpus.test";
  const ONBOARD = "https://www.novicorpus.test/";
  const TRANSPARENCY = "https://www.novicorpus.test/transparency";
  const AGENT_ADDRESS = privateKeyToAccount(AGENT_KEY).address;

  /** Only the fields the seller path actually reads — the resolver is stubbed, so the rest of
   *  EntityRecord would be decoration that could drift away from the real record for free. */
  const bodyEntity = (agentId: string | null = "843704") =>
    ({ name: "TestMB2", status: "funded", agentId }) as unknown as EntityRecord;

  const asBody = (standing: "active" | "inactive" | "unknown", agentId?: string | null) =>
    ({
      kind: "body",
      entity: bodyEntity(agentId),
      standing,
      matchedBy: "pocket",
    }) as LegalBodyResolution;

  /** The resolver stub records every address it was asked for: the refusal has to point the
   *  caller at the address that was actually CHECKED (the proof's signer), and a test that only
   *  asserted the verdict could not tell the difference if that ever drifted. */
  function legalDeps(
    answer: LegalBodyResolution | (() => Promise<LegalBodyResolution>),
    seen: string[] = [],
  ): { deps: SellerLegalBodyConfig; seen: string[] } {
    return {
      seen,
      deps: {
        resolver: {
          resolve: async (address: string) => {
            seen.push(address);
            return typeof answer === "function" ? await answer() : answer;
          },
        },
        lookupBaseUrl: LOOKUP_BASE,
        onboardUrl: ONBOARD,
        transparencyUrl: TRANSPARENCY,
      },
    };
  }

  function legalApp(legalBody?: SellerLegalBodyConfig, agentkit: AgentkitSellerConfig = cfg()) {
    const a = new Hono();
    a.route(
      "/",
      buildPaywall({
        trustPolicy: "legal-bodies-only",
        price: 10_000n,
        payTo: PAYOUT,
        asset: arcBatchingConfig.asset,
        network: "eip155:5042002",
        resource: "/x402-demo/quote",
        resourceUrl: RESOURCE_URL,
        agentkit,
        legalBody,
        serve: () => ({ quote: "demo" }),
      }),
    );
    return a;
  }

  /** A real, signed X-PAYMENT for this wall — the only way to reach the 200 that carries the
   *  legal-body header, since the policy grants no free service. */
  async function payment(amount: bigint) {
    const signX402 = makeSignX402({
      signer: pocketSignerFromKey(`0x${"2".repeat(64)}` as Hex),
      chainId: 5042002,
      network: arcBatchingConfig.network,
      verifyingContract: arcBatchingConfig.verifyingContract,
    });
    return (
      await signX402({
        payTo: PAYOUT,
        amount,
        asset: arcBatchingConfig.asset,
        network: arcBatchingConfig.network,
        maxTimeoutSeconds: 60,
      })
    ).header;
  }

  test("no proof at all -> the accountable-only refusal, unchanged", async () => {
    const { deps, seen } = legalDeps({ kind: "none" });
    const res = await legalApp(deps).request("/x402-demo/quote");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("human_backing_required");
    expect(body.reason).toBe("no-proof-presented");
    expect(seen).toEqual([]); // no human -> the legal question is never even asked
  });

  test("garbage proof -> the human refusal, and no legal read is spent on it", async () => {
    const { deps, seen } = legalDeps({ kind: "none" });
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: "garbage" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("human_backing_required");
    expect(seen).toEqual([]);
  });

  test("human-backed but NOT a legal body -> 403 legal_body_required, pointing at its own address", async () => {
    const { deps, seen } = legalDeps({ kind: "none" });
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      detail: string;
      reason: string;
      how: { lookup: string; onboard: string; transparency: string };
      extensions?: { agentkit?: { info?: { nonce?: string } } };
    };
    expect(body.error).toBe("legal_body_required");
    expect(body.detail).toBe(
      "this seller trades only with agents that a registered legal body in good standing stands behind",
    );
    expect(body.reason).toBe("not-legal-body");
    // The address CHECKED is the proof's signer — and it is the address the refusal tells the
    // caller to look up, so following the link cannot land on a different question.
    expect(seen.length).toBe(1);
    const asked = seen[0] ?? "";
    // EIP-55, exactly — Task 2's lookup takes `isAddress(x, {strict: true})`, i.e. checksummed or
    // all-lowercase and nothing between. siwe enforces the checksum on the proof's address today,
    // so this holds by construction; pin it, or an SDK that relaxes it ships a 400 link to buyers.
    expect(asked).toBe(AGENT_ADDRESS);
    expect(body.how.lookup).toBe(`${LOOKUP_BASE}/legal-bodies/${asked}`);
    expect(body.how.onboard).toBe(ONBOARD);
    expect(body.how.transparency).toBe(TRANSPARENCY);
    // Still a doorway, not a wall: the challenge rides along so a capable agent can retry.
    expect(body.extensions?.agentkit?.info?.nonce).toBeTruthy();
    // The human header is still set — we DID verify the human, and said so.
    expect(res.headers.get("X-AGENTKIT-HUMAN")).toBe(HUMAN);
    expect(res.headers.get("X-NOVI-LEGAL-BODY")).toBeNull();
  });

  test("a suspended body -> 403 with reason legal-body-inactive (a different fact, said plainly)", async () => {
    const { deps } = legalDeps(asBody("inactive"));
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string; how: { lookup: string } };
    expect(body.error).toBe("legal_body_required");
    expect(body.reason).toBe("legal-body-inactive");
    expect(body.how.lookup).toContain("/legal-bodies/");
    expect(res.headers.get("X-NOVI-LEGAL-BODY")).toBeNull();
  });

  test("a failed chain read -> 503, never a guess in either direction (D8)", async () => {
    const { deps } = legalDeps(asBody("unknown"));
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("legal_body_check_unavailable");
    expect(body.detail).toBeTruthy();
    expect(res.headers.get("X-NOVI-LEGAL-BODY")).toBeNull();
  });

  test("no resolver wired -> every request 503, fail-closed (never open by omission)", async () => {
    const app = legalApp(undefined);
    // Even the anonymous caller: a policy this deployment cannot evaluate authorizes nobody.
    const anon = await app.request("/x402-demo/quote");
    expect(anon.status).toBe(503);
    expect(((await anon.json()) as { error: string }).error).toBe("legal_body_check_unavailable");
    const proven = await app.request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(proven.status).toBe(503);
  });

  test("an ACTIVE legal body still pays — and the 402 already carries X-NOVI-LEGAL-BODY", async () => {
    const { deps, seen } = legalDeps(asBody("active"));
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    // Standing is not a discount: the gate opens onto the normal invoice.
    expect(res.status).toBe(402);
    expect(seen.length).toBe(1);
    expect(res.headers.get("X-NOVI-LEGAL-BODY")).toBe("843704");
    expect(res.headers.get("X-AGENTKIT-HUMAN")).toBe(HUMAN);
    const body = (await res.json()) as { accepts: unknown[] };
    expect(body.accepts.length).toBe(1);
  });

  test("ACTIVE + a valid payment -> 200 with the header and legalBody on the receipt", async () => {
    const { deps } = legalDeps(asBody("active"));
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader(), "X-PAYMENT": await payment(10_000n) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-NOVI-LEGAL-BODY")).toBe("843704");
    const body = (await res.json()) as {
      quote: string;
      humanBacked: boolean;
      legalBody: { agentId: string | null };
    };
    expect(body.quote).toBe("demo");
    expect(body.humanBacked).toBe(true);
    expect(body.legalBody).toEqual({ agentId: "843704" });
  });

  test("an active body with no agent id yet -> served, header omitted rather than faked", async () => {
    const { deps } = legalDeps(asBody("active", null));
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader(), "X-PAYMENT": await payment(10_000n) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-NOVI-LEGAL-BODY")).toBeNull();
    expect(((await res.json()) as { legalBody: unknown }).legalBody).toEqual({ agentId: null });
  });

  test("REGRESSION: accountable-only never consults the legal resolver", async () => {
    const { deps, seen } = legalDeps({ kind: "none" });
    const a = new Hono();
    a.route(
      "/",
      buildPaywall({
        trustPolicy: "accountable-only",
        price: 10_000n,
        payTo: PAYOUT,
        asset: arcBatchingConfig.asset,
        network: "eip155:5042002",
        resource: "/x402-demo/quote",
        resourceUrl: RESOURCE_URL,
        agentkit: cfg(),
        legalBody: deps,
        serve: () => ({ quote: "demo" }),
      }),
    );
    const res = await a.request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(res.status).toBe(402); // the old behaviour, to the byte
    expect(seen).toEqual([]);
  });

  // ── the meter (review R3): a refusal we caused must not cost the buyer a unit ───────────────
  //
  // The allowance is a RATE CAP, so a definitive refusal is rightly charged: it cost this seller a
  // signature verification, an AgentBook read and two Arc reads. A 503 is different — it is OUR
  // failure, and its own detail invites a retry. Charging it would let one bad minute of RPC lock
  // a legitimate legal body out for the rest of the 24 h window, which is the exact buyer this
  // policy exists to serve.

  test("an exhausted human is rate-capped BEFORE any legal read is spent on it", async () => {
    const { deps, seen } = legalDeps({ kind: "none" });
    // Burn the human's two units on this resource, as earlier requests would have.
    expect(store.tryIncrementUsage(HUMAN, RESOURCE_URL, 2, Date.now()).allowed).toBe(true);
    expect(store.tryIncrementUsage(HUMAN, RESOURCE_URL, 2, Date.now()).allowed).toBe(true);
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate-capped");
    // The point of the ordering: a rate-capped caller never reaches the chain.
    expect(seen).toEqual([]);
  });

  test("a 503 spends NOTHING: the next request still has the full budget", async () => {
    let standing: "unknown" | "active" = "unknown";
    const { deps } = legalDeps(async () => asBody(standing));
    const app = legalApp(deps);

    const down = await app.request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(down.status).toBe(503);
    // Nothing was charged, so there is no usage to report — the header is absent, not "0/2".
    expect(down.headers.get("X-AGENTKIT-AUTHORIZATION")).toBeNull();

    // The RPC comes back and the very same agent retries: it is on its FIRST unit, not its second.
    standing = "active";
    const up = await app.request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(up.status).toBe(402);
    expect(up.headers.get("X-AGENTKIT-AUTHORIZATION")).toBe("1/2");
  });

  test("a definitive refusal DOES cost a unit — the meter is a rate cap, not an entitlement", async () => {
    const { deps } = legalDeps({ kind: "none" });
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader() },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("legal_body_required");
    expect(res.headers.get("X-AGENTKIT-AUTHORIZATION")).toBe("1/2");
  });

  test("a served request costs exactly one unit, charged once", async () => {
    const { deps } = legalDeps(asBody("active"));
    const res = await legalApp(deps).request("/x402-demo/quote", {
      headers: { agentkit: await realAgentkitHeader(), "X-PAYMENT": await payment(10_000n) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-AGENTKIT-AUTHORIZATION")).toBe("1/2");
  });

  test("no agentkit config -> 503, never an OPEN seller under the strictest policy (R4)", async () => {
    // A box that loses its World config must not quietly start selling to anonymous payers while
    // its own env still says legal-bodies-only.
    const a = new Hono();
    a.route(
      "/",
      buildPaywall({
        trustPolicy: "legal-bodies-only",
        price: 10_000n,
        payTo: PAYOUT,
        asset: arcBatchingConfig.asset,
        network: "eip155:5042002",
        resource: "/x402-demo/quote",
        resourceUrl: RESOURCE_URL,
        legalBody: legalDeps(asBody("active")).deps,
        serve: () => ({ quote: "demo" }),
      }),
    );
    const anon = await a.request("/x402-demo/quote");
    expect(anon.status).toBe(503);
    expect(((await anon.json()) as { error: string }).error).toBe("legal_body_check_unavailable");
    // …and a real payment does not buy its way past it either.
    const paid = await a.request("/x402-demo/quote", {
      headers: { "X-PAYMENT": await payment(10_000n) },
    });
    expect(paid.status).toBe(503);
  });
});
