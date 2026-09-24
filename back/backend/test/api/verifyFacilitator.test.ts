/**
 * The API BOOTS AND SERVES WHILE THE HEDERA FACILITATOR IS DOWN.
 *
 * `GET /verify/:publicId` is the only route in this process that needs a third-party facilitator,
 * and it used to make that facilitator a boot dependency of the whole API. `mountVerifyRoutes`
 * called `paymentMiddleware(routes, server)` while the app was being assembled, and `@x402/hono`
 * starts the `/supported` handshake inside that call. Two things followed, both reproduced below:
 *
 *   • a facilitator answering 200 WITHOUT `exact` on `hedera:testnet` made
 *     `x402HTTPResourceServer.initialize()` (`@x402/core`) throw `RouteConfigurationError`, which
 *     `@x402/core`'s `attachBackgroundInitHandler` classifies as a fatal startup error and
 *     answers with `process.exit(1)`. The process died at boot: no `/healthz`, no `/entities`,
 *     nothing — because a sidecar was misconfigured.
 *   • a facilitator answering 500 left the process up but answered `/verify/*` with
 *     `{"error":"Internal Server Error"}` and a 500, which is neither this API's error envelope
 *     nor an honest description of a dependency that is merely unreachable.
 *
 * So the handshake is ours now: nothing touches the facilitator until the first `/verify/*`
 * request, the result is cached once it succeeds, and until then the route refuses with a 503 in
 * the API's envelope while every other route serves as before.
 *
 * `process.exit` is spied on in every test here rather than asserted in one: a regression that
 * reintroduces the fatal handler must fail the test that provoked it, not a neighbour.
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { PaymentLedger } from "../../src/payments/ledger";
import {
  METADATA_BASE,
  PUBLIC_ID,
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

/** The facilitator's `/supported` as Blocky402 testnet answers it — the WORKING handshake. */
const SUPPORTED = {
  kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer: FEE_PAYER } }],
  extensions: [],
  signers: { "hedera:*": [FEE_PAYER] },
};

/** A facilitator that is up and healthy but serves some other chain: 200, no Hedera kind. This is
 *  the shape that used to call `process.exit(1)` from inside `mountVerifyRoutes`. */
const OTHER_CHAIN = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453", extra: {} }],
  extensions: [],
  signers: {},
};

/** The one public sentence a caller gets while the handshake has not succeeded. It names no host,
 *  no URL and no third party, because a buyer can do nothing with any of those. */
const UNAVAILABLE = {
  error: {
    code: "facilitator_unavailable",
    message: "the paid standing check is temporarily unavailable; try again shortly",
  },
};

/** Every facilitator path the stub was asked for, in order — `[]` means "nothing was called". */
let seen: string[];
/** Every `process.exit` code production code asked for. The one list in this file that must stay
 *  empty in every test: an exit here is the boot failure, whatever else the response said. */
let exited: (number | undefined)[];
/** What `/supported` answers on the NEXT call, so a test can bring the facilitator back. */
let supported: () => Response;
/** The app's clock, which the backoff reads. Advanced by `tick`. */
let clock: number;
const tick = (ms: number) => {
  clock += ms;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  seen = [];
  clock = 1_789_100_000_000; // 2026-09-10, the design date, as the shared scaffold uses it
  supported = () => json(SUPPORTED);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(new URL(url).pathname);
    return supported();
  });
  // The failure this file exists to prevent. Left as a spy, never as a mock that swallows a real
  // exit: if production code calls it, `exited` records the code and the assertions below fail.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exited.push(code);
    return undefined as never;
  }) as never);
  exited = [];
  // `@x402/core` prints the init failure itself; this file asserts behaviour, not its logging.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const openDbs: Database.Database[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (openDbs.length) openDbs.pop()?.close();
});

function setup() {
  const { db, repo } = hederaDb();
  openDbs.push(db);
  return hederaApp({
    repo,
    now: () => clock,
    hedera: {
      cfg: HEDERA_CFG,
      mirror: fakeMirror({}),
      ledger: new PaymentLedger(db),
      spendAllowlistThreshold: 1_000_000_000n,
    },
    legalBody: {
      resolver: { resolve: async () => ({ kind: "none" }) },
      chainReads: arcReads(),
      readBudget: new TokenBucket(30, 1),
      links: { transparency: `${WEB}/transparency`, metadataBase: METADATA_BASE },
      network: "testnet" as const,
    },
  });
}

type App = ReturnType<typeof hederaApp>;
/** Each caller its own forwarded-for, so a loop never spends one client's whole allowance. */
const get = (app: App, client = "9.9.9.9") =>
  app.request(`/verify/${PUBLIC_ID}`, { headers: { "x-forwarded-for": client } });

// ── the boot ────────────────────────────────────────────────────────────────────────────────────

test("building the app calls the facilitator not once", async () => {
  // The whole defect in one assertion: assembling the app must be a local operation. A handshake
  // here is a third party on the boot path, and a third party on the boot path is a deploy that
  // fails for a reason unrelated to whether this process can serve.
  const app = setup();
  expect(seen).toEqual([]);
  // …and it stays that way for a route that has nothing to do with payments.
  const health = await app.request("/healthz");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  expect(seen).toEqual([]);
  expect(exited).toEqual([]);
});

test("a facilitator that does not advertise the scheme never exits the process", async () => {
  // This is the case that used to reach `process.exit(1)`: a facilitator that is up, answers 200,
  // and serves some other chain. `RouteConfigurationError` is a fatal startup error to
  // `@x402/core`, and it had no business being raised at mount time in the first place.
  supported = () => json(OTHER_CHAIN);
  const app = setup();
  const health = await app.request("/healthz");
  expect(health.status).toBe(200);
  const res = await get(app);
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual(UNAVAILABLE);
  expect(exited).toEqual([]);
  // The route is still MOUNTED — it refuses, it has not vanished — and `/healthz` still answers
  // after the failed handshake, which is the difference between a degraded route and a dead box.
  const after = await app.request("/healthz");
  expect(after.status).toBe(200);
  expect(await after.json()).toEqual({ ok: true });
});

