import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

// Minimal env that passes loadConfig + the existing prod guards (JWT/WEB_ORIGIN), so we isolate the
// METADATA_BASE_URL check.
const baseEnv = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/arc",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  AUTH_JWT_SECRET: "a-real-production-secret-1234",
  WEB_ORIGIN: "https://app.example.com",
};

test("metadataBaseUrl defaults + is exposed on config (non-prod)", () => {
  expect(loadConfig({ ...baseEnv }).metadataBaseUrl).toBe("http://localhost:8789");
});

test("prod rejects a loopback METADATA_BASE_URL", () => {
  expect(() =>
    loadConfig({ ...baseEnv, NODE_ENV: "production", METADATA_BASE_URL: "http://localhost:8789" }),
  ).toThrow(/METADATA_BASE_URL/);
});

test("prod rejects a non-https METADATA_BASE_URL", () => {
  expect(() =>
    loadConfig({
      ...baseEnv,
      NODE_ENV: "production",
      METADATA_BASE_URL: "http://api.example.com/backend",
    }),
  ).toThrow(/METADATA_BASE_URL/);
});

test("prod accepts a real https METADATA_BASE_URL", () => {
  const cfg = loadConfig({
    ...baseEnv,
    NODE_ENV: "production",
    METADATA_BASE_URL: "https://project-alpha-pi.vercel.app/backend",
  });
  expect(cfg.metadataBaseUrl).toBe("https://project-alpha-pi.vercel.app/backend");
});
