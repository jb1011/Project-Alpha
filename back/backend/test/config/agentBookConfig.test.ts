/**
 * AgentBook registration config (design 2026-08-25 v3 §4.2-4.3): the dedicated submitter key, the
 * optional write RPC, the `canRegisterAgentBook` predicate, the key-reuse invariant and redaction.
 * The submitter holds World Chain ETH only — reusing another key would fund a platform signer on a
 * chain it was never meant to touch, so boot refuses it.
 */
import { expect, test } from "vitest";
import { canRegisterAgentBook, loadConfig, redact } from "../../src/config/env";

const KEY = `0x${"b".repeat(64)}`;
const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};
const WORLD = {
  WORLD_APP_ID: "app_staging_1",
  WORLD_RP_ID: "app.example",
  WORLD_RP_SIGNING_KEY: "0xsigning",
};

test("absent key: no agentBook block, registration unavailable", () => {
  const cfg = loadConfig(BASE);
  expect(cfg.agentBook).toBeUndefined();
  expect(canRegisterAgentBook(cfg)).toBe(false);
});

test("key without World portal config: block present, registration still unavailable", () => {
  const cfg = loadConfig({ ...BASE, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY });
  expect(cfg.agentBook?.submitterPrivateKey).toBe(KEY);
  expect(canRegisterAgentBook(cfg)).toBe(false);
});

test("key plus World config: available; write RPC defaults to the read RPC", () => {
  const cfg = loadConfig({ ...BASE, ...WORLD, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY });
  expect(canRegisterAgentBook(cfg)).toBe(true);
  expect(cfg.agentBook?.rpcUrl).toBe(cfg.worldChain?.rpcUrl);
});

test("a dedicated write RPC is honoured", () => {
  const cfg = loadConfig({
    ...BASE,
    ...WORLD,
    WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY,
    WORLDCHAIN_SUBMITTER_RPC: "https://paid.example/v2/key",
  });
  expect(cfg.agentBook?.rpcUrl).toBe("https://paid.example/v2/key");
});

test("the submitter key may never equal the platform key", () => {
  expect(() =>
    loadConfig({ ...BASE, ...WORLD, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: BASE.PLATFORM_PRIVATE_KEY }),
  ).toThrow(/WORLDCHAIN_SUBMITTER_PRIVATE_KEY/);
});

test("redact hides the key and keeps the RPC", () => {
  const cfg = loadConfig({ ...BASE, ...WORLD, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY });
  const out = JSON.stringify(redact(cfg));
  expect(out).not.toContain(KEY);
  expect(out).toContain('"rpcUrl"');
});
