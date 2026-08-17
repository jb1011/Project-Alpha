// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ControllerSelectors} from "../src/libraries/ControllerSelectors.sol";
import {NoviController} from "../src/NoviController.sol";
import {BreakGlassOneShot} from "../src/BreakGlassOneShot.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Steps 1-2 of the NoviController migration (design §7): deploy the controller with the
///         executor's standing selector grants AND the M5 registry pins, deploy a factory whose
///         beacon owner is the controller, and hand the factory's ownership to the controller
///         (two-step, pending).
/// @dev    Env:
///           PRIVATE_KEY              deployer key (broadcast)
///           IDENTITY_REGISTRY        live ERC-8004 registry
///           CONTROLLER_ADMIN         cold role administrator (hardware/multisig on mainnet)
///           CONTROLLER_EXECUTOR      hot backend key receiving the selector grants
///           CONTROLLER_ADMIN_DELAY   optional, seconds; defaults to 24h (design §3)
///           LEGAL_MANAGER_IMPL       optional; reuse an existing implementation instead of
///                                    deploying a fresh one (the beacon points at it)
///
///         The M5 pins (`setAgentWallet`/`setMetadata` -> the registry) are CONSTRUCTOR arguments,
///         so they hold from block 0 — there is no window in which a registry selector is
///         relayable at an arbitrary target, and no ceremony step that can be forgotten.
///
///         Deliberately NOT broadcast here, because it requires the ADMIN key (which is not the
///         deployer) and the design wants it as a human-visible ceremony:
///           a) `acceptOwnership` on the factory, via a BreakGlassOneShot (grant + act + revoke)
///         It is printed below with the exact arguments.
contract DeployController is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");
        address admin = vm.envAddress("CONTROLLER_ADMIN");
        address executor = vm.envAddress("CONTROLLER_EXECUTOR");
        uint48 adminDelay = uint48(vm.envOr("CONTROLLER_ADMIN_DELAY", uint256(24 hours)));
        address existingImpl = vm.envOr("LEGAL_MANAGER_IMPL", address(0));

        bytes4[] memory selectors = _grantedSelectors();

        // M5 (design §3): the ERC-8004 registry is a third-party UPGRADEABLE proxy, so the two
        // selectors we relay at it are pinned to its address from block 0.
        bytes4[] memory pinSelectors = new bytes4[](2);
        pinSelectors[0] = IIdentityRegistry.setAgentWallet.selector;
        pinSelectors[1] = IIdentityRegistry.setMetadata.selector;
        address[] memory pinTargets = new address[](2);
        pinTargets[0] = identityRegistry;
        pinTargets[1] = identityRegistry;

        vm.startBroadcast(pk);
        NoviController controller = new NoviController(adminDelay, admin, executor, selectors, pinSelectors, pinTargets);

        address impl = existingImpl;
        if (impl == address(0)) impl = address(new LegalManager());

        // Beacon owner = controller from day one: fleet upgrades become an admin break-glass.
        LegalManagerFactory factory = new LegalManagerFactory(impl, identityRegistry, address(controller));
        // Two-step: the controller must accept (ceremony (a) below) before it can create entities.
        factory.transferOwnership(address(controller));
        vm.stopBroadcast();

        console2.log("NoviController:      ", address(controller));
        console2.log("  admin (DEFAULT_ADMIN):", admin);
        console2.log("  executor:            ", executor);
        console2.log("  admin delay (s):     ", uint256(adminDelay));
        console2.log("LegalManager impl:   ", impl);
        console2.log("LegalManagerFactory: ", address(factory));
        console2.log("  beacon:              ", address(factory.beacon()));
        console2.log("  beacon owner:        ", factory.beacon().owner());
        console2.log("  owner (current):     ", factory.owner());
        console2.log("  pendingOwner:        ", factory.pendingOwner());

        console2.log("");
        // Each line names the function AND derives its selector from the same ABI the constructor
        // used. Never index into `selectors` positionally: this log is the human verification
        // artifact of a mainnet ceremony, and a reordered library would silently relabel it.
        console2.log("Executor selector grants made at deploy:");
        _logSelector("AgentTreasury.schedulePolicyUpdate", AgentTreasury.schedulePolicyUpdate.selector);
        _logSelector("AgentTreasury.executePolicyUpdate", AgentTreasury.executePolicyUpdate.selector);
        _logSelector(
            "LegalManager.scheduleOperatingAgreementUpdate", LegalManager.scheduleOperatingAgreementUpdate.selector
        );
        _logSelector(
            "LegalManager.executeOperatingAgreementUpdate", LegalManager.executeOperatingAgreementUpdate.selector
        );
        _logSelector("LegalManagerFactory.createEntity", LegalManagerFactory.createEntity.selector);
        _logSelector("IdentityRegistry.setAgentWallet", IIdentityRegistry.setAgentWallet.selector);
        _logSelector("IdentityRegistry.setMetadata", IIdentityRegistry.setMetadata.selector);
        console2.log("  (count logged vs granted):", selectors.length);

        console2.log("");
        console2.log("M5 target pins set in the CONSTRUCTOR (no ceremony needed):");
        console2.log("  registry =", identityRegistry);
        _logSelector("  pinned: IdentityRegistry.setAgentWallet", IIdentityRegistry.setAgentWallet.selector);
        _logSelector("  pinned: IdentityRegistry.setMetadata", IIdentityRegistry.setMetadata.selector);
        console2.log("  verify: controller.boundTarget(<selector>) == registry, for both");

        console2.log("");
        console2.log("MANUAL STEP (a) - factory acceptOwnership via one-shot break-glass:");
        console2.log(
            "  1. deploy BreakGlassOneShot(controller, factory, abi.encodeWithSignature(\"acceptOwnership()\"))"
        );
        console2.log("     controller =", address(controller));
        console2.log("     target     =", address(factory));
        _logSelector("     selector/role = Ownable2Step.acceptOwnership", Ownable2Step.acceptOwnership.selector);
        console2.log("  2. ADMIN sends: controller.grantRole(bytes32(selector), <helper>)");
        console2.log("  3. HELPER DEPLOYER sends: helper.execute()   (relays + self-revokes in one tx)");
        console2.log("  4. CHECK THE RETURNED `ok` / BreakGlassExecuted event: execute() spends the");
        console2.log("     helper and revokes the grant EVEN IF the relayed call failed. ok=false");
        console2.log("     means nothing happened - deploy a FRESH helper and re-grant.");
        console2.log("  5. verify: factory.owner() == controller, and the old deployer's createEntity reverts");

        console2.log("");
        console2.log("THEN: backend env -> FACTORY_ADDRESS + CONTROLLER_ADDRESS, restart, probe agent, wizard test.");
    }

    /// @dev The ONE grant-set definition — src/libraries/ControllerSelectors.sol.
    function _grantedSelectors() internal pure returns (bytes4[] memory) {
        return ControllerSelectors.granted();
    }

    function _logSelector(string memory name, bytes4 selector) internal pure {
        console2.log(string.concat("  ", name, ": "));
        console2.logBytes4(selector);
    }
}
