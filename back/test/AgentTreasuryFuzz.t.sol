// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockLegalManagerStatus} from "./mocks/MockLegalManagerStatus.sol";

contract AgentTreasuryFuzzTest is Test {
    MockUSDC internal usdc;
    MockLegalManagerStatus internal legal;
    AgentTreasury internal vault;
    address internal manager  = makeAddr("manager");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal payout   = makeAddr("payout");
    uint256 internal constant CAP = 500e6;
    uint256 internal constant PERIOD = 1 days;

    function setUp() public {
        usdc = new MockUSDC();
        legal = new MockLegalManagerStatus();
        vault = new AgentTreasury(address(usdc), address(legal), manager, guardian, operator, payout, CAP, PERIOD, 2 days, false);
        usdc.mint(address(vault), 1_000_000e6);
    }

    /// @notice Within a single window, total spent never exceeds the cap.
    function testFuzz_neverExceedsCapInWindow(uint256 a, uint256 b) public {
        a = bound(a, 1, CAP);
        b = bound(b, 1, CAP);
        address p = makeAddr("p");
        vm.prank(operator);
        vault.spend(p, a);
        if (a + b > CAP) {
            vm.prank(operator);
            vm.expectRevert(AgentTreasury.CapExceeded.selector);
            vault.spend(p, b);
        } else {
            vm.prank(operator);
            vault.spend(p, b);
            assertLe(vault.spentInWindow(), CAP);
        }
    }

    /// @notice After a full period elapses, the cap is fully available again.
    function testFuzz_capResetsEachPeriod(uint256 first) public {
        first = bound(first, 1, CAP);
        address p = makeAddr("p");
        vm.prank(operator);
        vault.spend(p, first);
        vm.warp(block.timestamp + PERIOD);
        assertEq(vault.available(), CAP);
        vm.prank(operator);
        vault.spend(p, CAP);
        assertEq(usdc.balanceOf(p), first + CAP);
    }
}
