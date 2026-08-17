/**
 * NoviController config decoupling (design §5): the manager ADDRESS stops being derived from the
 * signing KEY. `CONTROLLER_ADDRESS` set => the platform manager identity is the controller contract
 * and the signing key is only the executor (tx sender). Unset => legacy behavior, unchanged.
 */
import { expect, test } from "vitest";
import { managerAccount, platformManagerAddress } from "../../src/adapters/arc/clients";
import { loadConfig, redact } from "../../src/config/env";

const CONTROLLER = "0x4819bd1e7f5f1e2b0e07a2e4f3d0b3e1c2a4f6e0";
const FACTORY = "0x1234567890AbcdEF1234567890aBcdef12345678";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/arc",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

test("CONTROLLER_ADDRESS parses to a checksummed Address; absent stays undefined", () => {
  const cfg = loadConfig({ ...base, CONTROLLER_ADDRESS: CONTROLLER, FACTORY_ADDRESS: FACTORY });
  expect(cfg.controllerAddress).toBe("0x4819bd1e7f5F1e2b0e07A2E4f3d0B3E1C2A4f6e0");
  expect(loadConfig(base).controllerAddress).toBeUndefined();
});

test("a malformed CONTROLLER_ADDRESS is refused at boot, by name", () => {
  expect(() =>
    loadConfig({ ...base, CONTROLLER_ADDRESS: "not-an-address", FACTORY_ADDRESS: FACTORY }),
  ).toThrow(/CONTROLLER_ADDRESS/);
});

test("boot invariant: CONTROLLER_ADDRESS without an explicit FACTORY_ADDRESS refuses to boot", () => {
  // Controller mode is only meaningful against the NEW factory whose owner IS the controller; that
  // cannot be checked on-chain at boot, so the enforceable form is "name the factory explicitly".
  expect(() => loadConfig({ ...base, CONTROLLER_ADDRESS: CONTROLLER })).toThrow(
    /CONTROLLER_ADDRESS.*FACTORY_ADDRESS/s,
  );
});

test("boot invariant is one-way: FACTORY_ADDRESS without a controller still boots (legacy)", () => {
  const cfg = loadConfig({ ...base, FACTORY_ADDRESS: FACTORY });
  expect(cfg.factoryAddress).toBe("0x1234567890AbcdEF1234567890aBcdef12345678");
  expect(cfg.controllerAddress).toBeUndefined();
});

test("platform manager identity: the controller in controller mode, the signing key otherwise", () => {
  const legacy = loadConfig(base);
  expect(platformManagerAddress(legacy)).toBe(managerAccount(legacy).address);

  const controlled = loadConfig({
    ...base,
    CONTROLLER_ADDRESS: CONTROLLER,
    FACTORY_ADDRESS: FACTORY,
  });
  expect(platformManagerAddress(controlled)).toBe(controlled.controllerAddress);
  // The signing key is untouched — it is now the EXECUTOR, not the manager identity.
  expect(managerAccount(controlled).address).toBe(managerAccount(legacy).address);
  expect(platformManagerAddress(controlled)).not.toBe(managerAccount(controlled).address);
});

test("ENS_APEX_RESOLVES_TO is an explicit, optional address (never inferred from the controller)", () => {
  const apex = "0x00000000000000000000000000000000000000A1";
  expect(loadConfig({ ...base, ENS_APEX_RESOLVES_TO: apex }).ensApexResolvesTo).toBe(apex);
  expect(loadConfig(base).ensApexResolvesTo).toBeUndefined();
});

test("redact() leaves the controller address visible — it is an address, not a secret", () => {
  const cfg = loadConfig({ ...base, CONTROLLER_ADDRESS: CONTROLLER, FACTORY_ADDRESS: FACTORY });
  const safe = redact(cfg);
  expect(safe.controllerAddress).toBe(cfg.controllerAddress);
  expect(safe.platformPrivateKey).toBe("REDACTED"); // the key it decouples from is still redacted
});
