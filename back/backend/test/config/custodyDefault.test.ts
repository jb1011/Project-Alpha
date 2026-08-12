import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";
import { CIRCLE_FULL_ENV, TURNKEY_CORE_ENV, TURNKEY_FULL_ENV } from "../helpers/prodEnv";

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

test("prod + implicit turnkey default + no turnkey config → refuses to boot", () => {
  expect(() => loadConfig(prodBase)).toThrow(/WALLET_PROVIDER_DEFAULT=turnkey/);
});

test("prod + turnkey default + core config but NO delegated keypair → refuses to boot (provisioning needs it)", () => {
  expect(() => loadConfig({ ...prodBase, ...TURNKEY_CORE_ENV })).toThrow(
    /WALLET_PROVIDER_DEFAULT=turnkey/,
  );
});

test("prod + turnkey default + full turnkey config → boots", () => {
  expect(loadConfig({ ...prodBase, ...TURNKEY_FULL_ENV }).walletProviderDefault).toBe("turnkey");
});

test("prod circle-only (the mainnet shape): default=circle, no turnkey → boots", () => {
  const cfg = loadConfig({ ...prodBase, ...CIRCLE_FULL_ENV, WALLET_PROVIDER_DEFAULT: "circle" });
  expect(cfg.walletProviderDefault).toBe("circle");
  expect(cfg.turnkey).toBeUndefined();
});

test("non-production still boots bare (dev/CI, no credentials at all)", () => {
  const { NODE_ENV: _n, ...devBase } = prodBase;
  const cfg = loadConfig(devBase);
  expect(cfg.walletProviderDefault).toBe("turnkey");
  expect(cfg.turnkey).toBeUndefined();
});
