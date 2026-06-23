import { mkdtempSync, rmSync } from "node:fs";
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
