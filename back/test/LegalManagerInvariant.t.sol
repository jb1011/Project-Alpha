// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Drives random, correctly-pranked sequences of every LegalManager action so the
///      invariant engine can search for a state that violates a safety property. Reverts
///      are swallowed (try/catch) so the fuzzer keeps exploring deeper sequences.
contract Handler is Test {
    LegalManager public lm;
    MockUSDC public usdc;
    address public manager;
    address public guardian;

    // ghost state
    bool public everDissolved;
    bytes32 public oaAtDissolve;
    mapping(bytes32 => bool) public known;

    constructor(LegalManager lm_, MockUSDC usdc_, address m, address g, bytes32 initialHash) {
        lm = lm_;
        usdc = usdc_;
        manager = m;
        guardian = g;
        known[initialHash] = true;
    }

    function currentOA() public view returns (bytes32 h) {
        (, , h, ) = lm.meta();
    }

    function schedule(bytes32 h) external {
        known[h] = true;
        vm.prank(manager);
        try lm.scheduleOperatingAgreementUpdate(h) {} catch {}
    }

    function execute(bytes32 h) external {
        vm.prank(manager);
        try lm.executeOperatingAgreementUpdate(h) {} catch {}
    }

    function veto(bytes32 h) external {
        vm.prank(guardian);
        try lm.cancelOperatingAgreementUpdate(h) {} catch {}
    }

    function lift(bytes32 h) external {
        vm.prank(guardian);
        try lm.liftVeto(h) {} catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 30 days));
    }

    function initiate(uint256 who) external {
        vm.prank(who % 2 == 0 ? manager : guardian);
        try lm.initiateDissolution() {} catch {}
    }

    function cancel() external {
        // veto must come from the role that did NOT initiate
        address nonInitiator = lm.dissolutionInitiator() == manager ? guardian : manager;
        vm.prank(nonInitiator);
        try lm.cancelDissolution() {} catch {}
    }

    function sweep(address payout) external {
        if (payout == address(0)) payout = address(0xBEEF);
        address[] memory t = new address[](1);
        t[0] = address(usdc);
        vm.prank(manager);
        try lm.sweep(t, payout) {} catch {}
    }

    function finalize() external {
        vm.prank(manager);
        try lm.finalizeDissolution() {
            everDissolved = true;
            oaAtDissolve = currentOA();
        } catch {}
    }
}

contract LegalManagerInvariantTest is StdInvariant, Test {
    LegalManager internal lm;
    Handler internal handler;

    address internal constant MANAGER = address(0xA11CE);
    address internal constant GUARDIAN = address(0x60A12D);
    uint256 internal constant DELAY = 2 days;
    uint256 internal constant AGENT_ID = 7;
    bytes32 internal constant INITIAL_OA = keccak256("oa-v1");

    function setUp() public {
        LegalManager impl = new LegalManager();
        bytes memory data = abi.encodeCall(
            LegalManager.initialize, (MANAGER, GUARDIAN, DELAY, AGENT_ID, "EIN", 1, INITIAL_OA)
        );
        lm = LegalManager(payable(address(new ERC1967Proxy(address(impl), data))));

        MockUSDC usdc = new MockUSDC();
        usdc.mint(address(lm), 5_000_000);

        handler = new Handler(lm, usdc, MANAGER, GUARDIAN, INITIAL_OA);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = Handler.schedule.selector;
        selectors[1] = Handler.execute.selector;
        selectors[2] = Handler.veto.selector;
        selectors[3] = Handler.lift.selector;
        selectors[4] = Handler.warp.selector;
        selectors[5] = Handler.initiate.selector;
        selectors[6] = Handler.sweep.selector;
        selectors[7] = Handler.finalize.selector;
        selectors[8] = Handler.cancel.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Dissolution is terminal: once the body has ever reached Dissolved it can never leave it
    /// (no resurrection back to Active/WindingDown). Active<->WindingDown may toggle via veto.
    function invariant_dissolvedIsTerminal() public view {
        if (handler.everDissolved()) {
            assertEq(uint8(lm.status()), uint8(LegalManager.Status.Dissolved));
        }
    }

    /// Status is always one of the three valid states.
    function invariant_statusInRange() public view {
        assertLe(uint8(lm.status()), uint8(LegalManager.Status.Dissolved));
    }

    /// Identity/role configuration is immutable for the life of the body.
    function invariant_configImmutable() public view {
        assertEq(lm.manager(), MANAGER);
        assertEq(lm.guardian(), GUARDIAN);
        assertEq(lm.amendmentDelay(), DELAY);
        (, , , uint256 id) = lm.meta();
        assertEq(id, AGENT_ID);
    }

    /// The operating-agreement hash can never become a value that was never scheduled
    /// (no arbitrary writes bypassing the schedule/timelock path).
    function invariant_operatingAgreementIsKnown() public view {
        assertTrue(handler.known(handler.currentOA()));
    }

    /// Once dissolved, the operating-agreement hash is frozen.
    function invariant_dissolvedFreezesOperatingAgreement() public view {
        if (uint8(lm.status()) == uint8(LegalManager.Status.Dissolved)) {
            assertEq(handler.currentOA(), handler.oaAtDissolve());
        }
    }
}
