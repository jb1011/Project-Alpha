/**
 * What the Vercel backend proxy forwards, in each direction.
 *
 * Extracted from the route handler so the lists are reviewable on their own and so the backend's
 * drift guard (`back/backend/test/api/proxyHeaders.test.ts`) can read them. A Next.js `route.ts`
 * may only export HTTP verbs, which is the mechanical reason this is a separate module — but the
 * better reason is that "which headers cross the boundary" is a security decision, and it should
 * not be buried in the middle of a request handler.
 *
 * Both lists are ALLOWLISTS. Anything not named here is dropped, which is the safe default in
 * both directions: an unlisted request header cannot be used to smuggle credentials to the
 * backend, and an unlisted response header cannot leak backend detail to the browser.
 */

/** Request headers the browser may send THROUGH the proxy. */
export const FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  // MCP Streamable HTTP requires these end-to-end (the backend 406s without them).
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  // x402 requires this end-to-end (the seller re-issues its 402 challenge without it).
  "x-payment",
  // AgentKit sends its human-backing proof in a header named exactly `agentkit`; dropping it
  // made every external agent look anonymous to the seller, which refused them all.
  "agentkit",
] as const;

/**
 * Response headers the backend may send BACK through the proxy, on EVERY route.
 *
 * NOTE: `x-doola-signature` is deliberately absent from the REQUEST list above. doola's webhooks
 * must be pointed at the backend origin directly — a portal pointed here would 401 on every
 * delivery, and five of those disable the endpoint.
 */
export const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  // x402 settlement id, returned to the buyer.
  "x-payment-response",
  // AgentKit outcome: who the seller judged to be backing the agent, and its remaining budget.
  // Without these an authorized agent cannot read its own standing.
  "x-agentkit-human",
  "x-agentkit-authorization",
] as const;

/**
 * Response headers forwarded ONLY on the legal-document download (design §8, audit M14/15, C9).
 *
 * All four exist for that one route: without `content-disposition` the browser has no filename,
 * without `x-content-type-options` it is free to sniff a type of its own, without `cache-control`
 * a PDF belonging to one tenant can be cached by an intermediary, and without `content-length` a
 * download shows a spinner instead of progress.
 *
 * They are scoped rather than global because three of them are not inert elsewhere. A
 * `content-disposition` leaking onto a JSON response turns an API call into a file save; a
 * backend `cache-control` echoed onto every route silently overrides the caching policy the
 * proxy would otherwise apply; and `content-length` is the dangerous one — see below.
 */
export const DOCUMENT_RESPONSE_HEADERS = [
  "content-disposition",
  "cache-control",
  "content-length",
  "x-content-type-options",
] as const;

/**
 * Which response headers this path may carry, given what the backend actually answered.
 *
 * `content-length` is dropped whenever the response is ENCODED. The header the backend sent
 * counts the bytes it produced; if anything between here and the browser compresses the body, the
 * number is a lie about the bytes on the wire — and a lying `Content-Length` is not a cosmetic
 * problem, it truncates the download at whatever byte the wrong number names. `undici` also
 * refuses to re-send it beside a `content-encoding` it did not produce. The browser is perfectly
 * happy with a chunked response and no length; it is not happy with a wrong one.
 */
export function forwardedResponseHeaders(
  joinedPath: string,
  headers: { get(name: string): string | null },
): readonly string[] {
  if (!isDocumentDownloadPath(joinedPath)) return FORWARDED_RESPONSE_HEADERS;
  const encoded = Boolean(headers.get("content-encoding"));
  return [
    ...FORWARDED_RESPONSE_HEADERS,
    ...DOCUMENT_RESPONSE_HEADERS.filter((h) => !(encoded && h === "content-length")),
  ];
}

/** `entities/<id>/documents/<docId>` — the bytes route, and only it. The INDEX route above it
 *  returns JSON and needs none of the four. */
export function isDocumentDownloadPath(joinedPath: string): boolean {
  return /^entities\/[^/]+\/documents\/[^/]+$/.test(joinedPath);
}

/**
 * Paths whose responses must never be cached by anything between the backend and the browser.
 *
 * The connection package and the bootstrap response carry freshly minted credentials. Document
 * downloads carry legal documents belonging to one tenant. The backend already sets
 * `Cache-Control: private, no-store` on documents; this is the second lock, because the proxy is
 * where an intermediary would otherwise be free to decide for itself.
 */
export function isNoStorePath(joinedPath: string): boolean {
  return (
    joinedPath === "connection-package" ||
    joinedPath === "bootstrap-connection" ||
    // entities/<id>/documents and entities/<id>/documents/<docId>
    /^entities\/[^/]+\/documents(\/|$)/.test(joinedPath)
  );
}
