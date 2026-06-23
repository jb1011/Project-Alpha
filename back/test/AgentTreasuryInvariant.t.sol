// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockLegalManagerStatus} from "./mocks/MockLegalManagerStatus.sol";

/// @dev Drives random, correctly-pranked sequences of every AgentTreasury action so the
///      invariant engine can search for a state that breaks a money-safety property.
///      Reverts are swallowed (try/catch) so the fuzzer keeps exploring deeper sequences.
///
///      Ghost accounting lets us assert the properties that matter for a vault:
///        1. Conservation — every USDC unit that left the vault is accounted for.
///        2. The per-window cap can never be bypassed / drained.
///        3. A spend / fundOperator can NEVER succeed while paused or while the
///           LegalManager is non-Active.
contract Handler is Test {
    AgentTreasury public vault;
    MockUSDC public usdc;
    MockLegalManagerStatus public legal;

    address public immutable manager;
    address public immutable guardian;
    address public immutable operator;
    address internal constant PAYEE = address(uint160(0xBEEF));

    // ── ghost state ──────────────────────────────────────────────────────────
    uint256 public ghostTotalIn;   // every USDC unit ever minted into the vault
    uint256 public ghostTotalOut;  // every USDC unit ever paid out (spend + fund + emergency)
    uint256 public capCeilingThisWindow; // max cap observed since the current window started
    bool    public sawGatedOutflow;      // set if any outflow succeeded while paused/non-Active

    bytes32 internal lastPolicyId; // most recently scheduled policy, so execute can land

    constructor(AgentTreasury vault_, MockUSDC usdc_, MockLegalManagerStatus legal_) {
        vault = vault_;
        usdc = usdc_;
        legal = legal_;
        manager = vault_.manager();
        guardian = vault_.guardian();
        operator = vault_.operator();
        capCeilingThisWindow = vault_.cap();
    }

    /// @dev Record an outflow and keep the per-window cap ceiling consistent with any
    ///      lazy window reset that happened inside `_useCap` during this call.
    function _afterOutflow(uint256 wsBefore, uint256 amount) internal {
        if (vault.windowStart() != wsBefore) capCeilingThisWindow = vault.cap(); // window reset
        if (vault.cap() > capCeilingThisWindow) capCeilingThisWindow = vault.cap();
        ghostTotalOut += amount;
    }

    function topUp(uint256 amount) external {
        amount = bound(amount, 0, 1_000_000e6);
        usdc.mint(address(vault), amount);
        ghostTotalIn += amount;
    }

    function spend(uint256 amount) external {
        uint256 c = vault.cap();
        amount = bound(amount, 1, c == 0 ? 1 : c + 1e6); // straddle the cap so CapExceeded is exercised too
        bool paused = vault.paused();
        bool inactive = legal.status() != 0;
        uint256 ws = vault.windowStart();
        vm.prank(operator);
        try vault.spend(PAYEE, amount) {
            _afterOutflow(ws, amount);
            if (paused || inactive) sawGatedOutflow = true;
        } catch {}
    }

    function fundOperator(uint256 amount) external {
        uint256 c = vault.cap();
        amount = bound(amount, 1, c == 0 ? 1 : c + 1e6);
        bool paused = vault.paused();
        bool inactive = legal.status() != 0;
        uint256 ws = vault.windowStart();
        vm.prank(operator);
        try vault.fundOperator(amount) {
            _afterOutflow(ws, amount);
            if (paused || inactive) sawGatedOutflow = true;
        } catch {}
    }

    function emergencyWithdraw() external {
        uint256 bal = usdc.balanceOf(address(vault));
        vm.prank(guardian);
        try vault.emergencyWithdraw() {
            ghostTotalOut += bal; // sweeps the full balance to payoutAddress
        } catch {}
    }

    function pause() external {
        vm.prank(guardian);
        try vault.pause() {} catch {}
    }

    function unpause() external {
        vm.prank(guardian);
        try vault.unpause() {} catch {}
    }

    function setAllowlistEntry(address a, bool ok) external {
        vm.prank(guardian);
        try vault.setAllowlistEntry(a, ok) {} catch {}
    }

    function setLegalStatus(uint8 s) external {
        legal.setStatus(uint8(bound(uint256(s), 0, 2)));
    }

    function schedulePolicy(uint256 newCap, uint256 newPeriod, bool allowlistOn) external {
        newCap = bound(newCap, 0, 10_000e6);
        newPeriod = bound(newPeriod, 1, 30 days);
        vm.prank(manager);
        try vault.schedulePolicyUpdate(newCap, newPeriod, allowlistOn, PAYEE) returns (bytes32 id) {
            lastPolicyId = id;
        } catch {}
    }

    function executePolicy() external {
        vm.prank(manager);
        try vault.executePolicyUpdate(lastPolicyId) {} catch {}
    }

    function vetoPolicy() external {
        vm.prank(guardian);
        try vault.vetoPolicyUpdate(lastPolicyId) {} catch {}
    }

    function liftVeto() external {
        vm.prank(guardian);
        try vault.liftVeto(lastPolicyId) {} catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 30 days));
    }
}

