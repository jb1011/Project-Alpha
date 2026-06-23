// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";

/// @notice Deploys the LegalManager implementation + Factory (which creates the beacon)
///         to Arc testnet, pointed at the live ERC-8004 IdentityRegistry.
/// @dev    BEACON_OWNER controls fleet-wide upgrades of every LegalManager. Set it to a
///         multisig/timelock in production; defaults to the deployer if unset.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");
        address beaconOwner = vm.envOr("BEACON_OWNER", vm.addr(pk));

        vm.startBroadcast(pk);
        LegalManager impl = new LegalManager();
        LegalManagerFactory factory = new LegalManagerFactory(address(impl), identityRegistry, beaconOwner);
        vm.stopBroadcast();

        console2.log("LegalManager impl:", address(impl));
        console2.log("LegalManagerFactory:", address(factory));
        console2.log("Beacon:", address(factory.beacon()));
        console2.log("Beacon owner:", beaconOwner);
    }
}