test("a facilitator whose /supported answers 500 is a 503 in this API's envelope", async () => {
  // Before: `{"error":"Internal Server Error"}` with a 500, straight out of `@x402/hono`. A 500
  // says "we are broken"; a buyer reading it has no reason to come back. 503 says "not now".
  supported = () => new Response("boom", { status: 500 });
  const app = setup();
  const res = await get(app);
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual(UNAVAILABLE);
  expect(exited).toEqual([]);
});

test("the refusal names no host, no URL and no third party", async () => {
  supported = () => new Response("boom", { status: 500 });
  const app = setup();
  const body = await (await get(app)).text();
  for (const leak of [HEDERA_CFG.facilitatorUrl, "f.test", "https://", "supported"])
    expect(body, leak).not.toContain(leak);
});

// ── the backoff ─────────────────────────────────────────────────────────────────────────────────

test("a failed handshake is retried at most once every ten seconds", async () => {
  const ops: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    ops.push(String(JSON.parse(line).opslog));
  });
  supported = () => new Response("boom", { status: 500 });
  const app = setup();
  expect((await get(app, "10.0.0.1")).status).toBe(503);
  expect(seen).toEqual(["/supported"]);

  // Nine seconds and three more callers later: still one attempt. Without the gate, every request
  // to a public unauthenticated route would be a round trip to a facilitator that is down — this
  // route's own rate limiter bounds one caller, not the fleet of them.
  tick(9_000);
  for (const client of ["10.0.0.2", "10.0.0.3", "10.0.0.4"])
    expect((await get(app, client)).status).toBe(503);
  expect(seen).toEqual(["/supported"]);

  // Past ten seconds, exactly one more attempt.
  tick(1_001);
  expect((await get(app, "10.0.0.5")).status).toBe(503);
  expect(seen).toEqual(["/supported", "/supported"]);
  tick(1_000);
  expect((await get(app, "10.0.0.6")).status).toBe(503);
  expect(seen).toEqual(["/supported", "/supported"]);
  expect(exited).toEqual([]);
  // One ops line per ATTEMPT, never per request: the window bounds the logging as well as the
  // traffic, so a sustained drain against a dead facilitator cannot fill the journal either.
  expect(ops).toEqual([
    "verify_facilitator_handshake_failed",
    "verify_facilitator_handshake_failed",
  ]);
});

test("concurrent callers share one handshake rather than one each", async () => {
  supported = () => new Response("boom", { status: 500 });
  const app = setup();
  const answers = await Promise.all([get(app, "11.0.0.1"), get(app, "11.0.0.2")]);
  for (const res of answers) expect(res.status).toBe(503);
  expect(seen).toEqual(["/supported"]);
});

// ── the recovery ────────────────────────────────────────────────────────────────────────────────

test("a facilitator that comes back is picked up on the next attempt, and quotes", async () => {
  supported = () => new Response("boom", { status: 500 });
  const app = setup();
  expect((await get(app, "12.0.0.1")).status).toBe(503);

  supported = () => json(SUPPORTED);
  tick(10_001);
  const res = await get(app, "12.0.0.2");
  expect(res.status).toBe(402);
  const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "");
  expect((required as { accepts: Record<string, unknown>[] }).accepts[0]).toEqual({
    scheme: "exact",
    network: NETWORK,
    payTo: HEDERA_CFG.payToAccountId,
    asset: HEDERA_CFG.usdcTokenId,
    amount: "1000",
    maxTimeoutSeconds: 300,
    // Copied out of `/supported` by the Hedera scheme, which is the whole reason the handshake
    // has to have happened before a price can be quoted at all.
    extra: { feePayer: FEE_PAYER },
  });
  expect(seen).toEqual(["/supported", "/supported"]);
});

test("a handshake that succeeded is never repeated", async () => {
  const app = setup();
  for (const client of ["13.0.0.1", "13.0.0.2", "13.0.0.3"])
    expect((await get(app, client)).status).toBe(402);
  expect(seen).toEqual(["/supported"]);
  // …not even once the backoff window a FAILURE would have opened has gone by.
  tick(60_000);
  expect((await get(app, "13.0.0.4")).status).toBe(402);
  expect(seen).toEqual(["/supported"]);
  expect(exited).toEqual([]);
});

// ── what a refused handshake must not cost ──────────────────────────────────────────────────────

test("a 404 is answered without ever asking the facilitator anything", async () => {
  // Layer 1 is still layer 1: the 404 guard runs before the payment layer, so a walk over unknown
  // ids cannot make this API generate facilitator traffic — with the facilitator up OR down.
  const app = setup();
  const res = await app.request("/verify/11111111-2222-3333-4444-555555555555", {
    headers: { "x-forwarded-for": "14.0.0.1" },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
  expect(seen).toEqual([]);
});

test("a caller out of allowance is refused before the handshake, facilitator down or not", async () => {
  supported = () => new Response("boom", { status: 500 });
  const app = setup();
  // Ten of the caller's own allowance, each a 503 that cost at most one handshake between them.
  for (let i = 0; i < 10; i++) expect((await get(app, "15.0.0.1")).status).toBe(503);
  const res = await get(app, "15.0.0.1");
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({
    error: "rate_limited",
    message: "try again in a few seconds",
  });
  expect(seen).toEqual(["/supported"]);
});
