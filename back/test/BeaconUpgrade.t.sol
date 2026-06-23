// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {LegalManagerV2} from "./mocks/LegalManagerV2.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

contract BeaconUpgradeTest is Test {
    LegalManagerFactory internal factory;
    address internal beaconOwner = address(this); // this test owns the beacon

    function setUp() public {
        MockIdentityRegistry registry = new MockIdentityRegistry();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry), beaconOwner);
    }

    function _defaultTreasuryCfg() internal returns (LegalManagerFactory.TreasuryConfig memory) {
        MockUSDC u = new MockUSDC();
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(u),
            payoutAddress: makeAddr("payout"),
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
    }

    function test_upgradingBeaconUpgradesAllProxies() public {
        // address(1)=manager, address(2)=guardian; operator must differ from both
        (, address proxyA,) = factory.createEntity(address(1), address(2), address(3), 1 days, "a", "E1", 1, bytes32(0), _defaultTreasuryCfg());
        (, address proxyB,) = factory.createEntity(address(4), address(5), address(6), 1 days, "b", "E2", 2, bytes32(0), _defaultTreasuryCfg());

        LegalManagerV2 v2 = new LegalManagerV2();
        UpgradeableBeacon beacon = factory.beacon();
        beacon.upgradeTo(address(v2)); // msg.sender == this == beacon owner

        // Both existing proxies now expose the new V2 behavior, with state intact.
        assertEq(LegalManagerV2(payable(proxyA)).version(), "v2");
        assertEq(LegalManagerV2(payable(proxyB)).version(), "v2");
        assertEq(LegalManager(payable(proxyA)).manager(), address(1));
    }

    function test_onlyBeaconOwnerCanUpgrade() public {
        LegalManagerV2 v2 = new LegalManagerV2();
        UpgradeableBeacon beacon = factory.beacon();
        vm.prank(address(0xBAD));
        vm.expectRevert();
        beacon.upgradeTo(address(v2));
    }
}
