// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Fuzzes createEntity across the full parameter surface to prove that, for ANY valid
///      configuration, the factory deploys a correctly-wired LegalManager + AgentTreasury,
///      hands the identity to the manager, and keeps the registry consistent.
contract LegalManagerFactoryFuzzTest is Test {
    LegalManagerFactory internal factory;
    MockIdentityRegistry internal registry;
    MockUSDC internal usdc;

    address internal beaconOwner = makeAddr("beaconOwner");

    function setUp() public {
        registry = new MockIdentityRegistry();
        usdc = new MockUSDC();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry), beaconOwner);
    }

    /// @dev Confine fuzzed addresses to a tractable, valid space: non-zero, pairwise-distinct
    ///      roles (AgentTreasury enforces RolesMustDiffer), and not a precompile.
    function _bounded(address a, uint256 salt) internal pure returns (address) {
        uint160 v = uint160(uint256(keccak256(abi.encode(a, salt))));
        if (v < 0x10000) v += 0x10000; // dodge zero + precompile range
        return address(v);
    }

    function testFuzz_createEntityWiresEverything(
        address managerSeed,
        address guardianSeed,
        address operatorSeed,
        address payoutSeed,
        uint256 delay,
        uint96 cap,
        uint64 period,
        uint64 formationDate,
        bytes32 oaHash,
        bool allowlist
    ) public {
        address manager  = _bounded(managerSeed, 1);
        address guardian = _bounded(guardianSeed, 2);
        address operator = _bounded(operatorSeed, 3);
        address payout   = _bounded(payoutSeed, 4);
        // roles must all differ, and the payout sink must not be the operator (treasury ctor)
        vm.assume(manager != guardian && manager != operator && guardian != operator);
        vm.assume(payout != operator);

        delay = bound(delay, 1 hours, 3650 days);
        uint256 per = uint256(period);
        per = bound(per, 1, 365 days); // non-zero and within AgentTreasury.MAX_POLICY_PERIOD

        LegalManagerFactory.TreasuryConfig memory cfg = LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc),
            payoutAddress: payout,
            cap: uint256(cap),
            period: per,
            allowlistEnabled: allowlist
        });

        uint256 countBefore = factory.entitiesCount();
        (uint256 agentId, address proxy, address treasury) = factory.createEntity(
            manager, guardian, operator, delay, "ipfs://meta", "EIN-1", formationDate, oaHash, cfg
        );

        // Registry bookkeeping
        assertEq(factory.entitiesCount(), countBefore + 1);
        assertEq(factory.entityByAgentId(agentId), proxy);
        assertEq(factory.treasuryByAgentId(agentId), treasury);
        assertEq(registry.ownerOf(agentId), manager); // identity handed to the manager

        // LegalManager wiring
        LegalManager lm = LegalManager(payable(proxy));
        assertEq(lm.manager(), manager);
        assertEq(lm.guardian(), guardian);
        assertEq(lm.amendmentDelay(), delay);
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
        (, uint64 fd, bytes32 storedOa, uint256 storedId) = lm.meta();
        assertEq(fd, formationDate);
        assertEq(storedOa, oaHash);
        assertEq(storedId, agentId);

        // AgentTreasury wiring
        AgentTreasury t = AgentTreasury(treasury);
        assertEq(t.manager(), manager);
        assertEq(t.guardian(), guardian);
        assertEq(t.operator(), operator);
        assertEq(t.legalManager(), proxy);
        assertEq(t.payoutAddress(), payout);
        assertEq(address(t.usdc()), address(usdc));
        assertEq(t.cap(), uint256(cap));
        assertEq(t.period(), per);
        assertEq(t.policyDelay(), delay); // treasury reuses amendmentDelay as its policy delay
        assertEq(t.allowlistEnabled(), allowlist);
    }

    /// Any amendmentDelay below the shared floor must revert the whole createEntity.
    function testFuzz_rejectsDelayBelowFloor(uint256 delay) public {
        delay = bound(delay, 0, 1 hours - 1);
        LegalManagerFactory.TreasuryConfig memory cfg = LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc),
            payoutAddress: makeAddr("payout"),
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
        vm.expectRevert(LegalManager.DelayTooShort.selector);
        factory.createEntity(
            makeAddr("m"), makeAddr("g"), makeAddr("o"), delay, "ipfs://x", "EIN", 1, keccak256("x"), cfg
        );
    }

    /// Only the owner may create entities, for ANY caller that isn't the owner.
    function testFuzz_onlyOwnerCanCreate(address caller) public {
        vm.assume(caller != factory.owner());
        LegalManagerFactory.TreasuryConfig memory cfg = LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc),
            payoutAddress: makeAddr("payout"),
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
        vm.prank(caller);
        vm.expectRevert(); // OZ Ownable: OwnableUnauthorizedAccount
        factory.createEntity(
            makeAddr("m"), makeAddr("g"), makeAddr("o"), 2 days, "ipfs://x", "EIN", 1, keccak256("x"), cfg
        );
    }
}
