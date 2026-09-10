import Database from "better-sqlite3";
import { Hono } from "hono";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, expect, test } from "vitest";
import {
  agentkitSignerFromKey,
  wrapFetchWithAgentkit,
} from "../../src/adapters/worldid/agentkitSigner";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { buyWithX402 } from "../../src/payments/buyer";
import type { LegalBodyResolution } from "../../src/payments/legalBody";
import { buildPaywall } from "../../src/payments/seller";
import type { SettleFn } from "../../src/payments/settle";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Address } from "../../src/types";

/**
 * The whole acceptance leg 3, in one process: OUR buyer, OUR AgentKit wrapper and OUR
 * `legal-bodies-only` paywall, with nothing stubbed between them — real SIWE proofs, real
 * single-use nonces, a real EIP-3009 payment, the real meter.
 *
 * It exists because the re-review had to build this harness by hand to discover that a purchase
 * could not complete at all (the paid leg replayed the recovery proof and was refused as a replay
 * AFTER the payment was signed). Every stub-level test in this suite passed at the time.
 */

const CHAIN_ID = 5042002;
const NETWORK = "eip155:5042002";
const RESOURCE_URL = "https://seller.example/x402-demo/legal-bodies-wall";
const PATH = "/x402-demo/legal-bodies-wall";
const PRICE = 10_000n;
const PAYOUT = "0x0000000000000000000000000000000000000001" as Address;
const HUMAN = "0x051dbcb350abbe853a25ef35c88c7a582281f88d1d8e26ed014bad0e34a7d234";
const POCKET_KEY = `0x${"5".repeat(64)}` as Hex;
const AGENT_ADDRESS = privateKeyToAccount(POCKET_KEY).address;

let store: SqliteWorldStore;
beforeEach(() => {
  const db = new Database(":memory:");
  migrate(db);
  store = new SqliteWorldStore(db);
});

const activeBody: LegalBodyResolution = {
  kind: "body",
  standing: "active",
  entity: { agentId: "843704", proxy: PAYOUT, treasury: PAYOUT, status: "funded" },
} as unknown as LegalBodyResolution;

/** Units of the human's allowance spent so far on this wall (a peek: limit 0 never writes). */
function unitsUsed(): number {
  return store.tryIncrementUsage(HUMAN, RESOURCE_URL, 0, Date.now()).used;
}

/** The wall, plus a fetch that reaches it — counting what the seller actually sees. */
function wall(
  opts: { allowancePerHuman?: number; legal?: LegalBodyResolution; settle?: SettleFn } = {},
) {
  const requests: Array<{ proof: boolean; payment: boolean; status: number }> = [];
  const app = new Hono();
  app.route(
    "/",
    buildPaywall({
      trustPolicy: "legal-bodies-only",
      price: PRICE,
      payTo: PAYOUT,
      asset: arcBatchingConfig.asset,
      network: NETWORK,
      resource: PATH,
      resourceUrl: RESOURCE_URL,
      agentkit: {
        domain: new URL(RESOURCE_URL).hostname,
        resourceUrl: RESOURCE_URL,
        network: NETWORK,
        store,
        allowancePerHuman: opts.allowancePerHuman ?? 3,
        agentBook: { lookupHuman: async () => HUMAN },
      },
      legalBody: {
        resolver: { resolve: async () => opts.legal ?? activeBody },
        lookupBaseUrl: "https://api.example",
        onboardUrl: "https://www.example/",
        transparencyUrl: "https://www.example/transparency",
      },
      ...(opts.settle ? { settle: opts.settle } : {}),
      serve: () => ({ quote: "demo" }),
    }),
  );

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers =
      input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers ?? {});
    if (input instanceof Request)
      new Headers(init?.headers ?? {}).forEach((v, k) => headers.set(k, v));
    const url = input instanceof Request ? input.url : String(input);
    const res = await app.request(new URL(url).pathname, { headers });
    requests.push({
      proof: headers.has("agentkit"),
      payment: headers.has("X-PAYMENT"),
      status: res.status,
    });
    return res;
  }) as typeof fetch;

  return { requests, fetchImpl };
}

/** The real payment the Authority would hand back. */
async function authorizeReal() {
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(POCKET_KEY),
    chainId: CHAIN_ID,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  return async (req: { payee: Address; amount: bigint }) => {
    const { header } = await signX402({
      payTo: req.payee,
      amount: req.amount,
      asset: arcBatchingConfig.asset,
      network: arcBatchingConfig.network,
      maxTimeoutSeconds: 60,
    });
    return { ok: true as const, header, ledgerId: 1 };
  };
}

