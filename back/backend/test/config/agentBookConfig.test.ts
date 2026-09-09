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
/** What the production block's OWN guards need, so the only thing a prod load can fail on here is
 *  the AgentBook invariant. */
const PROD = {
  NODE_ENV: "production",
  AUTH_JWT_SECRET: "a-real-secret-at-least-16",
  WEB_ORIGIN: "https://app.example",
  METADATA_BASE_URL: "https://api.example",
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

test("the submitter key may never equal another key material var either", () => {
  expect(() =>
    loadConfig({
      ...BASE,
      ...WORLD,
      ENS_GATEWAY_SIGNER_KEY: KEY,
      WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY,
    }),
  ).toThrow(/WORLDCHAIN_SUBMITTER_PRIVATE_KEY must not equal ENS_GATEWAY_SIGNER_KEY/);
});

// Half-configured in production is worse than absent: the key sits funded while the surface it
// pays for stays unmounted. Everywhere else the same shape is a legitimate work-in-progress.
test("production refuses a submitter key with no World portal block", () => {
  expect(() => loadConfig({ ...BASE, ...PROD, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY })).toThrow(
    /WORLD_\*|portal/,
  );
});

test("redact replaces the whole agentBook block", () => {
  const cfg = loadConfig({ ...BASE, ...WORLD, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY });
  expect(JSON.stringify(redact(cfg))).not.toContain(KEY);
  expect(redact(cfg).agentBook).toEqual({ submitterPrivateKey: "REDACTED", rpcUrl: "REDACTED" });
});

// A dedicated write endpoint is normally an Alchemy/Infura URL with the API key in the path — the
// same bearer-credential shape as `alertWebhookUrl`, so it is redacted like one.
test("redact hides a dedicated write RPC's embedded credential", () => {
  const cfg = loadConfig({
    ...BASE,
    ...WORLD,
    WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY,
    WORLDCHAIN_SUBMITTER_RPC: "https://paid.example/v2/sekrit-key-123",
  });
  expect(JSON.stringify(redact(cfg))).not.toContain("sekrit-key-123");
  expect(redact(cfg).agentBook).toEqual({ submitterPrivateKey: "REDACTED", rpcUrl: "REDACTED" });
});

// With no dedicated write RPC the submitter writes through WORLD_CHAIN_RPC, so redacting only the
// write endpoint would leak the same credential from `worldChain` — where it is a paid endpoint
// just as often, because .env.example tells operators to replace the shared public default. The
// ORIGIN survives (removed-behaviour F3): the API key lives in the path, and an operator
// diagnosing "the chip says could not check" has to be able to see which endpoint the box resolved
// to. The write endpoint stays fully redacted — it is the one that travels with the key.
test("redact keeps the read RPC's host and drops its embedded credential", () => {
  const cfg = loadConfig({
    ...BASE,
    ...WORLD,
    WORLD_CHAIN_RPC: "https://paid.example/v2/read-sekrit-456",
    WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY,
  });
  expect(cfg.agentBook?.rpcUrl).toBe("https://paid.example/v2/read-sekrit-456");
  expect(JSON.stringify(redact(cfg))).not.toContain("read-sekrit-456");
  expect(redact(cfg).worldChain).toMatchObject({ rpcUrl: "https://paid.example" });
  expect(redact(cfg).agentBook).toEqual({ submitterPrivateKey: "REDACTED", rpcUrl: "REDACTED" });
});

// The schema refuses a malformed WORLD_CHAIN_RPC at boot, so this can only be reached by handing
// `redact` a config built in code — which is exactly when a printed guess would be worst.
test("a read RPC that is not a parseable URL is redacted whole rather than printed", () => {
  const cfg = loadConfig({ ...BASE, ...WORLD });
  const broken = { ...cfg, worldChain: { ...cfg.worldChain!, rpcUrl: "not a url" } };
  expect(redact(broken).worldChain).toMatchObject({ rpcUrl: "REDACTED" });
});
