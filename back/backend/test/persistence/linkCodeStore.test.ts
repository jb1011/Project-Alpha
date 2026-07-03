import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteLinkCodeStore } from "../../src/persistence/linkCodeStore";

function store() {
  const db = new Database(":memory:");
  migrate(db);
  return new SqliteLinkCodeStore(db);
}

test("issue then consume once (single-use, tenant-scoped)", () => {
  const s = store();
  const code = s.issue("0xTENANT", 1000, 60_000);
  expect(s.consume("0xTENANT", code, 2000)).toBe(true); // first consume ok
  expect(s.consume("0xTENANT", code, 2000)).toBe(false); // single-use: gone
});

test("wrong tenant cannot consume, and does not burn the code", () => {
  const s = store();
  const code = s.issue("0xTENANT", 1000, 60_000);
  expect(s.consume("0xOTHER", code, 2000)).toBe(false); // not your tenant
  expect(s.consume("0xTENANT", code, 2000)).toBe(true); // still valid for the owner
});

test("expired code does not consume", () => {
  const s = store();
  const code = s.issue("0xTENANT", 1000, 60_000);
  expect(s.consume("0xTENANT", code, 1000 + 60_001)).toBe(false); // past expiry
});
