import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

test("circle block is all-or-nothing: only one of key/secret set -> boot refuses", () => {
  expect(() => loadConfig({ ...BASE, CIRCLE_API_KEY: "ck_test" })).toThrow(/CIRCLE_ENTITY_SECRET/);
  expect(() => loadConfig({ ...BASE, CIRCLE_ENTITY_SECRET: "es_test" })).toThrow(/CIRCLE_API_KEY/);
});

test("both set -> cfg.circle present; neither -> absent (feature off, no error)", () => {
  const on = loadConfig({ ...BASE, CIRCLE_API_KEY: "ck_test", CIRCLE_ENTITY_SECRET: "es_test" });
  expect(on.circle).toEqual({ apiKey: "ck_test", entitySecret: "es_test" });
  expect(loadConfig(BASE).circle).toBeUndefined();
});

test("the entity secret NEVER survives redact() — env.ts's own header rule", () => {
  const cfg = loadConfig({
    ...BASE,
    CIRCLE_API_KEY: "ck_test",
    CIRCLE_ENTITY_SECRET: "es_SUPER_SECRET",
  });
  const printed = JSON.stringify(redact(cfg));
  expect(printed).not.toContain("es_SUPER_SECRET");
  expect(printed).not.toContain("ck_test"); // the API key is a secret too
});
