import { type NextRequest, NextResponse } from "next/server";

function apiTarget(): string {
  const configured = process.env.API_PROXY_TARGET?.trim();
  return configured || "http://159.223.137.183:8789";
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
  const auth = req.headers.get("authorization");
  const contentType = req.headers.get("content-type");
  if (auth) headers.set("authorization", auth);
  if (contentType) headers.set("content-type", contentType);

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const res = await fetch(url, init);
  const body = await res.arrayBuffer();

  return new NextResponse(body, {
    status: res.status,
    headers: res.headers.get("content-type")
      ? { "content-type": res.headers.get("content-type")! }
      : undefined,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
