/**
 * The `/backend` proxy forwards a request body BYTE FOR BYTE.
 *
 * A text read of the body decodes it as UTF-8 before it is forwarded: every byte sequence that is
 * not valid UTF-8 becomes a replacement character, so a binary upload (a PDF of evidence) reaches
 * the API longer than it left the browser and with a different hash. These tests drive the real
 * route handler with a stubbed `fetch` and compare what the backend would have received.
 */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST } from "@/app/backend/[[...path]]/route";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** What the stubbed backend saw: the URL, the body bytes and the content type. */
type Seen = { url: string; bytes: Uint8Array; contentType: string | null };

beforeEach(() => {
  // The route's own default in development is this origin; pinned so that a target set in the
  // shell running the tests cannot change the URL asserted below.
  vi.stubEnv("API_PROXY_TARGET", "http://localhost:8789");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** One POST through the real route handler; returns what reached the stubbed backend. */
async function forwarded(
  path: string[],
  init: { body?: BodyInit; contentType?: string },
): Promise<Seen> {
  let seen: Seen | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, requestInit: RequestInit) => {
      const bytes = new Uint8Array(
        await new Response(requestInit.body ?? null).arrayBuffer(),
      );
      seen = { url, bytes, contentType: new Headers(requestInit.headers).get("content-type") };
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const headers: Record<string, string> = { authorization: "Bearer t" };
  if (init.contentType) headers["content-type"] = init.contentType;
  const req = new NextRequest(`http://localhost:3000/backend/${path.join("/")}?kind=control`, {
    method: "POST",
    body: init.body,
    headers,
  });
  const res = await POST(req, { params: Promise.resolve({ path }) });
  expect(res.status).toBe(201);
  if (!seen) throw new Error("the proxy did not call the backend");
  return seen;
}

describe("the proxy forwards request bodies as bytes", () => {
  test("a 64 KiB binary PDF arrives with the same length and sha256", async () => {
    const header = Buffer.from("%PDF-1.7\n");
    const pdf = new Uint8Array(
      Buffer.concat([header, randomBytes(64 * 1024 - header.length)]),
    );
    expect(pdf.length).toBe(64 * 1024);

    const seen = await forwarded(["companies", "x", "evidence"], {
      body: pdf,
      contentType: "application/pdf",
    });

    expect(seen.bytes.length).toBe(pdf.length);
    expect(sha256(seen.bytes)).toBe(sha256(pdf));
    expect(seen.contentType).toBe("application/pdf");
    expect(seen.url).toBe("http://localhost:8789/companies/x/evidence?kind=control");
  });

  test("a JSON body with non-ASCII characters arrives unchanged", async () => {
    const json = JSON.stringify({ companyName: "Example Test Holdings LLC", note: "café ✓ 日本" });
    const seen = await forwarded(["companies", "customer"], {
      body: json,
      contentType: "application/json",
    });
    expect(new TextDecoder().decode(seen.bytes)).toBe(json);
    expect(seen.contentType).toBe("application/json");
  });

  test("a POST with no body forwards zero bytes", async () => {
    const seen = await forwarded(["companies", "x", "abandon"], {});
    expect(seen.bytes.length).toBe(0);
  });
});
