import {
  type Address,
  type Hex,
  type PublicClient,
  isAddressEqual,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import { expect, test } from "vitest";
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

const CREATE = LEGAL_BODY_GRANTED_SELECTORS[0]!;
const SCHEDULE = LEGAL_BODY_GRANTED_SELECTORS[1]!;

/**
 * What the chain holds. The boot check is a security gate, so the double has to be able to tell
 * WHICH contract, account and selector it was asked about: a check that read the owner from the
 * wrong contract, asked about the wrong account, or read one pin twice must fail these tests.
 */
interface World {
  owner: Address;
  pendingOwner: Address;
  registry: Address;
  /** selector -> the contract it is pinned to on the controller. Absent = never pinned. */
  pins: ReadonlyMap<Hex, Address>;
  /** The (selector, account) grants the controller holds. */
  grants: readonly (readonly [selector: Hex, account: Address])[];
  /** Every read fails with this, as a dead RPC would. */
  down?: Error;
}

const grantKey = (role: string, account: string) =>
  `${role.toLowerCase()}:${account.toLowerCase()}`;

/**
 * A small chain with two contracts. The factory's reads answer only at the factory address and
 * the controller's only at the controller address; anything else throws, as a call to the wrong
 * contract would. Pins are looked up by selector and grants by (role, account).
 */
function chain(over: Partial<World> = {}): PublicClient {
  const world: World = {
    owner: CONTROLLER,
    pendingOwner: zeroAddress,
    registry: REGISTRY,
    pins: new Map(LEGAL_BODY_GRANTED_SELECTORS.map((s) => [s.selector, LB_FACTORY])),
    grants: LEGAL_BODY_GRANTED_SELECTORS.map((s) => [s.selector, EXECUTOR] as const),
    ...over,
  };
  const granted = new Set(
    world.grants.map(([selector, account]) => grantKey(selectorRole(selector), account)),
  );
  const readContract = async (call: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
  }) => {
    if (world.down) throw world.down;
    const args = call.args ?? [];
    if (isAddressEqual(call.address, LB_FACTORY))
      switch (call.functionName) {
        case "owner":
          return world.owner;
        case "pendingOwner":
          return world.pendingOwner;
        case "identityRegistry":
          return world.registry;
      }
    if (isAddressEqual(call.address, CONTROLLER))
      switch (call.functionName) {
        case "boundTarget":
          return world.pins.get((args[0] as string).toLowerCase() as Hex) ?? zeroAddress;
        case "hasRole":
          return granted.has(grantKey(args[0] as string, args[1] as string));
      }
    throw new Error(`no ${call.functionName}() at ${call.address}`);
  };
  return { readContract } as unknown as PublicClient;
}

const wiring = {
  factory: LB_FACTORY,
  controller: CONTROLLER,
  identityRegistry: REGISTRY,
  executor: EXECUTOR,
};

/** The message the boot check refuses with. Fails if it does not refuse. */
async function refusal(world: Partial<World>, p = wiring): Promise<string> {
  try {
    await assertLegalBodyFactoryWiring(chain(world), p);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the boot check to refuse, but it passed");
}

test("a fully wired legal-body factory verifies clean", async () => {
  await expect(assertLegalBodyFactoryWiring(chain(), wiring)).resolves.toBeUndefined();
});

test("a factory the controller does not own is refused, naming both env vars", async () => {
  expect(await refusal({ owner: OTHER })).toMatch(
    /LEGAL_BODY_FACTORY_ADDRESS.*owned by.*CONTROLLER_ADDRESS/s,
  );
});

test("a pending ownership handover is refused: the executor would lose its grants' target", async () => {
  expect(await refusal({ pendingOwner: OTHER })).toMatch(
    /ownership handover of LEGAL_BODY_FACTORY_ADDRESS.*pending/s,
  );
});

test("a factory bound to another identity registry is refused", async () => {
  expect(await refusal({ registry: OTHER })).toMatch(
    /LEGAL_BODY_FACTORY_ADDRESS.*identity registry.*IDENTITY_REGISTRY/s,
  );
});

test("a pin set on only the first selector is refused, and the message names only the second", async () => {
  const message = await refusal({ pins: new Map([[CREATE.selector, LB_FACTORY]]) });
  expect(message).toMatch(/not pinned to LEGAL_BODY_FACTORY_ADDRESS/);
  expect(message).toContain(SCHEDULE.name);
  expect(message).not.toContain(CREATE.name);
});

test("a pin set on only the second selector is refused, and the message names only the first", async () => {
  const message = await refusal({ pins: new Map([[SCHEDULE.selector, LB_FACTORY]]) });
  expect(message).toMatch(/not pinned to LEGAL_BODY_FACTORY_ADDRESS/);
  expect(message).toContain(CREATE.name);
  expect(message).not.toContain(SCHEDULE.name);
});

test("a selector pinned to another contract is refused and named", async () => {
  const message = await refusal({
    pins: new Map([
      [CREATE.selector, OTHER],
      [SCHEDULE.selector, LB_FACTORY],
    ]),
  });
  expect(message).toMatch(/not pinned to LEGAL_BODY_FACTORY_ADDRESS/);
  expect(message).toContain(CREATE.name);
  expect(message).not.toContain(SCHEDULE.name);
});

test("a missing executor grant is refused, naming only that selector and the key", async () => {
  const message = await refusal({ grants: [[CREATE.selector, EXECUTOR]] });
  expect(message).toMatch(/PLATFORM_PRIVATE_KEY.*is missing.*CONTROLLER_ADDRESS/s);
  expect(message).toContain(SCHEDULE.name);
  expect(message).not.toContain(CREATE.name);
});

test("grants held by another account are refused", async () => {
  // Whoever else holds them (a stranger, the factory, the controller itself), the executor does
  // not, and the executor is the account that sends the relayed calls.
  for (const holder of [OTHER, LB_FACTORY, CONTROLLER]) {
    const message = await refusal({
      grants: LEGAL_BODY_GRANTED_SELECTORS.map((s) => [s.selector, holder] as const),
    });
    expect(message).toMatch(/PLATFORM_PRIVATE_KEY.*is missing/s);
    expect(message).toContain(EXECUTOR);
    expect(message).toContain(CREATE.name);
    expect(message).toContain(SCHEDULE.name);
  }
});

test("the grants are read for the configured executor, whichever account that is", async () => {
  const grants = LEGAL_BODY_GRANTED_SELECTORS.map((s) => [s.selector, OTHER] as const);
  await expect(
    assertLegalBodyFactoryWiring(chain({ grants }), { ...wiring, executor: OTHER }),
  ).resolves.toBeUndefined();
});

test("an RPC failure is reported as 'could not verify', never as misconfiguration", async () => {
  expect(await refusal({ down: new Error("socket hang up") })).toMatch(/could not verify/);
});
