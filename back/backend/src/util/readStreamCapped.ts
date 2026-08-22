/**
 * ONE capped body reader (M4).
 *
 * Three modules read a body they do not control — the doola API client, the doola webhook
 * receiver, and the legal-document downloader — and all three had their own copy of the same
 * fifteen lines. The copies had already started to drift (one fell back to `text()`, one to
 * `arrayBuffer()`, one to Hono's `c.req.text()`), and every one of them is the last thing standing
 * between a wedged or hostile upstream and this process's heap.
 *
 * Both halves are load-bearing, and that is why the reader takes both:
 *
 *  - `Content-Length` catches the HONEST oversized body before a single chunk is buffered;
 *  - the running counter over the stream is what actually enforces the bound, because a chunked
 *    response declares no length at all and a hostile one declares a small one. Passing the cap
 *    CANCELS the stream, which tears the socket down instead of politely draining megabytes we
 *    have already decided to reject.
 *
 * The error is the CALLER's, not this module's: "a doola response was too large" and "a legal
 * document was too large" are different operational events with different codes and different
 * runbooks, and collapsing them into one error class would lose that. So each call site passes
 * two factories and keeps its own vocabulary.
 */

export interface CappedSource {
  /** The body stream, when there is one. A 204, an empty body, or a hand-rolled test fake has
   *  none — `readAll` is the fallback for exactly those. */
  body: ReadableStream<Uint8Array> | null | undefined;
  /** The declared `Content-Length` header value, verbatim (or null/undefined when absent). */
  contentLength: string | null | undefined;
  /** Read the whole body when there is no stream to meter. Its result is still size-checked. */
  readAll: () => Promise<Buffer>;
}

export interface CappedErrors {
  /** The declared length is already over the cap. Nothing has been read. */
  declared: (declared: number) => Error;
  /** The running total passed the cap. `soFar` is a lower bound on the real size. */
  streamed: (soFar: number) => Error;
}

/**
 * Read a body under a running byte cap. Returns the bytes, or throws one of the caller's errors.
 */
export async function readCappedStream(
  source: CappedSource,
  max: number,
  errors: CappedErrors,
): Promise<Buffer> {
  const declared = Number(source.contentLength ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) throw errors.declared(declared);

  const body = source.body;
  if (!body || typeof body.getReader !== "function") {
    // No stream to meter: read it, then apply the same bound to what came back.
    const buf = await source.readAll();
    if (buf.length > max) throw errors.streamed(buf.length);
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
    if (total > max) {
      await reader.cancel().catch(() => {
        // the throw below is the real signal; a failed cancel must not mask it
      });
      throw errors.streamed(total);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The same read, as UTF-8 text — what both JSON callers actually want. */
export async function readCappedText(
  source: CappedSource,
  max: number,
  errors: CappedErrors,
): Promise<string> {
  return (await readCappedStream(source, max, errors)).toString("utf8");
}
