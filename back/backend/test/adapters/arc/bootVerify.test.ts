/**
 * Boot-time on-chain verification (NoviController design §5/§7).
 *
 * Two properties matter here:
 *  1. the SEVEN granted selectors are derived from the generated ABIs and match, name for name,
 *     the Solidity library the deploy script and the Foundry suites share
 *     (src/libraries/ControllerSelectors.sol). A selector added on one side only would make the
 *     tests pass against a grant set mainnet does not deploy;
 *  2. every wiring mismatch throws NAMING the failing check and the env vars involved, and a plain
 *     RPC outage is reported as "could not verify", never as a misconfiguration.
 */
import { type Address, type PublicClient, toFunctionSelector } from "viem";
import { expect, test, vi } from "vitest";
import {
  CONTROLLER_GRANTED_SELECTORS,
  CONTROLLER_PINNED_SELECTORS,
  assertControllerWiring,
  assertLegacyFactoryOwner,
  selectorRole,
} from "../../../src/adapters/arc/bootVerify";

const CONTROLLER = "0x4819bd1e7f5F1e2b0e07A2E4f3d0B3E1C2A4f6e0" as Address;
const FACTORY = "0x1234567890AbcdEF1234567890aBcdef12345678" as Address;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const EXECUTOR = "0x000000000000000000000000000000000000000b" as Address;
const OTHER = "0x00000000000000000000000000000000000000ff" as Address;

/**
 * The design §3 grant set, pinned as canonical SIGNATURES. This is the TS-side mirror of
 * ControllerSelectors.granted(); if either side gains, loses or renames an entry, this goes red.
 */
const EXPECTED = [
  ["AgentTreasury.schedulePolicyUpdate", "schedulePolicyUpdate(uint256,uint256,bool,address)"],
  ["AgentTreasury.executePolicyUpdate", "executePolicyUpdate(bytes32)"],
  ["LegalManager.scheduleOperatingAgreementUpdate", "scheduleOperatingAgreementUpdate(bytes32)"],
  ["LegalManager.executeOperatingAgreementUpdate", "executeOperatingAgreementUpdate(bytes32)"],
  [
    "LegalManagerFactory.createEntity",
    "createEntity(address,address,address,uint256,string,string,uint64,bytes32,(address,address,uint256,uint256,bool))",
  ],
  ["IdentityRegistry.setAgentWallet", "setAgentWallet(uint256,address,uint256,bytes)"],
  ["IdentityRegistry.setMetadata", "setMetadata(uint256,string,bytes)"],
] as const;

test("the derived grant set is EXACTLY the seven of design §3, by name and by selector", () => {
  expect(CONTROLLER_GRANTED_SELECTORS).toHaveLength(7);
  expect(CONTROLLER_GRANTED_SELECTORS.map((s) => s.name)).toEqual(EXPECTED.map(([n]) => n));
  for (const [i, [, signature]] of EXPECTED.entries())
    expect(CONTROLLER_GRANTED_SELECTORS[i]!.selector).toBe(toFunctionSelector(signature));
});

test("selectors are distinct, 4 bytes, and never the zero selector (the M1 partition)", () => {
  const seen = new Set<string>();
  for (const { selector } of CONTROLLER_GRANTED_SELECTORS) {
    expect(selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(selector).not.toBe("0x00000000"); // bytes32(bytes4(0)) IS DEFAULT_ADMIN_ROLE
    expect(seen.has(selector)).toBe(false);
    seen.add(selector);
  }
});

test("the M5 pin set is the two registry selectors", () => {
  expect(CONTROLLER_PINNED_SELECTORS.map((s) => s.name)).toEqual([
    "IdentityRegistry.setAgentWallet",
    "IdentityRegistry.setMetadata",
  ]);
});

test("role id = the selector LEFT-aligned in bytes32 (Euler shape, disjoint from admin/wildcard)", () => {
  expect(selectorRole("0xdeadbeef")).toBe(`0xdeadbeef${"0".repeat(56)}`);
  expect(selectorRole("0xdeadbeef")).not.toBe(`0x${"0".repeat(64)}`); // DEFAULT_ADMIN_ROLE
  expect(selectorRole("0xdeadbeef")).not.toBe(`0x${"0".repeat(63)}1`); // WILDCARD_ROLE
});

// ── the wiring checks ────────────────────────────────────────────────────

/** A publicClient answering owner()/hasRole()/boundTarget() from a scripted world. */
function client(world: {
  factoryOwner?: Address;
  grants?: boolean | boolean[];
  pins?: Address | (Address | undefined)[];
  throws?: Error;
}) {
  let grantIdx = 0;
  let pinIdx = 0;
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (world.throws) throw world.throws;
    if (functionName === "owner") return world.factoryOwner ?? CONTROLLER;
    if (functionName === "hasRole")
      return Array.isArray(world.grants) ? world.grants[grantIdx++] : (world.grants ?? true);
    if (functionName === "boundTarget")
      return Array.isArray(world.pins) ? world.pins[pinIdx++] : (world.pins ?? REGISTRY);
    throw new Error(`unexpected read ${functionName}`);
  });
  return { readContract } as unknown as PublicClient;
}

