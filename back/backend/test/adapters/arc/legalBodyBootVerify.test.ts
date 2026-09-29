import { type Address, type PublicClient, toFunctionSelector, zeroAddress } from "viem";
import { expect, test, vi } from "vitest";
import {
  CONTROLLER_GRANTED_SELECTORS,
  LEGAL_BODY_GRANTED_SELECTORS,
  assertLegalBodyFactoryWiring,
  selectorRole,
} from "../../../src/adapters/arc/bootVerify";
import { standingRoles } from "../../../src/monitor/events";

const CONTROLLER = "0x9526E228E94A125843B2d010c1155780CBBAFb5c" as Address;
const LB_FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as Address;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const EXECUTOR = "0x000000000000000000000000000000000000000b" as Address;
const OTHER = "0x00000000000000000000000000000000000000ff" as Address;

test("the legal-body grant set is exactly the factory's two relayed functions, in order", () => {
  expect(LEGAL_BODY_GRANTED_SELECTORS.map((s) => s.name)).toEqual([
    "LegalBodyFactory.createLegalBody",
    "LegalBodyFactory.scheduleOperatingAgreementUpdate",
  ]);
  expect(LEGAL_BODY_GRANTED_SELECTORS[0]!.selector).toBe(
    toFunctionSelector("createLegalBody(uint256,address,uint256,bytes32,uint256,bytes)"),
  );
  expect(LEGAL_BODY_GRANTED_SELECTORS[1]!.selector).toBe(
    toFunctionSelector("scheduleOperatingAgreementUpdate(address,bytes32,uint256,bytes)"),
  );
});

test("no legal-body selector collides with a standing controller grant", () => {
  const standing = new Set(CONTROLLER_GRANTED_SELECTORS.map((s) => s.selector));
  for (const s of LEGAL_BODY_GRANTED_SELECTORS) expect(standing.has(s.selector)).toBe(false);
});

test("the monitor treats the two legal-body grants as standing roles (WARN, not CRITICAL)", () => {
  const roles = standingRoles();
  expect(roles.size).toBe(
    CONTROLLER_GRANTED_SELECTORS.length + LEGAL_BODY_GRANTED_SELECTORS.length,
  );
  for (const s of LEGAL_BODY_GRANTED_SELECTORS)
    expect(roles.has(selectorRole(s.selector).toLowerCase() as `0x${string}`)).toBe(true);
});

/** A client answering the factory's and the controller's reads from a scripted world. */
function client(world: {
  owner?: Address;
  pendingOwner?: Address;
  registry?: Address;
  pins?: (Address | undefined)[];
  grants?: boolean[];
  throws?: Error;
}) {
  let pin = 0;
  let grant = 0;
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (world.throws) throw world.throws;
    switch (functionName) {
      case "owner":
        return world.owner ?? CONTROLLER;
      case "pendingOwner":
        return world.pendingOwner ?? zeroAddress;
      case "identityRegistry":
        return world.registry ?? REGISTRY;
      case "boundTarget":
        return world.pins ? world.pins[pin++] : LB_FACTORY;
      case "hasRole":
        return world.grants ? world.grants[grant++] : true;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  });
  return { readContract } as unknown as PublicClient;
}
const wiring = {
  factory: LB_FACTORY,
  controller: CONTROLLER,
  identityRegistry: REGISTRY,
  executor: EXECUTOR,
};

test("a fully wired legal-body factory verifies clean", async () => {
  await expect(assertLegalBodyFactoryWiring(client({}), wiring)).resolves.toBeUndefined();
});

test("a factory the controller does not own is refused, naming both env vars", async () => {
  await expect(assertLegalBodyFactoryWiring(client({ owner: OTHER }), wiring)).rejects.toThrow(
    /LEGAL_BODY_FACTORY_ADDRESS.*owned by.*CONTROLLER_ADDRESS/s,
  );
});

test("a pending ownership handover is refused: the executor would lose its grants' target", async () => {
  await expect(
    assertLegalBodyFactoryWiring(client({ pendingOwner: OTHER }), wiring),
  ).rejects.toThrow(/ownership handover.*pending/s);
});

test("a factory bound to another identity registry is refused", async () => {
  await expect(assertLegalBodyFactoryWiring(client({ registry: OTHER }), wiring)).rejects.toThrow(
    /identity registry.*IDENTITY_REGISTRY/s,
  );
});

test("an unpinned or mis-pinned legal-body selector is refused and named", async () => {
  await expect(
    assertLegalBodyFactoryWiring(client({ pins: [LB_FACTORY, zeroAddress] }), wiring),
  ).rejects.toThrow(/scheduleOperatingAgreementUpdate.*pinned/s);
  await expect(
    assertLegalBodyFactoryWiring(client({ pins: [OTHER, LB_FACTORY] }), wiring),
  ).rejects.toThrow(/createLegalBody.*pinned/s);
});

test("a missing executor grant is refused, naming the selector and the key", async () => {
  await expect(
    assertLegalBodyFactoryWiring(client({ grants: [true, false] }), wiring),
  ).rejects.toThrow(/PLATFORM_PRIVATE_KEY.*scheduleOperatingAgreementUpdate/s);
});

test("an RPC failure is reported as 'could not verify', never as misconfiguration", async () => {
  await expect(
    assertLegalBodyFactoryWiring(client({ throws: new Error("socket hang up") }), wiring),
  ).rejects.toThrow(/could not verify/);
});
