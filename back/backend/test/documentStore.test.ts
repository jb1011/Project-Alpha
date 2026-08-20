import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FileDocumentStore } from "../src/persistence/documentStore";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docstore-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("put writes a file and returns a stable file:// URI; get reads it back", () => {
  const store = new FileDocumentStore(dir);
  const put = store.put("operating-agreement.md", "# OA\nbody");
  expect(put.uri.startsWith("file://")).toBe(true);
  expect(store.get(put.id)).toBe("# OA\nbody");
});

test("same id derives from name (deterministic per logical doc)", () => {
  const store = new FileDocumentStore(dir);
  const a = store.put("oa-key-1.md", "x");
  const b = store.put("oa-key-1.md", "y"); // overwrite
  expect(a.id).toBe(b.id);
  expect(store.get(a.id)).toBe("y");
});

test("putBytes round-trips binary content byte-for-byte (PDFs are not utf8)", () => {
  const store = new FileDocumentStore(dir);
  // Bytes that a utf8 round-trip would mangle: a PDF header, a NUL, and lone high bytes.
  const bytes = Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0xfe, 0x80,
  ]);
  const put = store.putBytes("articles.pdf", bytes);
  expect(put.id).toBe("articles.pdf");
  expect(put.uri.startsWith("file://")).toBe(true);
  const read = store.getBytes(put.id);
  expect(Buffer.compare(read, bytes)).toBe(0);
  expect(createHash("sha256").update(read).digest("hex")).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
});

test("putBytes leaves NO temp files behind and overwrites atomically", () => {
  const store = new FileDocumentStore(dir);
  store.putBytes("oa.pdf", Buffer.from("v1"));
  store.putBytes("oa.pdf", Buffer.from("v2-longer"));
  expect(store.getBytes("oa.pdf").toString()).toBe("v2-longer");
  // A leftover `.tmp-*` would mean a rename that never happened — i.e. bytes that could be
  // hashed and anchored while the real file still holds the previous version.
  expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  expect(readdirSync(dir)).toEqual(["oa.pdf"]);
});

test("putBytes writes through a temp file, never in place (torn-write guard, audit M7)", () => {
  const store = new FileDocumentStore(dir);
  store.putBytes("manifest.json", Buffer.from("original"));
  const target = join(dir, "manifest.json");
  // Freeze the real file: an in-place writer (open 'w' + write) would truncate it here and leave
  // a zero-length file whose hash is NOT the manifest's. The atomic writer touches a temp instead,
  // so the failure — if any — never reaches the anchored name.
  chmodSync(target, 0o444);
  try {
    store.putBytes("manifest.json", Buffer.from("replacement"));
  } finally {
    chmodSync(target, 0o644);
  }
  // rename() replaces a read-only target on POSIX (the DIRECTORY is what must be writable), so
  // the new bytes land whole. What must never happen is a truncated/partial "original".
  const after = store.getBytes("manifest.json").toString();
  expect(["original", "replacement"]).toContain(after);
  expect(after).not.toBe("");
});

test("getBytes/putBytes keep the traversal guard (an id may never escape the root)", () => {
  const store = new FileDocumentStore(dir);
  expect(() => store.putBytes("../escape.pdf", Buffer.from("x"))).toThrow(/escapes the store root/);
  expect(() => store.getBytes("../../etc/passwd")).toThrow(/escapes the store root/);
  // An ABSOLUTE-looking id is not an escape: join() re-roots it under the store, so it lands at
  // <root>/etc/passwd. Pin that, so nobody "fixes" safePath into resolve(id) and turns an
  // attacker-supplied absolute path into a real one.
  expect(() => store.putBytes("/etc/passwd", Buffer.from("x"))).toThrow(/ENOENT/);
  expect(() => store.getBytes("/etc/passwd")).toThrow(/ENOENT/);
});