const wiring = {
  controller: CONTROLLER,
  factory: FACTORY,
  identityRegistry: REGISTRY,
  executor: EXECUTOR,
};

test("a fully-wired controller deployment verifies clean", async () => {
  await expect(assertControllerWiring(client({}), wiring)).resolves.toBeUndefined();
});

test("a factory the controller does not own is named, with both env vars", async () => {
  await expect(assertControllerWiring(client({ factoryOwner: OTHER }), wiring)).rejects.toThrow(
    /FACTORY_ADDRESS.*is owned by.*not by CONTROLLER_ADDRESS/s,
  );
});

test("a pending (unaccepted) ownership handover is called out explicitly", async () => {
  await expect(assertControllerWiring(client({ factoryOwner: OTHER }), wiring)).rejects.toThrow(
    /acceptOwnership ceremony has not completed/,
  );
});

test("a missing executor grant names the selector AND the key it belongs to", async () => {
  const grants = CONTROLLER_GRANTED_SELECTORS.map((_, i) => i !== 4); // createEntity revoked
  await expect(assertControllerWiring(client({ grants }), wiring)).rejects.toThrow(
    /missing 1 of 7 selector grants.*LegalManagerFactory\.createEntity.*PLATFORM_PRIVATE_KEY/s,
  );
});

test("an unpinned registry selector (M5) refuses the boot and says why it matters", async () => {
  await expect(
    assertControllerWiring(client({ pins: [REGISTRY, undefined] }), wiring),
  ).rejects.toThrow(/M5 target pins.*setMetadata.*may be relayed at any contract/s);
});

test("a pin aimed at the WRONG contract is refused too", async () => {
  await expect(assertControllerWiring(client({ pins: OTHER }), wiring)).rejects.toThrow(
    /do not point at IDENTITY_REGISTRY/,
  );
});

test("an RPC outage reads as 'could not verify', never as a misconfiguration", async () => {
  const outage = new Error("socket hang up");
  const err = await assertControllerWiring(client({ throws: outage }), wiring).catch((e) => e);
  expect(err.message).toMatch(/could not verify.*RPC read failed/s);
  expect(err.message).not.toMatch(/is owned by|missing .* selector grants/);
  expect(err.cause).toBe(outage);
});

// ── legacy mode ──────────────────────────────────────────────────────────

test("legacy mode: the signing key must still own the factory", async () => {
  await expect(
    assertLegacyFactoryOwner(client({ factoryOwner: EXECUTOR }), {
      factory: FACTORY,
      signer: EXECUTOR,
    }),
  ).resolves.toBeUndefined();
});

test("legacy mode: a controller-owned factory with no CONTROLLER_ADDRESS is caught by name", async () => {
  await expect(
    assertLegacyFactoryOwner(client({ factoryOwner: CONTROLLER }), {
      factory: FACTORY,
      signer: EXECUTOR,
    }),
  ).rejects.toThrow(/factory owner is not the signing key; is CONTROLLER_ADDRESS missing\?/);
});

test("legacy mode: an RPC outage is also reported as unverifiable, not as wrong ownership", async () => {
  await expect(
    assertLegacyFactoryOwner(client({ throws: new Error("ETIMEDOUT") }), {
      factory: FACTORY,
      signer: EXECUTOR,
    }),
  ).rejects.toThrow(/could not verify the factory owner/);
});
