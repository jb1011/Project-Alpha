/**
 * GET /verify/:publicId — the paid legal-standing check on Hedera (task 6, design D9, D30).
 *
 * Everything below runs against the SHARED scaffold (`test/helpers/hederaApp.ts`): a real
 * in-memory database with the demo entity seeded, a real `PaymentLedger` over it, scripted Arc
 * reads and a scripted mirror node. The x402 middleware, the resource server and the Hedera
 * scheme are the REAL packages — only the facilitator's three HTTP endpoints are stubbed, on the
 * global `fetch` (`HTTPFacilitatorClient` has no `fetch` option), because the seams this file
 * exists to catch all live between our two layers of middleware and theirs.
 *
 * The order of the layers is the whole point (D9): the 404 guard and the rate limiter run BEFORE
 * any 402 is issued, so a caller is never quoted a price for a body we do not have.
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { PaymentLedger } from "../../src/payments/ledger";
import type { EntityRecord } from "../../src/types";
import {
  IDENTITY_REGISTRY,
  METADATA_BASE,
  PUBLIC_ID,
  TENANT,
  WEB,
  arcReads,
  fakeMirror,
  hederaApp,
  hederaDb,
} from "../helpers/hederaApp";

const HEDERA_CFG = {
  network: "testnet",
  facilitatorUrl: "https://f.test",
  mirrorUrl: "https://m.test",
  usdcTokenId: "0.0.429274",
  payToAccountId: "0.0.10412694",
  verifyPriceUsdc: "0.001",
  verifyPriceAtomic: 1000n,
} as const;

const NETWORK = "hedera:testnet";
const FEE_PAYER = "0.0.7162784";
const TX = "0.0.7162784@1788998489.006924053";
const UNKNOWN_ID = "11111111-2222-3333-4444-555555555555";

/** The facilitator's `/supported`, exactly the shape Blocky402 testnet answers with. The Hedera
 *  scheme copies `extra.feePayer` out of it into every requirement, and a resource server that
 *  never saw it throws on the first request — which is why every test here stubs this path. */
const SUPPORTED = {
  kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer: FEE_PAYER } }],
  extensions: [],
  signers: { "hedera:*": [FEE_PAYER] },
};

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Every facilitator path this stub was asked for, in order. */
let seen: string[];
let verifyReply: unknown;
let settleReply: unknown;

beforeEach(() => {
  seen = [];
  verifyReply = { isValid: true, payer: "0.0.10450558" };
  settleReply = { success: true, transaction: TX, network: NETWORK };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === "/supported") return reply(SUPPORTED);
    if (path === "/verify") return reply(verifyReply);
    if (path === "/settle") return reply(settleReply);
    throw new Error(`unexpected fetch: ${url}`);
  });
});

const openDbs: Database.Database[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (openDbs.length) openDbs.pop()?.close();
});

/** Nothing but `/supported` — the assertion "no price was quoted and no payment was attempted". */
const onlySupported = () => seen.filter((p) => p !== "/supported");

/** The guardian's World ID verification, as `metadata.ts` reads it. */
const WORLD = {
  store: {
    findByTenant: () => ({
      credential: "orb",
      nullifier: "n",
      verifiedAt: 1,
      environment: "production",
    }),
  },
  cfg: { action: "guardian-verification" },
};

function setup(
  o: {
    over?: Partial<EntityRecord>;
    /** Off = no `hedera` dep at all, which must leave the route unmounted. */
    hedera?: boolean;
    readBudget?: TokenBucket;
    worldId?: unknown;
  } = {},
) {
  const { db, repo } = hederaDb(o.over);
  openDbs.push(db);
  const ledger = new PaymentLedger(db);
  const app = hederaApp({
    repo,
    hedera:
      o.hedera === false
        ? undefined
        : {
            cfg: HEDERA_CFG,
            mirror: fakeMirror({}),
            ledger,
            spendAllowlistThreshold: 1_000_000_000n,
          },
    legalBody: {
      resolver: { resolve: async () => ({ kind: "none" }) },
      chainReads: arcReads(),
      readBudget: o.readBudget ?? new TokenBucket(30, 1),
      links: { transparency: `${WEB}/transparency`, metadataBase: METADATA_BASE },
      network: "testnet" as const,
    },
    worldId: "worldId" in o ? o.worldId : WORLD,
  });
  return { app, repo };
}

type App = ReturnType<typeof hederaApp>;
/** Each caller its own forwarded-for, so "many requests" never accidentally means "one client's
 *  whole allowance" — the per-client bucket is keyed on exactly this header. */
const get = (app: App, publicId: string, headers: Record<string, string> = {}) =>
  app.request(`/verify/${publicId}`, { headers: { "x-forwarded-for": "9.9.9.9", ...headers } });

