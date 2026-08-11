import { type NextRequest, NextResponse } from "next/server";

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

  const headers = new Headers();
  // MCP Streamable HTTP requires accept/mcp-* headers end-to-end (the backend 406s without them);
  // x402 requires x-payment end-to-end (the seller re-issues its 402 challenge without it);
  // AgentKit sends its human-backing proof in a header named exactly `agentkit` — dropping it
  // makes every external agent look anonymous to the seller, which refused them all.
  const forwarded = [
    "authorization",
    "content-type",
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "x-payment",
    "agentkit",
  ];
  for (const name of forwarded) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const res = await fetch(url, init);

  const outHeaders: Record<string, string> = {};
  const ct = res.headers.get("content-type");
  if (ct) outHeaders["content-type"] = ct;
  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId) outHeaders["mcp-session-id"] = sessionId;
  // x402 settlement id is returned to the buyer in x-payment-response.
  const payResponse = res.headers.get("x-payment-response");
  if (payResponse) outHeaders["x-payment-response"] = payResponse;
  // AgentKit outcome: who the seller judged to be backing the agent, and its remaining budget.
  // Without these an authorized agent cannot read its own standing.
  for (const h of ["x-agentkit-human", "x-agentkit-authorization"]) {
    const v = res.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  const joined = path?.join("/") ?? "";
  if (joined === "connection-package" || joined === "bootstrap-connection") {
    outHeaders["cache-control"] = "no-store";
  }

  // Stream the body through (SSE responses must not be buffered).
  return new NextResponse(res.body, { status: res.status, headers: outHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
