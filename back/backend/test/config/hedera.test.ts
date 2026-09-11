import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const BASE = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s".repeat(16),
  ARC_TESTNET_RPC_URL: "http://localhost:8545",
};
const ON = {
  ...BASE,
  HEDERA_ENABLED: "1",
  HEDERA_NETWORK: "testnet",
  HEDERA_FACILITATOR_URL: "https://api.testnet.blocky402.com",
  HEDERA_MIRROR_URL: "https://testnet.mirrornode.hedera.com",
  HEDERA_USDC_TOKEN_ID: "0.0.429274",
  HEDERA_PAYTO_ACCOUNT_ID: "0.0.10412694",
};

test("flag off -> cfg.hedera undefined, other config unchanged", () => {
  expect(loadConfig(BASE).hedera).toBeUndefined();
});
test("flag on and whole -> block with 1000n atomic default price", () => {
  const h = loadConfig(ON).hedera;
  expect(h?.network).toBe("testnet");
  expect(h?.verifyPriceAtomic).toBe(1000n);
  expect(h?.payToAccountId).toBe("0.0.10412694");
});
test("flag on and partial -> refuses to boot naming the missing var", () => {
  const { HEDERA_PAYTO_ACCOUNT_ID: _omit, ...partial } = ON;
  expect(() => loadConfig(partial)).toThrow(/HEDERA_PAYTO_ACCOUNT_ID/);
});
test("HEDERA_NETWORK other than testnet refuses", () => {
  expect(() => loadConfig({ ...ON, HEDERA_NETWORK: "mainnet" })).toThrow(/testnet/);
});
test("attestation key equal to the platform key refuses; redacted otherwise", () => {
  expect(() => loadConfig({ ...ON, NOVI_ATTESTATION_KEY: BASE.PLATFORM_PRIVATE_KEY })).toThrow(
    /NOVI_ATTESTATION_KEY/,
  );
  const cfg = loadConfig({ ...ON, NOVI_ATTESTATION_KEY: `0x${"3".repeat(64)}` });
  expect((redact(cfg).hedera as { attestationKey?: string }).attestationKey).toBe("REDACTED");
});
