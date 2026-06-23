// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Rejects native value (no receive / payable fallback) so sweepNative's call fails.
contract NativeRejector {}

/// @dev ERC-20 that re-enters LegalManager.sweep on transfer, to prove re-entry is blocked.
contract ReentrantToken is ERC20 {
    address public lm;
    bool private _armed;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address lm_) external {
        lm = lm_;
        _armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (_armed && from == lm) {
            _armed = false; // avoid unbounded recursion; one re-entry attempt is enough
            address[] memory tokens = new address[](1);
            tokens[0] = address(this);
            LegalManager(payable(lm)).sweep(tokens, address(0xBEEF));
        }
    }
}

contract LegalManagerSecurityTest is Test {
    LegalManager internal lm;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);
    address internal treasury = address(0x7EA);

    function _deploy() internal returns (LegalManager) {
        LegalManager impl = new LegalManager();
        bytes memory data = abi.encodeCall(
            LegalManager.initialize, (manager, guardian, 2 days, 1, "EIN", 1, keccak256("oa"))
        );
        return LegalManager(payable(address(new ERC1967Proxy(address(impl), data))));
    }

    function setUp() public {
        lm = _deploy();
        vm.prank(manager);
        lm.initiateDissolution();
        vm.warp(block.timestamp + 2 days); // clear the dissolution timelock window
    }

    // --- branch: sweep a token with zero balance (bal > 0 == false) ---
    function test_sweepSkipsZeroBalanceToken() public {
        MockUSDC empty = new MockUSDC(); // LM holds none of this
        address[] memory tokens = new address[](1);
        tokens[0] = address(empty);

        vm.prank(manager);
        lm.sweep(tokens, treasury); // must not revert, simply no transfer

        assertEq(empty.balanceOf(treasury), 0);
    }

    // --- branch: sweepNative with zero balance (bal > 0 == false) ---
    function test_sweepNativeNoopWhenEmpty() public {
        assertEq(address(lm).balance, 0);
        vm.prank(manager);
        lm.sweepNative(treasury); // no-op, no revert
        assertEq(treasury.balance, 0);
    }

    // --- branch: sweepNative payout rejects value (!ok == true) ---
    function test_sweepNativeRevertsWhenPayoutRejects() public {
        NativeRejector rejector = new NativeRejector();
        vm.deal(address(lm), 1 ether);
        vm.prank(manager);
        vm.expectRevert(LegalManager.NativeSweepFailed.selector);
        lm.sweepNative(address(rejector));
    }

    // --- security: a malicious token cannot re-enter sweep ---
    function test_reentrantTokenCannotReenterSweep() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(address(lm), 1_000);
        evil.arm(address(lm));

        address[] memory tokens = new address[](1);
        tokens[0] = address(evil);

        // Re-entry is attempted from the token contract (not the manager); the call must
        // revert and no funds may be double-swept.
        vm.prank(manager);
        vm.expectRevert();
        lm.sweep(tokens, treasury);

        assertEq(evil.balanceOf(treasury), 0); // nothing leaked
        assertEq(evil.balanceOf(address(lm)), 1_000); // balance untouched (whole tx reverted)
    }
}
