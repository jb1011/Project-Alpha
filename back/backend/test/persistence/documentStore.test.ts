import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FileDocumentStore } from "../../src/persistence/documentStore";

function store() {
  return new FileDocumentStore(mkdtempSync(join(tmpdir(), "docstore-")));
}

test("put/get reject an id that escapes the doc root", () => {
  const s = store();
  expect(() => s.put("../evil.json", "{}")).toThrow(/escapes/);
  expect(() => s.get("../../../../etc/passwd")).toThrow(/escapes/);
});

test("a normal id still round-trips", () => {
  const s = store();
  s.put("meta-0xabc:agent.json", '{"a":1}');
  expect(s.get("meta-0xabc:agent.json")).toBe('{"a":1}');
});