contract AgentTreasuryInvariantTest is StdInvariant, Test {
    AgentTreasury internal vault;
    MockUSDC internal usdc;
    MockLegalManagerStatus internal legal;
    Handler internal handler;

    address internal constant MANAGER  = address(0xA11CE);
    address internal constant GUARDIAN = address(0x60A12D);
    address internal constant OPERATOR = address(0x0EEEA7);
    address internal constant PAYOUT   = address(0xDEAD);

    uint256 internal constant CAP    = 500e6;
    uint256 internal constant PERIOD = 1 days;
    uint256 internal constant DELAY  = 2 days;
    uint256 internal constant SEED_BALANCE = 1_000_000e6;

    function setUp() public {
        usdc = new MockUSDC();
        legal = new MockLegalManagerStatus();
        vault = new AgentTreasury(
            address(usdc), address(legal), MANAGER, GUARDIAN, OPERATOR, PAYOUT,
            CAP, PERIOD, DELAY, false
        );

        handler = new Handler(vault, usdc, legal);
        handler.topUp(SEED_BALANCE); // seeds both the vault balance and ghostTotalIn in one place

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0]  = Handler.topUp.selector;
        selectors[1]  = Handler.spend.selector;
        selectors[2]  = Handler.fundOperator.selector;
        selectors[3]  = Handler.emergencyWithdraw.selector;
        selectors[4]  = Handler.pause.selector;
        selectors[5]  = Handler.unpause.selector;
        selectors[6]  = Handler.setAllowlistEntry.selector;
        selectors[7]  = Handler.setLegalStatus.selector;
        selectors[8]  = Handler.schedulePolicy.selector;
        selectors[9]  = Handler.executePolicy.selector;
        selectors[10] = Handler.vetoPolicy.selector;
        selectors[11] = Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// `available()` can never report more headroom than the configured cap.
    function invariant_availableNeverExceedsCap() public view {
        assertLe(vault.available(), vault.cap());
    }

    /// Conservation: every USDC unit is either still in the vault or accounted for as paid out.
    function invariant_conservation() public view {
        assertEq(usdc.balanceOf(address(vault)) + handler.ghostTotalOut(), handler.ghostTotalIn());
    }

    /// Within any spending window, recorded spend can never exceed the highest cap that was
    /// in effect during that window — i.e. the per-window cap can never be bypassed / drained.
    function invariant_spentWithinWindowCeiling() public view {
        assertLe(vault.spentInWindow(), handler.capCeilingThisWindow());
    }

    /// A spend or operator top-up must NEVER succeed while paused or while the body is non-Active.
    function invariant_noOutflowWhileGated() public view {
        assertFalse(handler.sawGatedOutflow());
    }

    /// Sanity: the handler genuinely moves funds, so the invariants above cannot pass vacuously
    /// (e.g. if every spend silently reverted). Drives one real spend end-to-end.
    function test_handlerMovesFundsNonVacuous() public {
        uint256 balBefore = usdc.balanceOf(address(vault));
        handler.spend(100e6);
        assertEq(handler.ghostTotalOut(), 100e6);
        assertEq(vault.spentInWindow(), 100e6);
        assertEq(usdc.balanceOf(address(vault)), balBefore - 100e6);
    }

    /// The vault's immutable wiring (roles + config that must never move) stays fixed forever.
    function invariant_immutablesUnchanged() public view {
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(vault.legalManager(), address(legal));
        assertEq(vault.manager(), MANAGER);
        assertEq(vault.guardian(), GUARDIAN);
        assertEq(vault.operator(), OPERATOR); // operator rotation is covered by unit tests, not driven here
        assertEq(vault.policyDelay(), DELAY);
    }
}
