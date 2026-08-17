// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NoviController} from "../src/NoviController.sol";
import {BreakGlassOneShot} from "../src/BreakGlassOneShot.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Steps 1-2 of the NoviController migration (design §7): deploy the controller with the
///         executor's standing selector grants, deploy a factory whose beacon owner is the
///         controller, and hand the factory's ownership to the controller (two-step, pending).
/// @dev    Env:
///           PRIVATE_KEY              deployer key (broadcast)
///           IDENTITY_REGISTRY        live ERC-8004 registry
///           CONTROLLER_ADMIN         cold role administrator (hardware/multisig on mainnet)
///           CONTROLLER_EXECUTOR      hot backend key receiving the selector grants
///           CONTROLLER_ADMIN_DELAY   optional, seconds; defaults to 24h (design §3)
///           LEGAL_MANAGER_IMPL       optional; reuse an existing implementation instead of
///                                    deploying a fresh one (the beacon points at it)
///
///         Deliberately NOT broadcast here, because both require the ADMIN key (which is not the
///         deployer) and the design wants them as human-visible ceremonies:
///           a) `acceptOwnership` on the factory, via a BreakGlassOneShot (grant + act + revoke)
///           b) `setBoundTarget` for the two registry selectors (M5)
///         Both are printed below with the exact arguments.
contract DeployController is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");
        address admin = vm.envAddress("CONTROLLER_ADMIN");
        address executor = vm.envAddress("CONTROLLER_EXECUTOR");
        uint48 adminDelay = uint48(vm.envOr("CONTROLLER_ADMIN_DELAY", uint256(24 hours)));
        address existingImpl = vm.envOr("LEGAL_MANAGER_IMPL", address(0));

        bytes4[] memory selectors = _grantedSelectors();

        vm.startBroadcast(pk);
        NoviController controller = new NoviController(adminDelay, admin, executor, selectors);

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
        console2.log("Executor selector grants made at deploy:");
        _logSelector("AgentTreasury.schedulePolicyUpdate", selectors[0]);
        _logSelector("AgentTreasury.executePolicyUpdate", selectors[1]);
        _logSelector("LegalManager.scheduleOperatingAgreementUpdate", selectors[2]);
        _logSelector("LegalManager.executeOperatingAgreementUpdate", selectors[3]);
        _logSelector("LegalManagerFactory.createEntity", selectors[4]);
        _logSelector("IdentityRegistry.setAgentWallet", selectors[5]);
        _logSelector("IdentityRegistry.setMetadata", selectors[6]);

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
        console2.log("  4. verify: factory.owner() == controller, and the old deployer's createEntity reverts");

        console2.log("");
        console2.log("MANUAL STEP (b) - ADMIN pins the registry selectors to the registry (M5):");
        console2.log("  controller.setBoundTarget(<setAgentWallet selector>, registry)");
        console2.log("  controller.setBoundTarget(<setMetadata selector>,    registry)");
        console2.log("     registry =", identityRegistry);

        console2.log("");
        console2.log("THEN: backend env -> FACTORY_ADDRESS + CONTROLLER_ADDRESS, restart, probe agent, wizard test.");
    }

    /// @dev design §3's standing grant list, computed from the ABIs rather than hardcoded hex, so
    ///      a signature change in our own contracts moves the deploy script with it.
    function _grantedSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = AgentTreasury.schedulePolicyUpdate.selector;
        s[1] = AgentTreasury.executePolicyUpdate.selector;
        s[2] = LegalManager.scheduleOperatingAgreementUpdate.selector;
        s[3] = LegalManager.executeOperatingAgreementUpdate.selector;
        s[4] = LegalManagerFactory.createEntity.selector;
        s[5] = IIdentityRegistry.setAgentWallet.selector;
        s[6] = IIdentityRegistry.setMetadata.selector;
    }

    function _logSelector(string memory name, bytes4 selector) internal pure {
        console2.log(string.concat("  ", name, ": "));
        console2.logBytes4(selector);
    }
}
