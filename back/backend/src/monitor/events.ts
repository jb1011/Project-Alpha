import {
  type AbiEvent,
  type Hex,
  keccak256,
  pad,
  parseAbiItem,
  toEventSelector,
  toHex,
} from "viem";
import { legalManagerAbi } from "../abis/generated";
import { CONTROLLER_GRANTED_SELECTORS, selectorRole } from "../adapters/arc/bootVerify";

/**
 * Every event topic the monitor keys off, in one place.
 *
 * Where a generated ABI carries the event we use it (controller, factory, treasury) so a contract
 * change moves the monitor with it. Three fragments are declared INLINE because no generated ABI
 * has them:
 *
 *  - `UpgradeableBeacon.Upgraded` — the beacon is an OpenZeppelin contract we deploy but do not
 *    compile into our ABI set.
 *  - The identity registry's `MetadataSet` / ERC-721 `Transfer` — `iIdentityRegistryAbi` is a
 *    hand-written FUNCTION-ONLY subset (see src/interfaces/IIdentityRegistry.sol) and declares no
 *    events at all.
 *
 * ⚠ The wallet-bind event is `MetadataSet`, NOT `AgentWalletSet`. Verified 2026-08-18 against the
 * live verified implementation behind the registry proxy 0x8004A818…BD9e (impl
 * 0x7274e874ca62410a93bd8bf61c69d8045e399c02, `IdentityRegistryUpgradeable`): the registry has NO
 * `AgentWalletSet` event. `setAgentWallet` writes `_metadata[agentId]["agentWallet"]` and emits
 * `MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(newWallet))`. Watching a
 * non-existent `AgentWalletSet` topic would have produced a rule that can never fire — a silent
 * blind spot on the one granted operation with no timelock and no guardian veto (design §8).
 */

/** `event Upgraded(address indexed implementation)` — OZ UpgradeableBeacon (and every UUPS proxy). */
export const beaconUpgradedEvent = parseAbiItem(
  "event Upgraded(address indexed implementation)",
) as AbiEvent;

/**
 * The live registry's metadata event. `indexedMetadataKey` is an INDEXED string, so topic[2] is
 * keccak256 of the key rather than the key itself — that is what lets us filter server-side on
 * "agentWallet" instead of pulling every metadata write on a registry we share with the whole chain.
 *
 * Confirmed against live logs (2026-08-18): topic0 `0x2c149ed5…`, topic[1] = agentId,
 * topic[2] = `0x2ac61093…` = keccak256("agentWallet").
 */
export const registryMetadataSetEvent = parseAbiItem(
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
) as AbiEvent;

/** ERC-721 transfer on the identity registry: agentId == tokenId. Live topic0 `0xddf252ad…`. */
export const registryTransferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
) as AbiEvent;

/**
 * One event fragment out of the GENERATED LegalManager ABI, by name.
 *
 * Derived rather than written as a signature string, deliberately: a `bytes32` that quietly
 * became a `bytes32[]` would move topic0 and leave a hand-written signature watching a topic
 * nothing emits — a silent blind spot on the one governance path the guardian is expected to
 * police. This way `forge build` + `gen:abis` moves the monitor with the contract, and an event
 * that is renamed or removed fails HERE, at import time, instead of at 3am.
 */
export function legalManagerEvent(name: string): AbiEvent {
  const found = legalManagerAbi.find((e) => e.type === "event" && e.name === name);
  if (!found) throw new Error(`monitor: LegalManager ABI has no event ${name}`);
  return found as AbiEvent;
}

/** The reserved metadata key the registry uses for the bound agent wallet. */
export const AGENT_WALLET_KEY = "agentWallet";
/** topic[2] of a wallet-bind `MetadataSet` — the indexed string is stored as its keccak256. */
export const AGENT_WALLET_KEY_TOPIC: Hex = keccak256(toHex(AGENT_WALLET_KEY));

export const TOPIC = {
  // Controller (noviControllerAbi)
  roleGranted: sel("RoleGranted(bytes32,address,address)"),
  roleRevoked: sel("RoleRevoked(bytes32,address,address)"),
  defaultAdminTransferScheduled: sel("DefaultAdminTransferScheduled(address,uint48)"),
  defaultAdminTransferCanceled: sel("DefaultAdminTransferCanceled()"),
  defaultAdminDelayChangeScheduled: sel("DefaultAdminDelayChangeScheduled(uint48,uint48)"),
  defaultAdminDelayChangeCanceled: sel("DefaultAdminDelayChangeCanceled()"),
  relayed: sel("Relayed(address,address,bytes4)"),
  boundTargetSet: sel("BoundTargetSet(bytes4,address)"),
  // Factory (legalManagerFactoryAbi)
  ownershipTransferStarted: sel("OwnershipTransferStarted(address,address)"),
  ownershipTransferred: sel("OwnershipTransferred(address,address)"),
  // Beacon
  upgraded: toEventSelector(beaconUpgradedEvent),
  // Treasury (agentTreasuryAbi)
  policyUpdateScheduled: sel("PolicyUpdateScheduled(bytes32,uint256,uint256,bool,address,uint256)"),
  policyUpdateVetoed: sel("PolicyUpdateVetoed(bytes32)"),
  policyUpdated: sel("PolicyUpdated(uint256,uint256,bool,address)"),
  // Registry
  metadataSet: toEventSelector(registryMetadataSetEvent),
  transfer: toEventSelector(registryTransferEvent),
  // LegalManager — the OA amendment path (design 2026-08-19 §8). Topic0 comes from the generated
  // ABI, never from a hand-written signature: see `legalManagerEvent`.
  amendmentScheduled: toEventSelector(legalManagerEvent("AmendmentScheduled")),
  amendmentVetoed: toEventSelector(legalManagerEvent("AmendmentVetoed")),
  vetoLifted: toEventSelector(legalManagerEvent("VetoLifted")),
  operatingAgreementUpdated: toEventSelector(legalManagerEvent("OperatingAgreementUpdated")),
} as const;

function sel(signature: string): Hex {
  return toEventSelector(signature);
}

/** OZ AccessControl's admin role — `bytes32(0)`. Granting it means an admin handover COMPLETED. */
export const DEFAULT_ADMIN_ROLE: Hex = pad("0x00", { size: 32 });

/** NoviController.WILDCARD_ROLE — `bytes32(uint256(1))`, i.e. right-aligned, deliberately outside
 *  the left-aligned selector-role namespace. Holding it means "relay ANY selector at ANY target". */
export const WILDCARD_ROLE: Hex = pad("0x01", { size: 32 });

/**
 * The seven standing executor roles, derived from the SAME generated-ABI selector list bootVerify
 * asserts on-chain at every API boot. Never hardcoded: a signature change moves the boot check and
 * the monitor together, so "expected grant" can never drift from "verified grant".
 */
export function standingRoles(): Set<Hex> {
  return new Set(
    CONTROLLER_GRANTED_SELECTORS.map((s) => selectorRole(s.selector).toLowerCase() as Hex),
  );
}
