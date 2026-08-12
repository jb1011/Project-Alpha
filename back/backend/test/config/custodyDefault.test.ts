import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

/** Production boot invariant for the DEFAULT custody provider (mirror of the existing circle-side
 *  check): a prod deployment whose default is `turnkey` but that cannot provision Turnkey vaults
 *  would 500 every default onboard at runtime — refuse at boot instead. Non-production keeps
 *  booting credential-less (the schema default is `turnkey` precisely so dev/CI boot bare). */

// Passes loadConfig + the existing prod guards (JWT/WEB_ORIGIN/METADATA_BASE_URL), isolating the
// custody-default check.
const prodBase = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/arc",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  AUTH_JWT_SECRET: "a-real-production-secret-1234",
  WEB_ORIGIN: "https://app.example.com",
  METADATA_BASE_URL: "https://api.example.com/backend",
  NODE_ENV: "production",
};

const TURNKEY_CORE = {
  TURNKEY_API_PUBLIC_KEY: "pub",
  TURNKEY_API_PRIVATE_KEY: "priv",
  TURNKEY_ORGANIZATION_ID: "org",
  TURNKEY_SIGN_WITH: "0xabc",
};

const TURNKEY_FULL = {
  ...TURNKEY_CORE,
  TURNKEY_DELEGATED_API_PUBLIC_KEY: "dpub",
  TURNKEY_DELEGATED_API_PRIVATE_KEY: "dpriv",
};

const CIRCLE_FULL = {
  CIRCLE_API_KEY: "ck_test",
  CIRCLE_ENTITY_SECRET: "es_test",
  CIRCLE_WALLET_SET_ID: "ws_test",
};

test("prod + implicit turnkey default + no turnkey config → refuses to boot", () => {
  expect(() => loadConfig(prodBase)).toThrow(/WALLET_PROVIDER_DEFAULT=turnkey/);
});

test("prod + turnkey default + core config but NO delegated keypair → refuses to boot (provisioning needs it)", () => {
  expect(() => loadConfig({ ...prodBase, ...TURNKEY_CORE })).toThrow(
    /WALLET_PROVIDER_DEFAULT=turnkey/,
  );
});

test("prod + turnkey default + full turnkey config → boots", () => {
  expect(loadConfig({ ...prodBase, ...TURNKEY_FULL }).walletProviderDefault).toBe("turnkey");
});

test("prod circle-only (the mainnet shape): default=circle, no turnkey → boots", () => {
  const cfg = loadConfig({ ...prodBase, ...CIRCLE_FULL, WALLET_PROVIDER_DEFAULT: "circle" });
  expect(cfg.walletProviderDefault).toBe("circle");
  expect(cfg.turnkey).toBeUndefined();
});

test("non-production still boots bare (dev/CI, no credentials at all)", () => {
  const { NODE_ENV: _n, ...devBase } = prodBase;
  const cfg = loadConfig(devBase);
  expect(cfg.walletProviderDefault).toBe("turnkey");
  expect(cfg.turnkey).toBeUndefined();
});
