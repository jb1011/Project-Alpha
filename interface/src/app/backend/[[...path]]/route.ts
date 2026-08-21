import { type NextRequest, NextResponse } from "next/server";
import {
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  isNoStorePath,
} from "../../../lib/proxyHeaders";

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

  // Both allowlists live in ../../../lib/proxyHeaders: "which headers cross the boundary" is a
  // security decision, and a Next.js route file cannot export it for review or for the backend's
  // drift guard.
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const res = await fetch(url, init);

  const outHeaders: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const v = res.headers.get(name);
    if (v) outHeaders[name] = v;
  }
  // The second lock. The backend already sets `private, no-store` on these responses; this is the
  // proxy refusing to let an intermediary decide otherwise, and it OVERRIDES whatever the
  // forwarding loop above copied.
  const joined = path?.join("/") ?? "";
  if (isNoStorePath(joined)) {
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
