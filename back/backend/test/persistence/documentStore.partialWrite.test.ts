/**
 * D2: a SHORT write must never be published under the anchored name.
 *
 * `writeSync` is allowed to write fewer bytes than it was handed — its return value is the only
 * report of that — so the previous unchecked single call could fsync and rename a TRUNCATED file
 * into place. Every other part of the atomic ceremony (tmp file, fsync, rename) survives that
 * intact: the bytes land whole and durably… and are the wrong bytes. A hash anchored over them
 * is unverifiable forever.
 *
 * The mock below clamps every write to 3 bytes, which is what a short write looks like from the
 * caller's side. It lives in its own file because `vi.mock` is per-module-graph.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    /** Honest partial write: takes at most 3 bytes and reports exactly what it took. */
    writeSync: (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset = 0,
      length = (buffer as Buffer).length - offset,
    ) => real.writeSync(fd, buffer as Buffer, offset, Math.min(length, 3)),
  };
});

const { FileDocumentStore } = await import("../../src/persistence/documentStore");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docstore-partial-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("D2: putBytes loops until every byte is written, even when writeSync writes short", () => {
  const store = new FileDocumentStore(dir);
  // Deliberately not a multiple of the clamp, and long enough to need many passes.
  const bytes = Buffer.from("the canonical manifest bytes that get keccak-hashed onto Arc", "utf8");
  const put = store.putBytes("manifest-key-v1.json", bytes);
  expect(Buffer.compare(readFileSync(put.path), bytes)).toBe(0);
  expect(Buffer.compare(store.getBytes(put.id), bytes)).toBe(0);
});

test("D2: put (text) rides the same loop — the terms doc is hashed too", () => {
  const store = new FileDocumentStore(dir);
  const doc = "# Operating Agreement — Partial Write\n\nJurisdiction: Wyoming-DAO-LLC\n";
  const put = store.put("oa-key-v1.md", doc);
  expect(store.get(put.id)).toBe(doc);
  expect(readFileSync(put.path, "utf8")).toBe(doc);
});

test("D2: binary bytes survive the short-write loop byte for byte", () => {
  const store = new FileDocumentStore(dir);
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0xfe, 0x80]);
  store.putBytes("articles.pdf", pdf);
  expect(Buffer.compare(store.getBytes("articles.pdf"), pdf)).toBe(0);
});
