// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract LegalManagerFuzzTest is Test {
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);

    function _deploy(uint256 delay) internal returns (LegalManager) {
        LegalManager impl = new LegalManager();
        bytes memory data = abi.encodeCall(
            LegalManager.initialize, (manager, guardian, delay, 1, "EIN", 1, keccak256("oa"))
        );
        return LegalManager(payable(address(new ERC1967Proxy(address(impl), data))));
    }

    /// The timelock can never be skipped: execution earlier than `delay` always reverts,
    /// and at/after `delay` always succeeds.
    function testFuzz_amendmentRespectsDelay(uint256 delay, uint256 wait, bytes32 newHash) public {
        delay = bound(delay, 1 hours, 3650 days);
        wait = bound(wait, 0, 7300 days);
        LegalManager lm = _deploy(delay);

        uint256 start = block.timestamp;
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);

        vm.warp(start + wait);
        vm.prank(manager);
        if (wait < delay) {
            vm.expectRevert(LegalManager.TooEarly.selector);
            lm.executeOperatingAgreementUpdate(newHash);
        } else {
            lm.executeOperatingAgreementUpdate(newHash);
            (, , bytes32 oaHash, ) = lm.meta();
            assertEq(oaHash, newHash);
        }
    }

    /// initialize must reject any delay below the floor and accept any delay at/above it.
    function testFuzz_initializeDelayFloor(uint256 delay) public {
        LegalManager impl = new LegalManager();
        bytes memory data = abi.encodeCall(
            LegalManager.initialize, (manager, guardian, delay, 1, "EIN", 1, bytes32(0))
        );
        if (delay < impl.MIN_AMENDMENT_DELAY()) {
            vm.expectRevert(LegalManager.DelayTooShort.selector);
            new ERC1967Proxy(address(impl), data);
        } else {
            LegalManager lm = LegalManager(payable(address(new ERC1967Proxy(address(impl), data))));
            assertEq(lm.amendmentDelay(), delay);
        }
    }

    /// Sweeping always moves the exact full balance to the payout address, for any amount.
    function testFuzz_sweepMovesFullBalance(uint256 amount, address payoutTo) public {
        vm.assume(payoutTo != address(0));
        amount = bound(amount, 0, type(uint128).max);

        LegalManager lm = _deploy(2 days);
        MockUSDC usdc = new MockUSDC();
        // exclude addresses that already hold tokens / are the LM itself
        vm.assume(payoutTo != address(lm));
        usdc.mint(address(lm), amount);

        vm.prank(manager);
        lm.initiateDissolution();
        vm.warp(block.timestamp + 2 days); // clear the dissolution timelock window

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.prank(manager);
        lm.sweep(tokens, payoutTo);

        assertEq(usdc.balanceOf(payoutTo), amount);
        assertEq(usdc.balanceOf(address(lm)), 0);
    }

    /// Only the configured manager may schedule; every other address reverts.
    function testFuzz_onlyManagerSchedules(address caller, bytes32 h) public {
        vm.assume(caller != manager);
        LegalManager lm = _deploy(2 days);
        vm.prank(caller);
        vm.expectRevert(LegalManager.NotManager.selector);
        lm.scheduleOperatingAgreementUpdate(h);
    }

    /// Only manager or guardian may initiate dissolution; anyone else reverts.
    function testFuzz_onlyAuthorizedInitiates(address caller) public {
        vm.assume(caller != manager && caller != guardian);
        LegalManager lm = _deploy(2 days);
        vm.prank(caller);
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.initiateDissolution();
    }
}
