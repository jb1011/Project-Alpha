// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
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
        // M4 (NoviController design §3): the body's manager must be the factory owner, so both
        // agents necessarily share this test contract as manager. The per-proxy STORAGE-isolation
        // property that the uniform manager can no longer demonstrate is carried by the other
        // per-agent roles instead: distinct guardians and distinct operators, asserted to survive
        // the upgrade on the right proxy each. (Before M4 the managers differed and did this job;
        // dropping to a single shared assert would have quietly retired the property.)
        address mgr = factory.owner();
        address guardianA = makeAddr("guardianA");
        address guardianB = makeAddr("guardianB");
        address operatorA = makeAddr("operatorA");
        address operatorB = makeAddr("operatorB");

        (, address proxyA, address treasuryA) =
            factory.createEntity(mgr, guardianA, operatorA, 1 days, "a", "E1", 1, bytes32(0), _defaultTreasuryCfg());
        (, address proxyB, address treasuryB) =
            factory.createEntity(mgr, guardianB, operatorB, 1 days, "b", "E2", 2, bytes32(0), _defaultTreasuryCfg());
        assertTrue(proxyA != proxyB);

        LegalManagerV2 v2 = new LegalManagerV2();
        UpgradeableBeacon beacon = factory.beacon();
        beacon.upgradeTo(address(v2)); // msg.sender == this == beacon owner

        // Both existing proxies now expose the new V2 behavior...
        assertEq(LegalManagerV2(payable(proxyA)).version(), "v2");
        assertEq(LegalManagerV2(payable(proxyB)).version(), "v2");

        // ...with each proxy's OWN state intact — not one proxy's state read twice, and not the
        // implementation's. A storage-layout break in the upgrade shows up here as a swap or a
        // zero, on whichever proxy it hit.
        assertEq(LegalManager(payable(proxyA)).manager(), mgr);
        assertEq(LegalManager(payable(proxyB)).manager(), mgr);
        assertEq(LegalManager(payable(proxyA)).guardian(), guardianA);
        assertEq(LegalManager(payable(proxyB)).guardian(), guardianB);
        // The treasuries are immutable non-proxy contracts, but their operators are the other half
        // of the per-agent identity the factory wired: pin them to the right agent too.
        assertEq(AgentTreasury(treasuryA).operator(), operatorA);
        assertEq(AgentTreasury(treasuryB).operator(), operatorB);
        assertEq(AgentTreasury(treasuryA).guardian(), guardianA);
        assertEq(AgentTreasury(treasuryB).guardian(), guardianB);
    }

    function test_onlyBeaconOwnerCanUpgrade() public {
        LegalManagerV2 v2 = new LegalManagerV2();
        UpgradeableBeacon beacon = factory.beacon();
        vm.prank(address(0xBAD));
        vm.expectRevert();
        beacon.upgradeTo(address(v2));
    }
}
