/**
 * The hardened document downloader (design §10, audit M15).
 *
 * This is the one URL in the formation loop that a third party chooses for us, so the tests are
 * mostly refusals: a downgrade to http, a redirect off the allowlist, a redirect chain, a lying
 * Content-Length, and a content type that is not a PDF.
 */
import { expect, test } from "vitest";
import { SsrfError } from "../../src/payments/ssrfGuard";
import {
  DocumentDownloadError,
  MAX_DOCUMENT_REDIRECTS,
  downloadDocument,
  normalizeContentType,
  redirectAllowlist,
} from "../../src/workflow/documentDownloader";

const PDF = Buffer.from("%PDF-1.7\nfake\n");
const SIGNED = "https://api.test.doola.com/signed/doc-1";

/** A fetch fake driven by a URL -> response script. Records what it was asked for. */
function scriptedFetch(script: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const make = script[url];
    if (!make) throw new Error(`unscripted fetch: ${url}`);
    return make();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function pdfResponse(body: Buffer = PDF, headers: Record<string, string> = {}) {
  // Uint8Array, not Buffer: `BodyInit` does not admit Node's Buffer type even though it works.
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { "content-type": "application/pdf", ...headers },
  });
}

function redirect(to: string, status = 302) {
  return new Response(null, { status, headers: { location: to } });
}