/** A well-formed v2 payload for the requirements the server just quoted. Built from the quote
 *  itself rather than hand-written, because `findMatchingRequirements` deep-equals the two. */
async function paidHeader(app: App, publicId: string, client: string): Promise<string> {
  const quote = await get(app, publicId, { "x-forwarded-for": client });
  const required = decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED") ?? "");
  const accepted = (required as { accepts: unknown[] }).accepts[0];
  return Buffer.from(
    JSON.stringify({ x402Version: 2, accepted, payload: { signedTransaction: "0xdeadbeef" } }),
  ).toString("base64");
}

// ── the flag, and the two 404s that come before any price ───────────────────────────────────────

test("with the Hedera flag off the route is not mounted at all", async () => {
  const { app } = setup({ hedera: false });
  const res = await get(app, PUBLIC_ID);
  expect(res.status).toBe(404);
  expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  expect(seen).toEqual([]);
});

test("an unknown publicId is 404 and is never quoted a price", async () => {
  const { app } = setup();
  const res = await get(app, UNKNOWN_ID);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
  expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  expect(onlySupported()).toEqual([]);
});

test("a malformed publicId is the same 404, with no price", async () => {
  const { app } = setup();
  const res = await get(app, "not-a-uuid");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
  expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  expect(onlySupported()).toEqual([]);
});

test("an entity that is not public on chain is 404, with no price", async () => {
  const { app } = setup({ over: { status: "pending" } });
  const res = await get(app, PUBLIC_ID);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
  expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  expect(onlySupported()).toEqual([]);
});

// ── the quote ───────────────────────────────────────────────────────────────────────────────────

test("a known entity with no payment header is quoted in the PAYMENT-REQUIRED header", async () => {
  const { app } = setup();
  const res = await get(app, PUBLIC_ID);
  expect(res.status).toBe(402);
  // v2 carries the requirements in the HEADER; the body is `{}` (design Pre-cleared).
  expect(await res.json()).toEqual({});
  const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "");
  const accepts = (required as { accepts: Record<string, unknown>[] }).accepts;
  expect(accepts[0]).toMatchObject({
    scheme: "exact",
    network: NETWORK,
    payTo: HEDERA_CFG.payToAccountId,
    asset: HEDERA_CFG.usdcTokenId,
    amount: "1000",
    extra: { feePayer: FEE_PAYER },
  });
  expect(onlySupported()).toEqual([]);
});

test("the quote's description never claims more than a registered legal body in good standing", async () => {
  const { app } = setup();
  const res = await get(app, PUBLIC_ID);
  const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "");
  const description = (required as { resource?: { description?: string } }).resource?.description;
  expect(description).toBe(
    "Novi Corpus legal-standing check: is this a registered legal body in good standing?",
  );
  for (const forbidden of ["verified company", "KYC", "licensed"])
    expect(description).not.toContain(forbidden);
});

// ── the limits, which come before the price ─────────────────────────────────────────────────────

test("a client that exhausts its own allowance is refused before any 402", async () => {
  const { app } = setup();
  for (let i = 0; i < 10; i++) expect((await get(app, PUBLIC_ID)).status).toBe(402);
  const res = await get(app, PUBLIC_ID);
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({
    error: "rate_limited",
    message: "try again in a few seconds",
  });
  expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
});

test("a 404 walk never spends the shared read budget", async () => {
  // The shared bucket bounds ARC READS. A 404 makes none, so a walk over ids that do not exist
  // must leave the deployment-wide allowance — and the free `/legal-bodies` lookup behind it —
  // untouched. One token, no refill: if any of the five 404s below spent it, the 402 cannot come.
  const { app } = setup({ readBudget: new TokenBucket(1, 0) });
  for (let i = 0; i < 5; i++)
    expect((await get(app, UNKNOWN_ID, { "x-forwarded-for": `8.8.8.${i}` })).status).toBe(404);
  expect((await get(app, PUBLIC_ID, { "x-forwarded-for": "8.8.9.9" })).status).toBe(402);
});

test("an exhausted SHARED read budget refuses every caller, before any 402", async () => {
  const { app } = setup({ readBudget: new TokenBucket(0, 0) });
  const res = await get(app, PUBLIC_ID);
  expect(res.status).toBe(429);
  expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  expect(onlySupported()).toEqual([]);
});

// ── the payment ─────────────────────────────────────────────────────────────────────────────────

test("a PAYMENT-SIGNATURE that is not base64 JSON is re-quoted, and never reaches the facilitator", async () => {
  const { app } = setup();
  const res = await get(app, PUBLIC_ID, { "PAYMENT-SIGNATURE": "not-base64-json" });
  expect(res.status).toBe(402);
  expect(onlySupported()).toEqual([]);
});

