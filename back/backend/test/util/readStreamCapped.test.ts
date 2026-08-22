/**
 * M4: the ONE capped body reader.
 *
 * Three modules read a body they do not control — the doola API client, the doola webhook
 * receiver and the legal-document downloader — and all three had their own copy of the same
 * fifteen lines. The copies had already drifted in their fallbacks, and every one of them is the
 * last thing standing between a wedged or hostile upstream and this process's heap.
 *
 * The MECHANISM is shared; the ERROR stays each caller's, because "a doola response was too
 * large" and "a legal document was too large" are different operational events with different
 * runbooks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readCappedStream, readCappedText } from "../../src/util/readStreamCapped";

class Declared extends Error {}
class Streamed extends Error {}
const errors = {
  declared: (n: number) => new Declared(String(n)),
  streamed: (n: number) => new Streamed(String(n)),
};

/** A body that yields the given chunks, and records whether it was cancelled. */
function chunked(chunks: Buffer[]) {
  const state = { cancelled: false };
  let i = 0;
  const body = {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false, value: new Uint8Array(chunks[i++]!) }
          : { done: true, value: undefined },
      cancel: async () => {
        state.cancelled = true;
      },
    }),
  } as unknown as ReadableStream<Uint8Array>;
  return { body, state };
}

test("M4: a declared length over the cap is refused before a single byte is read", async () => {
  const { body, state } = chunked([Buffer.alloc(10)]);
  await expect(
    readCappedStream(
      { body, contentLength: "9999", readAll: async () => Buffer.alloc(0) },
      100,
      errors,
    ),
  ).rejects.toBeInstanceOf(Declared);
  // Nothing was streamed, so nothing needed cancelling.
  expect(state.cancelled).toBe(false);
});

test("M4: a LYING declared length is caught by the running counter, and the stream is cancelled", async () => {
  // The half that actually enforces the bound: a chunked response declares no length at all, and
  // a hostile one declares a small one. Cancelling tears the socket down instead of politely
  // draining megabytes we have already decided to reject.
  const { body, state } = chunked([Buffer.alloc(60), Buffer.alloc(60), Buffer.alloc(60)]);
  await expect(
    readCappedStream(
      { body, contentLength: "10", readAll: async () => Buffer.alloc(0) },
      100,
      errors,
    ),
  ).rejects.toBeInstanceOf(Streamed);
  expect(state.cancelled).toBe(true);
});

test("M4: a body with no stream falls back to readAll — and is size-checked all the same", async () => {
  // A 204, an empty body, or a hand-rolled fake in a test. The fallback is where the three copies
  // had drifted (text(), arrayBuffer(), Hono's c.req.text()), so it is the one that matters most.
  const ok = await readCappedText(
    { body: null, contentLength: null, readAll: async () => Buffer.from("hello", "utf8") },
    100,
    errors,
  );
  expect(ok).toBe("hello");

  await expect(
    readCappedStream(
      { body: undefined, contentLength: null, readAll: async () => Buffer.alloc(500) },
      100,
      errors,
    ),
  ).rejects.toBeInstanceOf(Streamed);
});

test("M4: a body exactly AT the cap is accepted — the bound is inclusive", async () => {
  const { body } = chunked([Buffer.alloc(50), Buffer.alloc(50)]);
  const out = await readCappedStream(
    { body, contentLength: "100", readAll: async () => Buffer.alloc(0) },
    100,
    errors,
  );
  expect(out.length).toBe(100);
});

test("M4: all three readers use the shared one, and none keeps a private copy", () => {
  const src = (...rel: string[]) =>
    readFileSync(join(import.meta.dirname, "..", "..", "src", ...rel), "utf8");
  for (const [file, path] of [
    ["doola client", ["adapters", "doola", "doolaClient.ts"]],
    ["webhook receiver", ["api", "routes", "doolaWebhook.ts"]],
    ["document downloader", ["workflow", "documentDownloader.ts"]],
  ] as const) {
    const s = src(...path);
    expect(s, file).toContain("util/readStreamCapped");
    // The tell-tale of a private copy: its own reader loop.
    expect(s, file).not.toContain("body.getReader()");
  }
});
