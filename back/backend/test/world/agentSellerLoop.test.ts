import Database from "better-sqlite3";
import { Hono } from "hono";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, expect, test } from "vitest";
import {
  agentkitSignerFromKey,
  wrapFetchWithAgentkit,
} from "../../src/adapters/worldid/agentkitSigner";
import { buildPaywall } from "../../src/payments/seller";
import type { AgentkitSellerConfig } from "../../src/payments/worldVerifier";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Address } from "../../src/types";

// Real agent key -> real EIP-191 signatures, verified by the real seller-side gate.
const AGENT_KEY = `0x${"7".repeat(64)}` as Hex;
const AGENT = privateKeyToAccount(AGENT_KEY);
const HUMAN = "0x051dbcb350abbe853a25ef35c88c7a582281f88d1d8e26ed014bad0e34a7d234";
const ORIGIN = "https://seller.example.com";
const RESOURCE_URL = `${ORIGIN}/x402-demo/quote`;

let store: SqliteWorldStore;
beforeEach(() => {
  const db = new Database(":memory:");
  migrate(db);
  store = new SqliteWorldStore(db);
});

/** Seller app whose AgentBook lookup is stubbed (registration state is the thing we vary). */
function sellerApp(opts: { registered: boolean; allowance: number }) {
  const agentkit: AgentkitSellerConfig = {
    domain: new URL(RESOURCE_URL).hostname,
    resourceUrl: RESOURCE_URL,
    network: "eip155:5042002",
    store,
    allowancePerHuman: opts.allowance,
    agentBook: { lookupHuman: async () => (opts.registered ? HUMAN : null) },
  };
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
      agentkit,
      serve: () => ({ quote: "demo" }),
    }),
  );
  return app;
}

/** fetch bound to the in-process seller app. Handles string | URL | Request (the SDK retries
 *  with a Request object carrying the signed `agentkit` header). */
function fetchTo(app: Hono): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      new Headers(init?.headers ?? {}).forEach((v, k) => headers.set(k, v));
      return app.request(new URL(input.url).pathname, {
        method: init?.method ?? input.method,
        headers,
      });
    }
    const url = typeof input === "string" ? input : (input as URL).toString();
    return app.request(new URL(url).pathname, init);
  }) as typeof fetch;
}

test("human-backed agent is AUTHORIZED end-to-end (real signature, real gate)", async () => {
  const app = sellerApp({ registered: true, allowance: 2 });
  const signer = agentkitSignerFromKey(AGENT_KEY, 5042002);
  expect(signer.address).toBe(AGENT.address);

  const wrapped = wrapFetchWithAgentkit(fetchTo(app), signer);
  const res = await wrapped(RESOURCE_URL);

  expect(res.status).toBe(200); // 402 -> signed proof -> retry -> authorized, no payment
  const body = (await res.json()) as { humanBacked?: boolean; authorization?: { used: number } };
  expect(body.humanBacked).toBe(true);
  expect(body.authorization?.used).toBe(1);
  expect(res.headers.get("X-AGENTKIT-HUMAN")).toBe(HUMAN);
});

test("unregistered agent is NOT authorized -> falls through to the 402 payment path", async () => {
  const app = sellerApp({ registered: false, allowance: 2 });
  const wrapped = wrapFetchWithAgentkit(fetchTo(app), agentkitSignerFromKey(AGENT_KEY, 5042002));
  const res = await wrapped(RESOURCE_URL);

  expect(res.status).toBe(402); // must pay through the governed treasury instead
  expect(res.headers.get("X-AGENTKIT-REASON")).toContain("not-human-backed");
});

test("allowance exhausts -> subsequent calls fall through to payment (authorization limit)", async () => {
  const app = sellerApp({ registered: true, allowance: 1 });
  const wrapped = wrapFetchWithAgentkit(fetchTo(app), agentkitSignerFromKey(AGENT_KEY, 5042002));

  expect((await wrapped(RESOURCE_URL)).status).toBe(200); // within allowance
  const second = await wrapped(RESOURCE_URL);
  expect(second.status).toBe(402); // beyond it: settlement required
  expect(second.headers.get("X-AGENTKIT-REASON")).toContain("allowance-exhausted");
});

test("wrapper is transparent to sellers without the agentkit extension", async () => {
  const plain = new Hono();
  plain.get("/x402-demo/quote", (c) => c.json({ ok: true }, 200));
  const wrapped = wrapFetchWithAgentkit(fetchTo(plain), agentkitSignerFromKey(AGENT_KEY, 5042002));
  const res = await wrapped(RESOURCE_URL);
  expect(res.status).toBe(200);
  expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
});
