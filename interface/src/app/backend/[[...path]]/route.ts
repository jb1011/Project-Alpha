import { type NextRequest, NextResponse } from "next/server";
import {
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  isNoStorePath,
} from "../../../lib/proxyHeaders";
import { budgetMs } from "../../../lib/api/budgets";
import {
  UPSTREAM_TIMEOUT_BODY,
  UPSTREAM_TIMEOUT_HEADERS,
  UPSTREAM_TIMEOUT_STATUS,
  fetchFirstByte,
} from "../../../lib/upstreamTimeout";

function apiTarget(): string {
  const configured = process.env.API_PROXY_TARGET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "API_PROXY_TARGET is required in production — set it to your backend HTTPS URL.",
    );
  }
  return "http://localhost:8789";
}

function backendUrl(path: string[] | undefined, search: string): string {
  const base = apiTarget().replace(/\/$/, "");
  const suffix = path?.length ? path.join("/") : "";
  return suffix ? `${base}/${suffix}${search}` : `${base}/${search}`;
}

async function proxy(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const url = backendUrl(path, req.nextUrl.search);
  const joined = path?.join("/") ?? "";

  // Both allowlists live in ../../../lib/proxyHeaders: "which headers cross the boundary" is a
  // security decision, and a Next.js route file cannot export it for review or for the backend's
  // drift guard. The REQUEST list is path-aware for one header — `if-none-match` on the public
  // reference route — because dropping it makes that route's ETag decorative: the browser holds a
  // validator it can never send, and every revalidation re-downloads the whole list.
  const headers = new Headers();
  for (const name of forwardedRequestHeaders(joined)) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  // BOUNDED ON THE FIRST BYTE ONLY (2026-09-16). A backend that accepts the connection and then
  // goes quiet used to hold the browser's request open until something else gave up. The timer
  // dies the moment the headers arrive, so streamed bodies are never cut — see
  // ../../../lib/upstreamTimeout, where that lifetime is the thing under test.
  //
  // ⚠ WHY THE MCP ENDPOINT IS SAFE UNDER A 25-SECOND FIRST-BYTE BUDGET, and what it depends on:
  // the transport is built with `enableJsonResponse` UNSET (back/backend/src/mcp/transport.ts), so
  // a POST /mcp answers `text/event-stream` headers in milliseconds — before the tool handler
  // runs — and writes the JSON-RPC result later as an SSE event on the already-open body. A
  // 90-second `onboard_agent` therefore never reaches this timer. Setting `enableJsonResponse:
  // true` over there would make the headers wait for the whole tool call and this budget WOULD
  // cut it; that endpoint would then need its own row in `@/lib/api/budgets`.
  //
  // The budget is per route (`budgetMs`): the payment-settle and policy handlers broadcast and
  // then wait for a receipt, and a shared 25 seconds made this proxy the binding deadline on a
  // transaction that was mining.
  const first = await fetchFirstByte(
    (signal) => fetch(url, { ...init, signal }),
    budgetMs(req.method, joined),
  );
  if (first.timedOut) {
    return NextResponse.json(UPSTREAM_TIMEOUT_BODY, {
      status: UPSTREAM_TIMEOUT_STATUS,
      headers: UPSTREAM_TIMEOUT_HEADERS,
    });
  }
  const res = first.res;

  // Which headers may cross depends on the ROUTE and on what the backend actually answered (C9):
  // the four download headers are forwarded only for the document bytes route, and
  // `content-length` is dropped whenever the response is encoded, because the backend's byte
  // count would then be a lie about the bytes on the wire — and a lying Content-Length truncates
  // the download rather than merely annoying the browser.
  const outHeaders: Record<string, string> = {};
  for (const name of forwardedResponseHeaders(joined, res.headers)) {
    const v = res.headers.get(name);
    if (v) outHeaders[name] = v;
  }
  // The second lock. The backend already sets `private, no-store` on these responses; this is the
  // proxy refusing to let an intermediary decide otherwise, and it OVERRIDES whatever the
  // forwarding loop above copied.
  if (isNoStorePath(joined)) {
    outHeaders["cache-control"] = "no-store";
  }

  // Stream the body through (SSE responses must not be buffered).
  return new NextResponse(res.body, { status: res.status, headers: outHeaders });
}

/**
 * Long enough for the longest budget in `@/lib/api/budgets` (the policy pair, 240s) plus the
 * proxy's own overhead.
 *
 * Stated explicitly rather than inherited: there is no `vercel.json` and no runtime export in this
 * app, so the effective limit today is the platform default — which has changed before and is not
 * a number this route should discover in production. The budget table decides when to give up; the
 * platform must not decide it first and answer with an error page that carries no envelope.
 */
export const maxDuration = 250;

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
