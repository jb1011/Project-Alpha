import { expect, test } from "vitest";
import { entityInScope, hasCapability } from "../../src/mcp/scope";

test("capability ladder: read < earn < spend", () => {
  expect(hasCapability({ capability: "read" }, "read")).toBe(true);
  expect(hasCapability({ capability: "read" }, "earn")).toBe(false);
  expect(hasCapability({ capability: "read" }, "spend")).toBe(false);
  expect(hasCapability({ capability: "earn" }, "read")).toBe(true);
  expect(hasCapability({ capability: "earn" }, "earn")).toBe(true);
  expect(hasCapability({ capability: "earn" }, "spend")).toBe(false);
  expect(hasCapability({ capability: "spend" }, "spend")).toBe(true);
  expect(hasCapability({ capability: "spend" }, "read")).toBe(true);
});

test("capability ladder: provision is the top rung, above spend", () => {
  // provision satisfies every lower rung...
  expect(hasCapability({ capability: "provision" }, "provision")).toBe(true);
  expect(hasCapability({ capability: "provision" }, "spend")).toBe(true);
  expect(hasCapability({ capability: "provision" }, "earn")).toBe(true);
  expect(hasCapability({ capability: "provision" }, "read")).toBe(true);
  // ...but spend does NOT satisfy provision — that's the whole point of S1.
  expect(hasCapability({ capability: "spend" }, "provision")).toBe(false);
  expect(hasCapability({ capability: "earn" }, "provision")).toBe(false);
  expect(hasCapability({ capability: "read" }, "provision")).toBe(false);
});

test("entity scope: null = any owned entity; scoped = only that entity", () => {
  expect(entityInScope({ entityId: null }, "ent-A")).toBe(true);
  expect(entityInScope({ entityId: "ent-A" }, "ent-A")).toBe(true);
  expect(entityInScope({ entityId: "ent-A" }, "ent-B")).toBe(false);
});
