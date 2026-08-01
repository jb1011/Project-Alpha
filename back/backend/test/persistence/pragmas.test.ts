import { expect, test } from "vitest";
import { openDatabase } from "../../src/persistence/db";

test("openDatabase pins synchronous=NORMAL (WAL-safe; untuned default FULL fsyncs every commit)", () => {
  const db = openDatabase(":memory:");
  // 1 = NORMAL, 2 = FULL. Guards against the pragma being dropped in a refactor.
  expect(db.pragma("synchronous", { simple: true })).toBe(1);
  db.close();
});