test("the happy path: bytes, size and the sha256 of exactly those bytes", async () => {
  const { impl } = scriptedFetch({ [SIGNED]: () => pdfResponse() });
  const got = await downloadDocument(SIGNED, { fetchImpl: impl });
  expect(got.bytes.equals(PDF)).toBe(true);
  expect(got.size).toBe(PDF.length);
  expect(got.contentType).toBe("application/pdf");
  // The hash is over the buffer the caller stores — the index cannot record a hash of other bytes.
  const { createHash } = await import("node:crypto");
  expect(got.sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
});

test("application/octet-stream is accepted; anything else is refused before the body is read", async () => {
  const { impl } = scriptedFetch({
    [SIGNED]: () => pdfResponse(PDF, { "content-type": "application/octet-stream" }),
  });
  await expect(downloadDocument(SIGNED, { fetchImpl: impl })).resolves.toMatchObject({
    contentType: "application/octet-stream",
  });

  for (const ct of ["text/html", "application/json", ""]) {
    const s = scriptedFetch({
      [SIGNED]: () =>
        new Response("<html>login</html>", {
          status: 200,
          headers: ct ? { "content-type": ct } : {},
        }),
    });
    // An HTML login page is not worth 16 MiB of patience, and is certainly not a legal document.
    await expect(downloadDocument(SIGNED, { fetchImpl: s.impl })).rejects.toBeInstanceOf(
      DocumentDownloadError,
    );
  }
});

test("HTTPS only — a plain-http URL never leaves the process", async () => {
  const { impl, calls } = scriptedFetch({});
  await expect(
    downloadDocument("http://api.test.doola.com/signed/doc-1", { fetchImpl: impl }),
  ).rejects.toBeInstanceOf(SsrfError);
  expect(calls).toHaveLength(0);
});

test("a blocked IP literal is refused, including the cloud metadata address", async () => {
  const { impl, calls } = scriptedFetch({});
  for (const host of ["169.254.169.254", "127.0.0.1", "10.0.0.5", "[::1]"])
    await expect(
      downloadDocument(`https://${host}/doc`, { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(SsrfError);
  expect(calls).toHaveLength(0);
});

test("a presigned S3 redirect is FOLLOWED — that is why this is not safeFetch", async () => {
  const s3 = "https://doola-docs.s3.us-east-1.amazonaws.com/aoo.pdf?X-Amz-Signature=abc";
  const { impl, calls } = scriptedFetch({
    [SIGNED]: () => redirect(s3),
    [s3]: () => pdfResponse(),
  });
  const got = await downloadDocument(SIGNED, { fetchImpl: impl });
  expect(got.size).toBe(PDF.length);
  expect(calls).toEqual([SIGNED, s3]);
});

test("a redirect BACK to the original host is allowed; one to anywhere else is not", async () => {
  const same = "https://api.test.doola.com/signed/doc-1/final";
  const ok = scriptedFetch({ [SIGNED]: () => redirect(same), [same]: () => pdfResponse() });
  await expect(downloadDocument(SIGNED, { fetchImpl: ok.impl })).resolves.toBeDefined();

  // An open redirect at doola must not be able to walk us to an arbitrary origin.
  const evil = "https://attacker.example.com/doc.pdf";
  const bad = scriptedFetch({ [SIGNED]: () => redirect(evil), [evil]: () => pdfResponse() });
  await expect(downloadDocument(SIGNED, { fetchImpl: bad.impl })).rejects.toBeInstanceOf(SsrfError);
  // Refused BEFORE the request: the allowlist is a pre-flight check, not a post-mortem.
  expect(bad.calls).toEqual([SIGNED]);
});

test("a redirect that downgrades to http is refused like any other non-https URL", async () => {
  const plain = "http://doola-docs.s3.amazonaws.com/aoo.pdf";
  const { impl } = scriptedFetch({ [SIGNED]: () => redirect(plain) });
  await expect(downloadDocument(SIGNED, { fetchImpl: impl })).rejects.toBeInstanceOf(SsrfError);
});

test("the redirect chain is bounded", async () => {
  const hop = (n: number) => `https://api.test.doola.com/signed/doc-1/${n}`;
  const script: Record<string, () => Response> = { [SIGNED]: () => redirect(hop(1)) };
  for (let i = 1; i <= 6; i++) script[hop(i)] = () => redirect(hop(i + 1));
  const { impl, calls } = scriptedFetch(script);
  await expect(downloadDocument(SIGNED, { fetchImpl: impl })).rejects.toThrow(
    /exceeded 2 redirects/,
  );
  // The original request plus MAX_DOCUMENT_REDIRECTS follow-ups, and no more.
  expect(calls).toHaveLength(MAX_DOCUMENT_REDIRECTS + 1);
});

test("a redirect with no Location is an error, not an infinite loop", async () => {
  const { impl } = scriptedFetch({
    [SIGNED]: () => new Response(null, { status: 302 }),
  });
  await expect(downloadDocument(SIGNED, { fetchImpl: impl })).rejects.toThrow(/no Location/);
});

test("a relative Location is resolved against the current URL and re-validated", async () => {
  const resolved = "https://api.test.doola.com/signed/final.pdf";
  const { impl, calls } = scriptedFetch({
    [SIGNED]: () => redirect("/signed/final.pdf"),
    [resolved]: () => pdfResponse(),
  });
  await expect(downloadDocument(SIGNED, { fetchImpl: impl })).resolves.toBeDefined();
  expect(calls).toEqual([SIGNED, resolved]);
});

// ── the size cap ───────────────────────────────────────────────────────────────────────────

test("an honest oversized Content-Length is refused before a byte is buffered", async () => {
  const { impl } = scriptedFetch({
    [SIGNED]: () => pdfResponse(PDF, { "content-length": String(64 * 1024 * 1024) }),
  });
  await expect(downloadDocument(SIGNED, { fetchImpl: impl })).rejects.toThrow(/over the .* cap/);
});

test("a CHUNKED body that lies about its size is stopped by the running counter", async () => {
  // No Content-Length at all, and far more bytes than the cap: the declared-length check cannot
  // help here, which is exactly why the counter over the stream exists (audit M15).
  let produced = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += 64 * 1024;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (produced > 8 * 1024 * 1024) controller.close();
    },
  });
  const { impl } = scriptedFetch({
    [SIGNED]: () =>
      new Response(body, { status: 200, headers: { "content-type": "application/pdf" } }),
  });
  await expect(
    // A 1 MiB cap for the test; the production value is 16 MiB.
    downloadDocument(SIGNED, { fetchImpl: impl, maxBytes: 1024 * 1024 }),
  ).rejects.toThrow(/while streaming/);
  // The stream was CANCELLED rather than drained: we stopped well short of what it would produce.
  expect(produced).toBeLessThan(8 * 1024 * 1024);
});

test("a non-2xx and an empty body are both refused", async () => {
  const err = scriptedFetch({ [SIGNED]: () => new Response("nope", { status: 403 }) });
  await expect(downloadDocument(SIGNED, { fetchImpl: err.impl })).rejects.toThrow(/HTTP 403/);

  const empty = scriptedFetch({ [SIGNED]: () => pdfResponse(Buffer.alloc(0)) });
  await expect(downloadDocument(SIGNED, { fetchImpl: empty.impl })).rejects.toThrow(/0 bytes/);
});

// ── the pure helpers ───────────────────────────────────────────────────────────────────────

test("the allowlist is the first URL's own host plus the S3 domains, and nothing else", () => {
  const allowed = redirectAllowlist(new URL(SIGNED));
  expect(allowed("api.test.doola.com")).toBe(true);
  expect(allowed("API.TEST.DOOLA.COM")).toBe(true);
  expect(allowed("doola-docs.s3.us-east-1.amazonaws.com")).toBe(true);
  expect(allowed("amazonaws.com")).toBe(true);
  expect(allowed("api.doola.com")).toBe(false);
  // The classic suffix-match bypass.
  expect(allowed("evil-amazonaws.com")).toBe(false);
  expect(allowed("amazonaws.com.attacker.example")).toBe(false);
});

test("normalizeContentType drops parameters and case", () => {
  expect(normalizeContentType("Application/PDF; charset=binary")).toBe("application/pdf");
  expect(normalizeContentType(null)).toBe("");
});
