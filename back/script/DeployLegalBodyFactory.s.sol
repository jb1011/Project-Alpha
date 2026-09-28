// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {ControllerSelectors} from "../src/libraries/ControllerSelectors.sol";

/// @notice Deploys the LegalBodyFactory, owned by the controller from construction, and prints
///         the admin ceremony that follows it. The ceremony is not broadcast here: it needs the
///         controller ADMIN key, which is not the deployer, and it is done by a person.
/// @dev    Env: PRIVATE_KEY, IDENTITY_REGISTRY, CONTROLLER, LEGAL_MANAGER_IMPL (all required),
///         CONTROLLER_EXECUTOR (only for the printed ceremony). LEGAL_MANAGER_IMPL is required
///         on purpose: the bodies are immutable clones, so the implementation must be chosen
///         explicitly, never defaulted.
contract DeployLegalBodyFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address registry = vm.envAddress("IDENTITY_REGISTRY");
        address controller = vm.envAddress("CONTROLLER");
        address impl = vm.envAddress("LEGAL_MANAGER_IMPL");
        address executor = vm.envAddress("CONTROLLER_EXECUTOR");
        require(registry.code.length > 0 && controller.code.length > 0 && impl.code.length > 0, "not a contract");

        vm.startBroadcast(pk);
        LegalBodyFactory factory = new LegalBodyFactory(impl, registry, controller);
        vm.stopBroadcast();

        console2.log("LegalBodyFactory:    ", address(factory));
        console2.log("  owner:             ", factory.owner());
        console2.log("  implementation:    ", factory.implementation());
        console2.log("  identityRegistry:  ", address(factory.identityRegistry()));
        console2.log("");
        console2.log("ADMIN CEREMONY (in this order; pins BEFORE grants):");
        bytes4[] memory s = ControllerSelectors.minimalGrants();
        string[2] memory names =
            ["LegalBodyFactory.createLegalBody", "LegalBodyFactory.scheduleOperatingAgreementUpdate"];
        require(s.length == names.length, "label drift");
        for (uint256 i = 0; i < s.length; i++) {
            console2.log(
                string.concat("  ", vm.toString(i + 1), ". controller.setBoundTarget(<", names[i], ">, factory)")
            );
            console2.logBytes4(s[i]);
        }
        for (uint256 i = 0; i < s.length; i++) {
            console2.log(
                string.concat("  ", vm.toString(i + 3), ". controller.grantRole(bytes32(<", names[i], ">), executor)")
            );
            console2.logBytes4(s[i]);
        }
        console2.log("  executor =", executor);
        console2.log("VERIFY: boundTarget(sel) == factory and hasRole(bytes32(sel), executor) for both selectors");
    }
}
