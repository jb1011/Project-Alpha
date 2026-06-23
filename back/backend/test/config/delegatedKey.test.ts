// backend/test/config/delegatedKey.test.ts
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  TURNKEY_API_PUBLIC_KEY: "pub",
  TURNKEY_API_PRIVATE_KEY: "priv",
  TURNKEY_ORGANIZATION_ID: "org",
  TURNKEY_SIGN_WITH: "0xabc",
  TURNKEY_DELEGATED_API_PUBLIC_KEY: "dpub",
  TURNKEY_DELEGATED_API_PRIVATE_KEY: "dpriv",
};

test("delegated API keypair is parsed into cfg.turnkey", () => {
  const cfg = loadConfig(base);
  expect(cfg.turnkey?.delegatedApiPublicKey).toBe("dpub");
  expect(cfg.turnkey?.delegatedApiPrivateKey).toBe("dpriv");
});

test("the delegated private key is redacted", () => {
  const cfg = loadConfig(base);
  const turnkey = redact(cfg).turnkey as Record<string, unknown>;
  expect(turnkey?.delegatedApiPrivateKey).toBe("REDACTED");
});
