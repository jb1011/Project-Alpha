import { expect, test } from "vitest";
import { loadConfig, redact } from "../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.testnet.arc.network",
  ARC_CHAIN_ID: "5042002",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  GUARDIAN_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  FACTORY_ADDRESS: "0x00000000000000000000000000000000000F4c70",
  DATA_DIR: "./data",
};

test("loadConfig parses valid env with defaults", () => {
  const cfg = loadConfig(base);
  expect(cfg.chainId).toBe(5042002);
  expect(cfg.identityRegistry).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
  expect(cfg.usdc).toBe("0x3600000000000000000000000000000000000000");
  expect(cfg.platformPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
});

test("loadConfig rejects a malformed private key", () => {
  expect(() => loadConfig({ ...base, PLATFORM_PRIVATE_KEY: "nope" })).toThrow(
    /PLATFORM_PRIVATE_KEY/,
  );
});

test("redact never reveals secret material", () => {
  const cfg = loadConfig(base);
  const printed = JSON.stringify(redact(cfg));
  expect(printed).not.toContain("1".repeat(64));
  expect(printed).toContain("REDACTED");
});

// --- production fail-closed guard ---

const prodBase = {
  ARC_TESTNET_RPC_URL: "https://rpc.testnet.arc.network",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
  NODE_ENV: "production",
};

test("production + default AUTH_JWT_SECRET throws", () => {
  // WEB_ORIGIN left as default "*" and AUTH_JWT_SECRET not provided → must throw
  expect(() => loadConfig(prodBase)).toThrow(
    /AUTH_JWT_SECRET must be set to a real secret in production/,
  );
});

test("production + real secret + explicit WEB_ORIGIN does not throw", () => {
  expect(() =>
    loadConfig({
      ...prodBase,
      AUTH_JWT_SECRET: "a-real-secret-that-is-long-enough-for-prod",
      WEB_ORIGIN: "https://app.example.com",
      METADATA_BASE_URL: "https://app.example.com",
    }),
  ).not.toThrow();
});

test("non-production with dev defaults does not throw", () => {
  // No NODE_ENV → not production → guard is inactive
  const { NODE_ENV: _omit, ...nonProd } = prodBase;
  expect(() => loadConfig(nonProd)).not.toThrow();
});