test("a Novi agent buys from our own legal-bodies-only wall, end to end", async () => {
  const { requests, fetchImpl } = wall();
  const signer = agentkitSignerFromKey(POCKET_KEY, CHAIN_ID);
  const res = await buyWithX402(
    {
      // Exactly the composition `pay` builds: the AgentKit client wraps the fetch (it answers
      // 402s) and the buyer holds the same signer (it answers 403s).
      fetchImpl: wrapFetchWithAgentkit(fetchImpl, signer),
      authorize: await authorizeReal(),
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  );

  expect(res.status, JSON.stringify(requests)).toBe(200);
  expect(res.headers.get("X-NOVI-LEGAL-BODY")).toBe("843704");
  const body = (await res.json()) as { quote: string; legalBody: { agentId: string } };
  expect(body.quote).toBe("demo");
  expect(body.legalBody).toEqual({ agentId: "843704" });

  // The shape of the conversation: refused proofless, quoted once proved, served once paid.
  expect(requests[0]).toMatchObject({ proof: false, payment: false, status: 403 });
  expect(requests.at(-1)).toMatchObject({ proof: true, payment: true, status: 200 });
  // No leg is ever refused for a replayed proof (the R1 regression): the only 403 is the first.
  expect(requests.filter((r) => r.status === 403)).toHaveLength(1);
  // And the human's budget was not emptied by one purchase (R2): the paid leg costs nothing, so
  // the whole purchase fits inside the 402s it needed.
  const used = store.tryIncrementUsage(HUMAN, RESOURCE_URL, 0, Date.now()).used;
  expect(used).toBeLessThanOrEqual(2);
  expect(used).toBeGreaterThanOrEqual(1);
});

test("the purchase still completes on the tightest meter the wrapper allows", async () => {
  // Two units: one for the buyer's own proof leg, one for the AgentKit client's answer to that
  // leg's 402 (the SDK re-mints and re-fetches on any 402 carrying the extension — it cannot know
  // the request already carried a proof). The paying leg is free, which is what makes this fit.
  const { requests, fetchImpl } = wall({ allowancePerHuman: 2 });
  const signer = agentkitSignerFromKey(POCKET_KEY, CHAIN_ID);
  const res = await buyWithX402(
    {
      fetchImpl: wrapFetchWithAgentkit(fetchImpl, signer),
      authorize: await authorizeReal(),
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  );
  expect(res.status, JSON.stringify(requests)).toBe(200);
  expect(requests.some((r) => r.status === 429)).toBe(false);
});

test("the wall still refuses an agent no legal body stands behind, after its proof", async () => {
  const requests: Array<number> = [];
  const app = new Hono();
  app.route(
    "/",
    buildPaywall({
      trustPolicy: "legal-bodies-only",
      price: PRICE,
      payTo: PAYOUT,
      asset: arcBatchingConfig.asset,
      network: NETWORK,
      resource: PATH,
      resourceUrl: RESOURCE_URL,
      agentkit: {
        domain: new URL(RESOURCE_URL).hostname,
        resourceUrl: RESOURCE_URL,
        network: NETWORK,
        store,
        allowancePerHuman: 3,
        agentBook: { lookupHuman: async () => HUMAN },
      },
      legalBody: {
        resolver: { resolve: async () => ({ kind: "none" }) as LegalBodyResolution },
        lookupBaseUrl: "https://api.example",
        onboardUrl: "https://www.example/",
        transparencyUrl: "https://www.example/transparency",
      },
      serve: () => ({ quote: "demo" }),
    }),
  );
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers =
      input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers ?? {});
    if (input instanceof Request)
      new Headers(init?.headers ?? {}).forEach((v, k) => headers.set(k, v));
    const res = await app.request(PATH, { headers });
    requests.push(res.status);
    return res;
  }) as typeof fetch;

  const signer = agentkitSignerFromKey(POCKET_KEY, CHAIN_ID);
  const err = await buyWithX402(
    {
      fetchImpl: wrapFetchWithAgentkit(fetchImpl, signer),
      authorize: await authorizeReal(),
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  ).catch((e: Error) => e);

  // The user-visible half of the demo: the reason names the missing thing, and the address it
  // names is the agent's own pocket — nothing was signed for money.
  expect((err as Error).message).toContain("resource-403-after-proof");
  expect((err as Error).message).toContain("legal_body_required");
  expect((err as Error).message).toContain("not-legal-body");
  expect(AGENT_ADDRESS).toBeTruthy();
  expect(requests).toEqual([403, 403]);
});

// ── what a purchase costs, end to end through the REAL wrapper (fix round 2) ────────────────────
//
// The buyer answers the 403 itself and then goes AROUND the AgentKit wrapper (`directFetch`).
// Left wrapped, the client answers our recovery leg's own 402 with a second minted proof and a
// second request — the seller charges the human for it, and a purchase costs two of the three
// units prod gives a human per 24 h.