test("a payment the facilitator refuses at verify buys nothing", async () => {
  const { app } = setup();
  const header = await paidHeader(app, PUBLIC_ID, "1.1.1.1");
  verifyReply = { isValid: false, invalidReason: "x" };
  const res = await get(app, PUBLIC_ID, { "PAYMENT-SIGNATURE": header });
  expect(res.status).toBe(402);
  expect(await res.json()).toEqual({});
  expect(seen).toContain("/verify");
  expect(seen).not.toContain("/settle");
});

test("a payment that settles buys the attestation", async () => {
  const { app } = setup();
  const header = await paidHeader(app, PUBLIC_ID, "2.2.2.2");
  const res = await get(app, PUBLIC_ID, { "PAYMENT-SIGNATURE": header });
  expect(res.status).toBe(200);
  expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  const body = await res.json();
  expect(body).toMatchObject({
    subject: {
      publicId: PUBLIC_ID,
      name: "FormationE2E_1",
      agentId: "886257",
      uaid: null,
    },
    standing: "active",
    formation: null,
    controller: { humanVerified: true, credential: "orb" },
    legalBody: { oaHash: null, manifestVersion: null },
  });
  // Unsigned in this task: the EIP-712 signature arrives in task 13, and an empty or absent
  // field that a verifier might read as "checked" must not exist before then.
  expect(body).not.toHaveProperty("signature");
  expect(Date.parse(body.expiresAt) - Date.parse(body.issuedAt)).toBe(300_000);
  expect(seen).toContain("/settle");
});

test("a guardian with no World ID verification is not claimed as human-verified", async () => {
  const { app } = setup({ worldId: undefined });
  const header = await paidHeader(app, PUBLIC_ID, "3.3.3.3");
  const res = await get(app, PUBLIC_ID, { "PAYMENT-SIGNATURE": header });
  expect(res.status).toBe(200);
  expect((await res.json()).controller).toEqual({ humanVerified: false, credential: null });
});

test("a suspended legal body is served as inactive, not withheld", async () => {
  const { db, repo } = hederaDb();
  openDbs.push(db);
  const app = hederaApp({
    repo,
    hedera: {
      cfg: HEDERA_CFG,
      mirror: fakeMirror({}),
      ledger: new PaymentLedger(db),
      spendAllowlistThreshold: 1_000_000_000n,
    },
    legalBody: {
      resolver: { resolve: async () => ({ kind: "none" }) },
      chainReads: arcReads({ paused: true }),
      readBudget: new TokenBucket(30, 1),
      links: { transparency: `${WEB}/transparency`, metadataBase: METADATA_BASE },
      network: "testnet" as const,
    },
  });
  const header = await paidHeader(app, PUBLIC_ID, "4.4.4.4");
  const res = await get(app, PUBLIC_ID, { "PAYMENT-SIGNATURE": header });
  expect(res.status).toBe(200);
  expect((await res.json()).standing).toBe("inactive");
});

test("a failed settlement replaces the attestation with a 402", async () => {
  const { app } = setup();
  const header = await paidHeader(app, PUBLIC_ID, "5.5.5.5");
  settleReply = {
    success: false,
    errorReason: "transaction_failed",
    transaction: "",
    network: NETWORK,
  };
  const res = await get(app, PUBLIC_ID, { "PAYMENT-SIGNATURE": header });
  expect(res.status).toBe(402);
  const body = await res.json();
  expect(body).not.toHaveProperty("subject");
  expect(body).not.toHaveProperty("standing");
});

test("the entity's tenant is never on the served body", async () => {
  const { app } = setup();
  const header = await paidHeader(app, PUBLIC_ID, "6.6.6.6");
  const res = await get(app, PUBLIC_ID, { "PAYMENT-SIGNATURE": header });
  expect(JSON.stringify(await res.json())).not.toContain(TENANT);
});

test("the per-client allowance is the SAME one the free lookup spends (audit C9)", async () => {
  const { app } = setup();
  for (let i = 0; i < 10; i++)
    expect((await get(app, PUBLIC_ID, { "x-forwarded-for": "7.7.7.7" })).status).toBe(402);
  // Same caller, the other public read surface: its allowance is already gone.
  const res = await app.request("/legal-bodies/0x0000000000000000000000000000000000000001", {
    headers: { "x-forwarded-for": "7.7.7.7" },
  });
  expect(res.status).toBe(429);
});

test("the subject carries the identity registry even with no ENS gateway wired", async () => {
  // `deps.ens` is undefined throughout this file, which is the point: a paying buyer must never
  // be handed an `agentId` with no registry to resolve it in (design Component 5).
  const { app } = setup();
  const header = await paidHeader(app, PUBLIC_ID, "8.8.8.8");
  const res = await get(app, PUBLIC_ID, { "PAYMENT-SIGNATURE": header });
  expect((await res.json()).subject.registry).toBe(`eip155:5042002:${IDENTITY_REGISTRY}`);
});
