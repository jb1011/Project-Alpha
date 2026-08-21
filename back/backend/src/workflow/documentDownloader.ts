import { createHash } from "node:crypto";
import {
  type HostLookup,
  SsrfError,
  assertPublicHost,
  assertPublicHttpsUrl,
} from "../payments/ssrfGuard";
import { withDeadline } from "../util/deadline";

/**
 * Fetching a legal PDF from doola's signed download URL (design §10 "doola compromise / poisoned
 * documents", audit M15).
 *
 * This is the one place in the formation loop where we follow a URL a third party gave us, so it
 * gets its own hardened fetcher rather than a bare `fetch`. It is deliberately NOT `safeFetch`:
 * that function forbids redirects outright, which is right for an x402 resource (it must answer
 * directly) and wrong here — doola's URLs are presigned S3 URLs and legitimately redirect. The
 * SSRF boundary itself is shared code (`assertPublicHttpsUrl` + `assertPublicHost`); only the
 * redirect policy differs, and it differs explicitly:
 *
 *  - **HTTPS only**, every hop. A signed URL that downgrades to http is not a download, it is an
 *    interception.
 *  - **At most two hops**, and every hop after the first must land on an ALLOWLISTED host —
 *    derived from the first URL's own host plus `*.amazonaws.com`. An open redirect at doola
 *    therefore cannot walk us to an arbitrary origin.
 *  - **Every hop re-resolved** against the blocked-IP ranges, so a redirect to a name that
 *    resolves to 169.254.169.254 is refused like any other.
 *  - **16 MiB, enforced while streaming.** `Content-Length` is advisory — a chunked response
 *    declares none and a hostile one lies — so the running counter over the body is the actual
 *    bound, and passing it cancels the stream rather than politely draining megabytes we have
 *    already decided to reject.
 *  - **A PDF, or nothing.** `application/pdf` or `application/octet-stream`; anything else is a
 *    login page, an error page, or something we should not be hashing into a legal manifest.
 *
 * The sha256 is computed HERE, over the same buffer the caller stores, so the index can never
 * record a hash of bytes other than the ones on disk.
 */

/** The cap, enforced while streaming. doola's real documents are a few hundred kilobytes. */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** Redirect hops allowed after the original URL. Presigned S3 needs one; two is slack. */
export const MAX_DOCUMENT_REDIRECTS = 2;

/** Content types a legal PDF may legitimately arrive as. */
export const ALLOWED_DOCUMENT_CONTENT_TYPES = ["application/pdf", "application/octet-stream"];

const DEFAULT_TIMEOUT_MS = 60_000;

export class DocumentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentDownloadError";
  }
}

export interface DownloadedDocument {
  bytes: Buffer;
  sha256: string;
  contentType: string;
  size: number;
}

/**
 * The hosts a redirect may land on: the ORIGINAL URL's own host, plus Amazon's S3 domains.
 *
 * Derived from the first URL rather than configured, so it adapts to whatever host doola signs
 * from without an operator having to keep a list in sync — while still being a closed set for any
 * single download. `*.amazonaws.com` is in it because that is where presigned S3 URLs actually
 * redirect; it is a broad allowance and it is named as one.
 */
export function redirectAllowlist(first: URL): (host: string) => boolean {
  const origin = first.hostname.toLowerCase();
  return (host: string) => {
    const h = host.toLowerCase();
    return h === origin || h === "amazonaws.com" || h.endsWith(".amazonaws.com");
  };
}

/** Strip parameters and case from a content type: `application/pdf; charset=binary` -> `application/pdf`. */
export function normalizeContentType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Read a response body under a running cap. Returns the buffer, or throws once the cap is passed.
 * Mirrors the doola client's `readCappedBody` — same reasoning, different limit and different
 * error type, because a document that is too large is a different operational event from an API
 * response that is.
 */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers?.get?.("content-length") ?? Number.NaN);
  // The honest large response, caught before a single byte is buffered.
  if (Number.isFinite(declared) && declared > max)
    throw new DocumentDownloadError(
      `document declares ${declared} bytes, over the ${max}-byte cap`,
    );

  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max)
      throw new DocumentDownloadError(`document is ${buf.length} bytes, over the ${max}-byte cap`);
    return buf;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    // The bound that actually holds: Content-Length is spoofable on a chunked response.
    if (total > max) {
      await reader.cancel().catch(() => {
        // the throw below is the signal; a failed cancel must not mask it
      });
      throw new DocumentDownloadError(
        `document exceeded the ${max}-byte cap while streaming (at least ${total} bytes)`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injected in tests so the suite never touches DNS. Production omits it and gets the real
   *  resolver; there is no option that turns the blocked-range classification OFF. */
  lookupImpl?: HostLookup;
}

/**
 * Download one legal document. Throws `SsrfError` / `DocumentDownloadError` — never resolves with
 * partial or unverified bytes.
 */
export async function downloadDocument(
  url: string,
  opts: DownloadOptions = {},
): Promise<DownloadedDocument> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_DOCUMENT_BYTES;

  return await withDeadline(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
    const first = assertPublicHttpsUrl(url);
    const allowed = redirectAllowlist(first);
    let current = first;

    for (let hop = 0; ; hop++) {
      // Re-checked on EVERY hop, not just the first: a redirect target is exactly as untrusted as
      // the original URL, and more so — it was chosen after we committed to the request.
      await assertPublicHost(current, opts.lookupImpl);
      const res = await fetchImpl(current.toString(), { redirect: "manual", signal });

      if (res.status >= 300 && res.status < 400) {
        if (hop >= MAX_DOCUMENT_REDIRECTS)
          throw new DocumentDownloadError(
            `document download exceeded ${MAX_DOCUMENT_REDIRECTS} redirects`,
          );
        const location = res.headers?.get?.("location");
        if (!location)
          throw new DocumentDownloadError(
            `document download returned ${res.status} with no Location`,
          );
        // Resolved against the CURRENT url so a relative Location works, then re-validated from
        // scratch — protocol, IP-literal class, and now the allowlist.
        const next = assertPublicHttpsUrl(new URL(location, current).toString());
        if (!allowed(next.hostname))
          throw new SsrfError(
            `document redirect to ${next.hostname} is outside the allowlist (${first.hostname} + *.amazonaws.com)`,
          );
        current = next;
        continue;
      }

      if (res.status < 200 || res.status >= 300)
        throw new DocumentDownloadError(`document download failed with HTTP ${res.status}`);

      const contentType = normalizeContentType(res.headers?.get?.("content-type"));
      // Checked BEFORE the body is read: an HTML login page is not worth 16 MiB of patience.
      if (!ALLOWED_DOCUMENT_CONTENT_TYPES.includes(contentType))
        throw new DocumentDownloadError(
          `document download returned content-type "${contentType || "(none)"}" — expected ${ALLOWED_DOCUMENT_CONTENT_TYPES.join(" or ")}`,
        );

      const bytes = await readCapped(res, maxBytes);
      if (bytes.length === 0) throw new DocumentDownloadError("document download returned 0 bytes");
      return {
        bytes,
        // Hashed here, over the same buffer the caller stores: the index can never record the
        // hash of bytes other than the ones that reached disk.
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType,
        size: bytes.length,
      };
    }
  });
}
