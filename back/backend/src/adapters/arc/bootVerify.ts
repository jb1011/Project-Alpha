import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  getAbiItem,
  isAddressEqual,
  pad,
  toFunctionSelector,
} from "viem";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalManagerAbi,
  legalManagerFactoryAbi,
  noviControllerAbi,
} from "../../abis/generated";

/**
 * Boot-time verification that the CHAIN agrees with the env (NoviController design §5/§7).
 *
 * `loadConfig` stays pure — it can only check that the env vars are internally consistent, which
 * catches a missing variable and nothing else. The mistakes that actually hurt are relational and
 * live on-chain: pointing at a factory the controller does not own, flipping the factory but
 * forgetting the controller, a deploy whose `acceptOwnership` ceremony never completed, an executor
 * key rotated without re-granting, a pin that was never set. Every one of those boots green today
 * and fails at the FIRST ONBOARDING, in front of a user, as an opaque `OwnableUnauthorizedAccount`
 * or `NotManager`. These checks move that to the boot log, named.
 *
 * Chain I/O belongs here (api/main.ts already has a PublicClient), not in loadConfig.
 */

/** One entry of the executor's standing grant set, with the name a human can check it by. */
export interface GrantedSelector {
  /** `Contract.function` as the deploy script logs it. */
  readonly name: string;
  readonly selector: Hex;
}

function selectorOf(abi: unknown, contract: string, name: string): Hex {
  const item = getAbiItem({ abi: abi as Abi, name });
  if (!item || item.type !== "function")
    throw new Error(`bootVerify: ${contract}.${name} is not a function in the generated ABI`);
  return toFunctionSelector(item);
}

/**
 * The seven selectors granted to the executor at deploy — DERIVED from the same generated ABIs the
 * adapter encodes calls with, never hardcoded hex. This is the TypeScript mirror of
 * `src/libraries/ControllerSelectors.sol`, which the deploy script and the Foundry suites share; a
 * signature change moves both sides together, and bootVerify.test.ts pins the set to exactly these
 * seven so a silent addition on either side is caught.
 */
export const CONTROLLER_GRANTED_SELECTORS: readonly GrantedSelector[] = [
  {
    name: "AgentTreasury.schedulePolicyUpdate",
    selector: selectorOf(agentTreasuryAbi, "AgentTreasury", "schedulePolicyUpdate"),
  },
  {
    name: "AgentTreasury.executePolicyUpdate",
    selector: selectorOf(agentTreasuryAbi, "AgentTreasury", "executePolicyUpdate"),
  },
  {
    name: "LegalManager.scheduleOperatingAgreementUpdate",
    selector: selectorOf(legalManagerAbi, "LegalManager", "scheduleOperatingAgreementUpdate"),
  },
  {
    name: "LegalManager.executeOperatingAgreementUpdate",
    selector: selectorOf(legalManagerAbi, "LegalManager", "executeOperatingAgreementUpdate"),
  },
  {
    name: "LegalManagerFactory.createEntity",
    selector: selectorOf(legalManagerFactoryAbi, "LegalManagerFactory", "createEntity"),
  },
  {
    name: "IdentityRegistry.setAgentWallet",
    selector: selectorOf(iIdentityRegistryAbi, "IIdentityRegistry", "setAgentWallet"),
  },
  {
    name: "IdentityRegistry.setMetadata",
    selector: selectorOf(iIdentityRegistryAbi, "IIdentityRegistry", "setMetadata"),
  },
] as const;

/** The two selectors M5 pins to the identity registry (design §3). */
export const CONTROLLER_PINNED_SELECTORS: readonly GrantedSelector[] =
  CONTROLLER_GRANTED_SELECTORS.filter((s) => s.name.startsWith("IdentityRegistry."));

/**
 * `role id = bytes32(bytes4 selector)` — the selector LEFT-aligned in a bytes32 (the Euler shape
 * the controller uses). Right-padding is what makes the selector namespace disjoint from
 * DEFAULT_ADMIN_ROLE (0x00) and from the right-aligned WILDCARD_ROLE.
 */
export function selectorRole(selector: Hex): Hex {
  return pad(selector, { dir: "right", size: 32 });
}

/** Anything that failed to READ is a verification outage, not a misconfiguration. */
function unreadable(what: string, err: unknown): Error {
  return new Error(
    `boot: could not verify ${what} on-chain (RPC read failed against ARC_TESTNET_RPC_URL) — the deployment may be fine, but it cannot be confirmed; fix connectivity and restart`,
    { cause: err },
  );
}

/**
 * Controller mode: prove the factory is the controller's, the executor still holds all seven
 * grants, and the M5 registry pins are in place. Throws naming the failing check and the env vars
 * that produced it.
 */
