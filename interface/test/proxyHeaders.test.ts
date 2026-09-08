/**
 * The proxy's route predicates, run IN THIS PACKAGE (design §7, gate finding #18).
 *
 * There is a guard in the backend suite too, and the two are not redundant: that one reads this
 * module as TEXT and extracts the regex literals, because it has to run in CI beside a route that
 * moved. This one IMPORTS the functions and calls them, which is the thing text can never do —
 * it exercises the semantics rather than the spelling.
 *
 * What they protect: A3 moved the document routes from `/entities/:id/documents…` to
 * `/companies/:companyId/documents…`. A predicate left on the old prefix goes on matching
 * NOTHING, and every legal PDF then crosses the proxy with no `content-disposition` (no filename),
 * no `x-content-type-options` (sniffable), and no `cache-control: private, no-store` (an
 * intermediary free to cache one tenant's legal documents). All three are silent: the download
 * still "works".
 */
import { expect, test } from "vitest";
import {
  DOCUMENT_RESPONSE_HEADERS,
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  isDocumentDownloadPath,
  isNoStorePath,
  isPublicReferencePath,
} from "@/lib/proxyHeaders";

test("the download path is the COMPANY route, and never the entity one it replaced", () => {
  expect(isDocumentDownloadPath("companies/abc/documents/def")).toBe(true);
  // The shape it replaced. Matching it would mean the rename was reverted, or never finished.
  expect(isDocumentDownloadPath("entities/abc/documents/def")).toBe(false);
});

test("only the BYTES route counts — the JSON index above it needs none of the four headers", () => {
  expect(isDocumentDownloadPath("companies/abc/documents")).toBe(false);
  // Anchored at both ends: a longer path is not a download, and a prefix is not a match.
  expect(isDocumentDownloadPath("companies/abc/documents/def/extra")).toBe(false);
  expect(isDocumentDownloadPath("x/companies/abc/documents/def")).toBe(false);
});

test("no-store covers BOTH company document routes, plus the credential-bearing ones", () => {
  expect(isNoStorePath("companies/abc/documents")).toBe(true);
  expect(isNoStorePath("companies/abc/documents/def")).toBe(true);
  expect(isNoStorePath("connection-package")).toBe(true);
  expect(isNoStorePath("bootstrap-connection")).toBe(true);
  // Not every company route: only the ones that carry legal bytes or fresh credentials.
  expect(isNoStorePath("companies/abc")).toBe(false);
  expect(isNoStorePath("companies")).toBe(false);
  expect(isNoStorePath("entities/abc/documents/def")).toBe(false);
});

test("the four document headers are added on the download and NOWHERE else", () => {
  const none = { get: () => null };
  const onDownload = forwardedResponseHeaders("companies/abc/documents/def", none);
  for (const h of DOCUMENT_RESPONSE_HEADERS) expect(onDownload, h).toContain(h);

  // Three of the four are not inert elsewhere: a `content-disposition` on a JSON response turns
  // an API call into a file save, and a backend `cache-control` echoed onto every route silently
  // overrides the policy the proxy would otherwise apply.
  const onJson = forwardedResponseHeaders("companies/abc", none);
  expect(onJson).toEqual([...FORWARDED_RESPONSE_HEADERS]);
  for (const h of DOCUMENT_RESPONSE_HEADERS) expect(onJson, h).not.toContain(h);
});

test("content-length is dropped beside a content-encoding — a lying length TRUNCATES", () => {
  // The backend's byte count describes the bytes IT produced. If anything between the proxy and
  // the browser compresses the body, that number is a lie about the bytes on the wire, and a
  // wrong Content-Length truncates the download at whatever byte it names. The browser is
  // perfectly happy with a chunked response and no length; it is not happy with a wrong one.
  const encoded = { get: (n: string) => (n === "content-encoding" ? "gzip" : null) };
  const headers = forwardedResponseHeaders("companies/abc/documents/def", encoded);
  expect(headers).not.toContain("content-length");
  // …and the other three still cross, so the download keeps its filename and its no-store.
  for (const h of ["content-disposition", "cache-control", "x-content-type-options"])
    expect(headers, h).toContain(h);
});

/* ── the public reference route (§7, A3) ───────────────────────────────────── */

test("the industry list is the ONE public cacheable path, and nothing near it is", () => {
  expect(isPublicReferencePath("formation/rules")).toBe(true);
  // Anchored: a prefix is not a match, and neither is anything under it.
  expect(isPublicReferencePath("formation/rules/extra")).toBe(false);
  expect(isPublicReferencePath("x/formation/rules")).toBe(false);
  expect(isPublicReferencePath("formation-party")).toBe(false);
  expect(isPublicReferencePath("companies")).toBe(false);
});

test("`if-none-match` crosses on that path ONLY — otherwise the ETag is decorative", () => {
  // Dropping it means the browser holds a validator it can never send, so every revalidation
  // after `max-age` re-downloads ~20 KB of federal labels to learn they have not changed.
  expect(forwardedRequestHeaders("formation/rules")).toContain("if-none-match");
  expect(forwardedRequestHeaders("companies")).not.toContain("if-none-match");
  // …and the global list is intact on both.
  for (const header of FORWARDED_REQUEST_HEADERS) {
    expect(forwardedRequestHeaders("formation/rules")).toContain(header);
    expect(forwardedRequestHeaders("companies")).toContain(header);
  }
});

test("`etag` and `cache-control` come BACK on that path, and `cache-control` on no other", () => {
  const headers = new Headers();
  const reference = forwardedResponseHeaders("formation/rules", headers);
  expect(reference).toContain("etag");
  expect(reference).toContain("cache-control");
  // Echoing a backend `cache-control` onto every route would silently override the proxy's own
  // policy, which is why it is scoped rather than global.
  expect(forwardedResponseHeaders("entities", headers)).not.toContain("cache-control");
  expect(forwardedResponseHeaders("entities", headers)).not.toContain("etag");
});

test("the reference route never picks up the DOCUMENT headers, or vice versa", () => {
  const headers = new Headers();
  expect(forwardedResponseHeaders("formation/rules", headers)).not.toContain(
    "content-disposition",
  );
  expect(forwardedResponseHeaders("companies/abc/documents/def", headers)).toContain(
    "content-disposition",
  );
  // …and the document route is still forced to `no-store` by the second lock.
  expect(isNoStorePath("companies/abc/documents/def")).toBe(true);
  expect(isNoStorePath("formation/rules")).toBe(false);
});
