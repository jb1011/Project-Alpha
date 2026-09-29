// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {ControllerSelectors} from "../src/libraries/ControllerSelectors.sol";

/// @notice Deploys the LegalBodyFactory, owned by the controller from construction, and prints
///         the admin ceremony that follows it. The ceremony is not broadcast here: it needs the
///         controller ADMIN key, which is not the deployer, and it is done by a person.
/// @dev    Env: PRIVATE_KEY, CHAIN_ID, IDENTITY_REGISTRY, CONTROLLER, LEGAL_MANAGER_IMPL (all
///         required); CONTROLLER_EXECUTOR (optional, only for the printed ceremony).
///         LEGAL_MANAGER_IMPL is required on purpose: the bodies are immutable clones, so the
///         implementation must be chosen explicitly, never defaulted. Before broadcasting, the
///         script requires its runtime code to equal this repo's compiled LegalManager (CBOR
///         metadata excluded), so a proxy or any other contract can never be cloned by mistake.
///         Run it with the repo's own EVM version (foundry.toml), the one the live
///         implementation was compiled for; any other build will not match and is refused.
contract DeployLegalBodyFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 chainId = vm.envUint("CHAIN_ID");
        address registry = vm.envAddress("IDENTITY_REGISTRY");
        address controller = vm.envAddress("CONTROLLER");
        address impl = vm.envAddress("LEGAL_MANAGER_IMPL");
        address executor = vm.envOr("CONTROLLER_EXECUTOR", address(0));

        require(chainId == block.chainid, "CHAIN_ID does not match the connected chain");
        require(registry.code.length > 0, "IDENTITY_REGISTRY is not a contract");
        require(controller.code.length > 0, "CONTROLLER is not a contract");
        require(impl.code.length > 0, "LEGAL_MANAGER_IMPL is not a contract");
        bytes memory ours = vm.getDeployedCode("LegalManager.sol:LegalManager");
        require(
            keccak256(_stripMetadata(impl.code)) == keccak256(_stripMetadata(ours)),
            "LEGAL_MANAGER_IMPL is not this repo's LegalManager (runtime code differs)"
        );

        vm.startBroadcast(pk);
        LegalBodyFactory factory = new LegalBodyFactory(impl, registry, controller);
        vm.stopBroadcast();

        require(
            factory.owner() == controller && factory.implementation() == impl
                && address(factory.identityRegistry()) == registry,
            "deployed factory does not match its inputs"
        );

        console2.log("LegalBodyFactory:    ", address(factory));
        console2.log("  owner:             ", factory.owner());
        console2.log("  implementation:    ", factory.implementation());
        console2.log("  identityRegistry:  ", address(factory.identityRegistry()));
        console2.log("");
        string memory executorLabel = executor == address(0) ? "<executor>" : vm.toString(executor);
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
                string.concat(
                    "  ", vm.toString(i + 3), ". controller.grantRole(bytes32(<", names[i], ">), ", executorLabel, ")"
                )
            );
            console2.logBytes4(s[i]);
        }
        console2.log("VERIFY: boundTarget(sel) == factory and hasRole(bytes32(sel), executor) for both selectors");
    }

    /// @dev Drops the trailing CBOR metadata that solc appends to runtime code. Its last 2 bytes
    ///      are a big-endian length L of the CBOR block before them, so the last L + 2 bytes go.
    ///      Code too short to hold that much is returned unchanged.
    function _stripMetadata(bytes memory code) internal pure returns (bytes memory stripped) {
        uint256 n = code.length;
        if (n < 2) return code;
        uint256 metaLen = (uint256(uint8(code[n - 2])) << 8) | uint256(uint8(code[n - 1]));
        if (metaLen + 2 > n) return code;
        stripped = new bytes(n - metaLen - 2);
        for (uint256 i = 0; i < stripped.length; i++) {
            stripped[i] = code[i];
        }
    }
}
