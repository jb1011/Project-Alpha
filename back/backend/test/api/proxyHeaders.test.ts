/**
 * Drift guard over the Vercel proxy's header allowlists (design §8, audit M14/15).
 *
 * The interface package has no test runner, and the proxy sits between every browser request and
 * this backend — so the guard lives here, in the suite that actually runs in CI. It reads
 * `interface/src/lib/proxyHeaders.ts` as text, exactly like the ABI drift-guard the design calls
 * for on the guardian ABI fragment.
 *
 * What it protects: a document download whose `content-disposition` is dropped arrives with no
 * filename, one whose `x-content-type-options` is dropped is sniffable, and one whose
 * `cache-control` is dropped can be cached by an intermediary that has no business holding one
 * tenant's legal documents. All three are silent failures — the download still "works".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const PROXY_HEADERS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "interface",
  "src",
  "lib",
  "proxyHeaders.ts",
);
const PROXY_ROUTE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "interface",
  "src",
  "app",
  "backend",
  "[[...path]]",
  "route.ts",
);

const source = () => readFileSync(PROXY_HEADERS, "utf8");

test("the interface's proxy-header module is where this guard expects it", () => {
  // If this fails the module was moved or renamed, and everything below would silently pass.
  expect(existsSync(PROXY_HEADERS), PROXY_HEADERS).toBe(true);
  expect(existsSync(PROXY_ROUTE), PROXY_ROUTE).toBe(true);
});

test("C9: the document headers are their OWN list, scoped to the download", () => {
  const s = source();
  const docs = s.slice(
    s.indexOf("export const DOCUMENT_RESPONSE_HEADERS"),
    s.indexOf("export function forwardedResponseHeaders"),
  );
  for (const h of [
    // Without it the browser has no filename.
    "content-disposition",
    // Without it a tenant's legal document can be cached by an intermediary.
    "cache-control",
    // Without it a download shows a spinner instead of progress.
    "content-length",
    // Without it the browser is free to sniff a type of its own.
    "x-content-type-options",
  ])
    expect(docs, h).toContain(`"${h}"`);

  // …and NOT on the global list, where three of them are not inert: a `content-disposition` on a
  // JSON response turns an API call into a file save, and a backend `cache-control` echoed onto
  // every route silently overrides the policy the proxy would otherwise apply.
  const global = s.slice(
    s.indexOf("export const FORWARDED_RESPONSE_HEADERS"),
    s.indexOf("export const DOCUMENT_RESPONSE_HEADERS"),
  );
  for (const h of ["content-disposition", "cache-control", "content-length", "x-content-type-options"])
    expect(global, h).not.toContain(`"${h}"`);

  // The ones that were already global and must not be lost in the split.
  for (const h of [
    "content-type",
    "mcp-session-id",
    "x-payment-response",
    "x-agentkit-human",
    "x-agentkit-authorization",
  ])
    expect(global, h).toContain(`"${h}"`);
});

test("C9: content-length is never forwarded beside a content-encoding", () => {
  // The backend's byte count describes the bytes IT produced. If anything between the proxy and
  // the browser compresses the body, that number is a lie about the bytes on the wire — and a
  // lying Content-Length truncates the download at whatever byte the wrong number names.
  const fn = source().slice(source().indexOf("export function forwardedResponseHeaders"));
  expect(fn).toContain("content-encoding");
  expect(fn).toContain("content-length");
  // The gate is on the DOWNLOAD path, so every other route keeps the previous out-header set.
  expect(fn).toContain("isDocumentDownloadPath");
  expect(fn).toContain("return FORWARDED_RESPONSE_HEADERS");
});

test("C9: only the BYTES route is a document-download path, not the JSON index above it", () => {
  const s = source();
  const fn = s.slice(s.indexOf("export function isDocumentDownloadPath"));
  // Two path segments after `documents`, not one: the index route returns JSON and needs none of
  // the four headers.
  expect(fn).toContain("documents\\/[^/]+$");
});

test("the request allowlist still carries what the non-browser protocols need", () => {
  const s = source();
  const list = s.slice(s.indexOf("FORWARDED_REQUEST_HEADERS"), s.indexOf("FORWARDED_RESPONSE"));
  for (const h of [
    "authorization",
    "content-type",
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "x-payment",
    "agentkit",
  ])
    expect(list, h).toContain(`"${h}"`);
});

test("the proxy must NOT forward the doola signature header", () => {
  // doola's webhooks go to the backend origin directly. If this header were forwardable, someone
  // would eventually point the portal at the proxy — and, because the signature covers the raw
  // body while the proxy re-reads and re-sends it, the deliveries would 401 anyway. Five of those
  // disable the endpoint.
  expect(source().toLowerCase()).not.toContain('"x-doola-signature"');
});

test("the document paths are in the no-store branch", () => {
  const s = source();
  // The credential-bearing routes that were already there…
  expect(s).toContain('"connection-package"');
  expect(s).toContain('"bootstrap-connection"');
  // …plus documents, matched as a path pattern because the entity id is in the middle.
  const fn = s.slice(s.indexOf("export function isNoStorePath"));
  expect(fn).toContain("documents");
});

test("the route file uses the allowlists rather than a second copy of them", () => {
  const route = readFileSync(PROXY_ROUTE, "utf8");
  expect(route).toContain("FORWARDED_REQUEST_HEADERS");
  // The RESOLVER, not the raw list: which headers cross now depends on the route and on what the
  // backend answered, and a route that read the constant directly would forward the four
  // download headers everywhere again.
  expect(route).toContain("forwardedResponseHeaders(joined, res.headers)");
  expect(route).toContain("isNoStorePath");
  // A route that re-declared its own array would drift the moment one of them was edited.
  expect(route).not.toMatch(/const\s+forwarded\s*=\s*\[/);
});

/**
 * The allowlist behaviour, re-implemented from the source's own literals.
 *
 * Importing the module directly is not possible from here (the interface package has its own
 * tsconfig and module resolution), so the guard parses the arrays it just checked and exercises
 * the semantics: an allowlist DROPS what it does not name.
 */
test("an unlisted header is dropped in both directions", () => {
  const s = source();
  const parse = (name: string) => {
    const start = s.indexOf(`export const ${name} = [`);
    const body = s.slice(start, s.indexOf("] as const", start));
    return [...body.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  };
  const req = parse("FORWARDED_REQUEST_HEADERS");
  const res = [...parse("FORWARDED_RESPONSE_HEADERS"), ...parse("DOCUMENT_RESPONSE_HEADERS")];
  expect(req.length).toBeGreaterThan(0);
  expect(res.length).toBeGreaterThan(0);

  for (const sneaky of ["cookie", "x-forwarded-for", "host", "x-doola-signature"])
    expect(req, sneaky).not.toContain(sneaky);
  for (const leaky of ["set-cookie", "server", "x-powered-by"])
    expect(res, leaky).not.toContain(leaky);
});