test("a completed purchase costs exactly ONE unit through the wrapper", async () => {
  const { requests, fetchImpl } = wall();
  const signer = agentkitSignerFromKey(POCKET_KEY, CHAIN_ID);
  const res = await buyWithX402(
    {
      fetchImpl: wrapFetchWithAgentkit(fetchImpl, signer),
      directFetch: fetchImpl,
      authorize: await authorizeReal(),
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  );
  expect(res.status, JSON.stringify(requests)).toBe(200);
  expect(unitsUsed()).toBe(1);
  // Three requests, not four: refused, quoted, served.
  expect(requests.map((r) => r.status)).toEqual([403, 402, 200]);
});

test("a refused purchase costs exactly ONE unit, and a 503 costs none", async () => {
  const refusedWall = wall({ legal: { kind: "none" } as LegalBodyResolution });
  const signer = agentkitSignerFromKey(POCKET_KEY, CHAIN_ID);
  const err = await buyWithX402(
    {
      fetchImpl: wrapFetchWithAgentkit(refusedWall.fetchImpl, signer),
      directFetch: refusedWall.fetchImpl,
      authorize: await authorizeReal(),
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  ).catch((e: Error) => e);
  expect((err as Error).message).toContain("legal_body_required");
  expect(unitsUsed()).toBe(1); // the refusal did real work: an AgentBook read and two Arc reads

  // A check we could not complete is OUR failure, so the meter must not move at all.
  const before = unitsUsed();
  const brokenWall = wall({
    legal: { kind: "body", standing: "unknown" } as unknown as LegalBodyResolution,
  });
  const res = await buyWithX402(
    {
      fetchImpl: wrapFetchWithAgentkit(brokenWall.fetchImpl, signer),
      directFetch: brokenWall.fetchImpl,
      authorize: await authorizeReal(),
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  );
  expect(res.status).toBe(503);
  expect(unitsUsed()).toBe(before);
});

test("a human with a budget of ONE completes a purchase through the wrapper", async () => {
  // The acceptance shape at the tightest meter: two units per purchase would 429 this buyer
  // mid-payment, which is what it cost before the wrapper was taken out of the recovery legs.
  const { requests, fetchImpl } = wall({ allowancePerHuman: 1 });
  const signer = agentkitSignerFromKey(POCKET_KEY, CHAIN_ID);
  const res = await buyWithX402(
    {
      fetchImpl: wrapFetchWithAgentkit(fetchImpl, signer),
      directFetch: fetchImpl,
      authorize: await authorizeReal(),
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  );
  expect(res.status, JSON.stringify(requests)).toBe(200);
  expect(requests.some((r) => r.status === 429)).toBe(false);
  expect(unitsUsed()).toBe(1);
});

test("a NON-strict AgentKit seller is untouched: the wrapper still answers its 402, one unit, no header on the first request", async () => {
  // The rule `directFetch` must not break: on an `open` seller the buyer never sees a 403, so it
  // never takes over, and the wrapped fetch does exactly what it always did — mint on the 402 and
  // retry. The first request still carries no proof.
  const requests: Array<{ proof: boolean; status: number }> = [];
  const app = new Hono();
  app.route(
    "/",
    buildPaywall({
      trustPolicy: "open",
      price: PRICE,
      payTo: PAYOUT,
      asset: arcBatchingConfig.asset,
      network: NETWORK,
      resource: PATH,
      resourceUrl: RESOURCE_URL,
      agentkit: {
        domain: new URL(RESOURCE_URL).hostname,
        resourceUrl: RESOURCE_URL,
        network: NETWORK,
        store,
        allowancePerHuman: 3,
        agentBook: { lookupHuman: async () => HUMAN },
      },
      serve: () => ({ quote: "demo" }),
    }),
  );
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers =
      input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers ?? {});
    if (input instanceof Request)
      new Headers(init?.headers ?? {}).forEach((v, k) => headers.set(k, v));
    const res = await app.request(PATH, { headers });
    requests.push({ proof: headers.has("agentkit"), status: res.status });
    return res;
  }) as typeof fetch;

  const signer = agentkitSignerFromKey(POCKET_KEY, CHAIN_ID);
  const authorize = await authorizeReal();
  const res = await buyWithX402(
    {
      fetchImpl: wrapFetchWithAgentkit(fetchImpl, signer),
      directFetch: fetchImpl,
      authorize,
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as { humanBacked: boolean }).humanBacked).toBe(true);
  expect(requests[0]?.proof).toBe(false); // never on the first request
  expect(requests.map((r) => r.status)).toEqual([402, 200]);
  expect(unitsUsed()).toBe(1);
});

test("an unfunded payment costs a unit: the purchase dies at settlement, not for free (F2)", async () => {
  // The whole attack in one purchase: signing an EIP-3009 authorization needs no USDC, and until
  // this fix the paying request was exempt from the meter on the strength of that signature alone.
  const { requests, fetchImpl } = wall({
    settle: async () => ({ ok: false as const, reason: "insufficient-funds" }),
  });
  const signer = agentkitSignerFromKey(POCKET_KEY, CHAIN_ID);
  const res = await buyWithX402(
    {
      fetchImpl: wrapFetchWithAgentkit(fetchImpl, signer),
      directFetch: fetchImpl,
      authorize: await authorizeReal(),
      agentkitSigner: signer,
    },
    RESOURCE_URL,
  );
  expect(res.status, JSON.stringify(requests)).toBe(402);
  expect(((await res.json()) as { error: string }).error).toBe("settle-failed:insufficient-funds");
  // One unit for the 402 that quoted it, one for the request that failed to settle.
  expect(unitsUsed()).toBe(2);
  expect(requests.map((r) => r.status)).toEqual([403, 402, 402]);
});
