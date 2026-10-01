import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const CONTROLLER = "0x4819bd1e7f5f1e2b0e07a2e4f3d0b3e1c2a4f6e0";
const FACTORY = "0x1234567890AbcdEF1234567890aBcdef12345678";
const LB_FACTORY = "0x069f4adeabcbed3fffe2cb6aaf9e7a66e8731456";
const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/arc",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CONTROLLER_ADDRESS: CONTROLLER,
  FACTORY_ADDRESS: FACTORY,
};

test("LEGAL_BODY_FACTORY_ADDRESS parses to a checksummed address; absent stays undefined", () => {
  expect(loadConfig({ ...base, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY }).legalBodyFactory).toBe(
    "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456",
  );
  expect(loadConfig(base).legalBodyFactory).toBeUndefined();
});

test("a malformed LEGAL_BODY_FACTORY_ADDRESS is refused by name", () => {
  expect(() => loadConfig({ ...base, LEGAL_BODY_FACTORY_ADDRESS: "nope" })).toThrow(
    /LEGAL_BODY_FACTORY_ADDRESS/,
  );
});

test("the legal-body factory requires controller mode (its owner is the controller)", () => {
  const { CONTROLLER_ADDRESS: _c, ...legacy } = base;
  expect(() => loadConfig({ ...legacy, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY })).toThrow(
    /LEGAL_BODY_FACTORY_ADDRESS.*CONTROLLER_ADDRESS/s,
  );
});

test("the legal-body factory cannot be the full-product factory", () => {
  expect(() => loadConfig({ ...base, LEGAL_BODY_FACTORY_ADDRESS: FACTORY })).toThrow(
    /LEGAL_BODY_FACTORY_ADDRESS.*FACTORY_ADDRESS/s,
  );
});