export async function assertControllerWiring(
  publicClient: PublicClient,
  p: { controller: Address; factory: Address; identityRegistry: Address; executor: Address },
): Promise<void> {
  let factoryOwner: Address;
  let grants: readonly boolean[];
  let pins: readonly Address[];
  try {
    [factoryOwner, grants, pins] = await Promise.all([
      publicClient.readContract({
        address: p.factory,
        abi: legalManagerFactoryAbi,
        functionName: "owner",
      }) as Promise<Address>,
      Promise.all(
        CONTROLLER_GRANTED_SELECTORS.map(
          (s) =>
            publicClient.readContract({
              address: p.controller,
              abi: noviControllerAbi,
              functionName: "hasRole",
              args: [selectorRole(s.selector), p.executor],
            }) as Promise<boolean>,
        ),
      ),
      Promise.all(
        CONTROLLER_PINNED_SELECTORS.map(
          (s) =>
            publicClient.readContract({
              address: p.controller,
              abi: noviControllerAbi,
              functionName: "boundTarget",
              args: [s.selector],
            }) as Promise<Address>,
        ),
      ),
    ]);
  } catch (err) {
    throw unreadable(
      `the controller wiring (controller ${p.controller}, factory ${p.factory})`,
      err,
    );
  }

  // 1. The factory must be the one the controller owns, or every relayed createEntity reverts
  //    OwnableUnauthorizedAccount. Also catches a deploy whose acceptOwnership never completed.
  if (!isAddressEqual(factoryOwner, p.controller))
    throw new Error(
      `boot: FACTORY_ADDRESS ${p.factory} is owned by ${factoryOwner}, not by CONTROLLER_ADDRESS ${p.controller} — this is not the controller's factory (or the acceptOwnership ceremony has not completed; the controller must ACCEPT the two-step transfer before it can create entities)`,
    );

  // 2. Every standing grant, by name: a rotated executor key, or a revoke-sweep that went too far,
  //    otherwise surfaces as NotAuthorized on whichever onboarding step needs the missing one.
  const missing = CONTROLLER_GRANTED_SELECTORS.filter((_, i) => !grants[i]);
  if (missing.length > 0)
    throw new Error(
      `boot: executor ${p.executor} (the address of PLATFORM_PRIVATE_KEY) is missing ${missing.length} of ${CONTROLLER_GRANTED_SELECTORS.length} selector grants on CONTROLLER_ADDRESS ${p.controller}: ${missing
        .map((s) => `${s.name} (${s.selector})`)
        .join(
          ", ",
        )} — grant them from the controller admin, or check that PLATFORM_PRIVATE_KEY is the key the deploy granted`,
    );

  // 3. M5 pins. An unpinned registry selector is relayable at ANY contract, which is the exact
  //    third-party-upgradeable-proxy risk the pin exists to bound.
  const badPins = CONTROLLER_PINNED_SELECTORS.map((s, i) => ({ s, actual: pins[i] })).filter(
    ({ actual }) => !actual || !isAddressEqual(actual, p.identityRegistry),
  );
  if (badPins.length > 0)
    throw new Error(
      `boot: M5 target pins on CONTROLLER_ADDRESS ${p.controller} do not point at IDENTITY_REGISTRY ${p.identityRegistry}: ${badPins
        .map(({ s, actual }) => `${s.name} -> ${actual}`)
        .join(
          ", ",
        )} — an unpinned registry selector may be relayed at any contract; set it via controller.setBoundTarget from the admin`,
    );
}

/**
 * Legacy mode (no controller) with a factory configured: the signing key must still BE the
 * factory's owner. Catches the flipped-factory-forgot-CONTROLLER_ADDRESS case, and the window
 * where ownership was transferred to a controller that this deployment does not know about.
 */
export async function assertLegacyFactoryOwner(
  publicClient: PublicClient,
  p: { factory: Address; signer: Address },
): Promise<void> {
  let owner: Address;
  try {
    owner = (await publicClient.readContract({
      address: p.factory,
      abi: legalManagerFactoryAbi,
      functionName: "owner",
    })) as Address;
  } catch (err) {
    throw unreadable(`the factory owner (FACTORY_ADDRESS ${p.factory})`, err);
  }
  if (!isAddressEqual(owner, p.signer))
    throw new Error(
      `boot: FACTORY_ADDRESS ${p.factory} owner is ${owner}, not the signing key ${p.signer} — factory owner is not the signing key; is CONTROLLER_ADDRESS missing? (if this factory was handed to a NoviController, set CONTROLLER_ADDRESS to it; if the handover is still pending, complete or cancel it before starting)`,
    );
}
