/**
 * The x402 headers, THROUGH THE REAL PROXY ROUTE, in both directions.
 *
 * The allowlists named only the v1 spellings — `x-payment` on the way in, `x-payment-response` on
 * the way back. The backend's seller speaks x402 v2 as well, where the buyer's signature arrives
 * as `payment-signature`, the challenge goes back in `payment-required` (v2 carries the
 * requirements in a HEADER; v1 put them in the body, which is why nobody noticed) and the
 * settlement receipt comes back as `payment-response`. A buyer going through this proxy therefore
 * lost its signature on the way in and never saw the challenge on the way out: it read a 402 with
 * an empty body, no requirements anywhere, and had nothing to pay against.
 *
 * The directions below are not guessed, they are read off the packages in `back/backend`:
 *
 *   • READ from the request — `@x402/hono`'s middleware takes
 *     `adapter.getHeader("payment-signature") || adapter.getHeader("x-payment")`, and
 *     `@x402/core`'s `extractPayment` reads `payment-signature` again.
 *   • SET on the 402 — `@x402/core`'s `createHTTPPaymentRequiredResponse` returns
 *     `PAYMENT-REQUIRED` (plus a `Cache-Control`, which stays scoped by this proxy's own policy).
 *   • SET on the settled response — `createSettlementHeaders` returns `PAYMENT-RESPONSE`, on the
 *     success path and on the failure path alike.
 *
 * `Settlement-Overrides` is the one v2 header deliberately NOT added: it travels from the route
 * handler to the middleware inside the backend, which deletes it before answering, and it has no
 * meaning to a browser or to a buyer.
 *
 * These tests drive the route handler itself rather than the resolvers, because a header that is
 * on an allowlist and still dropped by the handler is exactly the failure this pair used to have.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
} from "@/lib/proxyHeaders";

/** Every request the proxy made upstream, so the REQUEST direction is assertable. */
let upstream: Request[];
/** What the backend answers next. */
let answer: () => Response;

const previousTarget = process.env.API_PROXY_TARGET;

beforeEach(() => {
  upstream = [];
  answer = () => new Response("{}", { status: 200 });
  process.env.API_PROXY_TARGET = "http://backend.test";
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    upstream.push(new Request(typeof url === "string" ? url : url.toString(), init));
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousTarget === undefined) delete process.env.API_PROXY_TARGET;
  else process.env.API_PROXY_TARGET = previousTarget;
});

/** One proxied GET through the real route handler. */
async function proxied(path: string[], headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("@/app/backend/[[...path]]/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`https://www.novicorpus.test/backend/${path.join("/")}`, {
    headers,
  });
  return GET(req, { params: Promise.resolve({ path }) });
}

const VERIFY = ["verify", "9f8003f5-4c70-435a-9980-9a54625691b7"];

// ── the allowlists themselves, in full ──────────────────────────────────────────────────────────

test("the request allowlist is exactly these headers, and nothing crept in beside them", () => {
  expect([...FORWARDED_REQUEST_HEADERS]).toEqual([
    "authorization",
    "content-type",
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "x-payment",
    "payment-signature",
    "agentkit",
  ]);
});

test("the response allowlist is exactly these headers, and nothing crept in beside them", () => {
  expect([...FORWARDED_RESPONSE_HEADERS]).toEqual([
    "content-type",
    "mcp-session-id",
    "x-payment-response",
    "payment-required",
    "payment-response",
    "x-agentkit-human",
    "x-agentkit-authorization",
    "x-novi-legal-body",
  ]);
});

// ── the way in ──────────────────────────────────────────────────────────────────────────────────

test("a buyer's v2 signature reaches the backend", async () => {
  await proxied(VERIFY, { "payment-signature": "eyJ4NDAyVmVyc2lvbiI6Mn0=" });
  expect(upstream[0]!.headers.get("payment-signature")).toBe("eyJ4NDAyVmVyc2lvbiI6Mn0=");
});

test("the v1 spelling still crosses beside it, because the seller accepts either", async () => {
  await proxied(VERIFY, { "x-payment": "v1-header", "payment-signature": "v2-header" });
  expect(upstream[0]!.headers.get("x-payment")).toBe("v1-header");
  expect(upstream[0]!.headers.get("payment-signature")).toBe("v2-header");
});

test("a header on neither list still never reaches the backend", async () => {
  await proxied(VERIFY, {
    cookie: "session=secret",
    "x-forwarded-for": "203.0.113.9",
    "payment-signature": "sig",
    // The backend's internal settle channel. The middleware over there deletes it; a proxy that
    // forwarded it would let a browser speak on the route handler's behalf.
    "settlement-overrides": "{}",
  });
  expect(upstream[0]!.headers.get("cookie")).toBeNull();
  expect(upstream[0]!.headers.get("x-forwarded-for")).toBeNull();
  expect(upstream[0]!.headers.get("settlement-overrides")).toBeNull();
  expect(upstream[0]!.headers.get("payment-signature")).toBe("sig");
});

// ── the way back ────────────────────────────────────────────────────────────────────────────────

test("a proxied 402 carries the challenge the buyer has to read", async () => {
  // v2's requirements live in this header and nowhere else, so dropping it left a buyer holding a
  // 402 with an empty body and no price, asset or payee anywhere in the answer.
  answer = () =>
    new Response("{}", {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": "eyJhY2NlcHRzIjpbXX0=",
      },
    });
  const res = await proxied(VERIFY, {});
  expect(res.status).toBe(402);
  expect(res.headers.get("payment-required")).toBe("eyJhY2NlcHRzIjpbXX0=");
});

test("a proxied settlement carries the receipt, in both spellings the seller may use", async () => {
  answer = () =>
    new Response('{"standing":"active"}', {
      status: 200,
      headers: {
        "content-type": "application/json",
        "payment-response": "eyJzdWNjZXNzIjp0cnVlfQ==",
        "x-payment-response": "0.0.7162784@1788998489.006924053",
      },
    });
  const res = await proxied(VERIFY, { "payment-signature": "sig" });
  expect(res.status).toBe(200);
  expect(res.headers.get("payment-response")).toBe("eyJzdWNjZXNzIjp0cnVlfQ==");
  expect(res.headers.get("x-payment-response")).toBe("0.0.7162784@1788998489.006924053");
});

test("a response header on neither list is still dropped on the way back", async () => {
  answer = () =>
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=secret",
        "x-powered-by": "something",
        "settlement-overrides": "{}",
        "payment-required": "challenge",
      },
    });
  const res = await proxied(VERIFY, {});
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("x-powered-by")).toBeNull();
  expect(res.headers.get("settlement-overrides")).toBeNull();
  expect(res.headers.get("payment-required")).toBe("challenge");
});

test("the backend's own cache policy is still not echoed onto a payment route", async () => {
  // `@x402/core` sets a `Cache-Control` beside both v2 headers. It stays OFF the global list for
  // the reason it always has: echoing a backend's caching policy onto every route would silently
  // override the one this proxy applies.
  answer = () =>
    new Response("{}", {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": "challenge",
        "cache-control": "max-age=60",
      },
    });
  const res = await proxied(VERIFY, {});
  expect(res.headers.get("cache-control")).toBeNull();
  expect(res.headers.get("payment-required")).toBe("challenge");
});
