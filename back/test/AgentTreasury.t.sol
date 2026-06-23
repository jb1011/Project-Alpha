// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockLegalManagerStatus} from "./mocks/MockLegalManagerStatus.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

abstract contract AgentTreasuryTestBase is Test {
    MockUSDC internal usdc;
    MockLegalManagerStatus internal legal;
    AgentTreasury internal vault;

    address internal manager  = makeAddr("manager");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal payout   = makeAddr("payout");

    uint256 internal constant CAP    = 500e6;   // 500 USDC
    uint256 internal constant PERIOD = 1 days;
    uint256 internal constant DELAY  = 2 days;

    function _deploy() internal returns (AgentTreasury) {
        return new AgentTreasury(
            address(usdc), address(legal), manager, guardian, operator, payout,
            CAP, PERIOD, DELAY, false
        );
    }

    function setUp() public virtual {
        usdc  = new MockUSDC();
        legal = new MockLegalManagerStatus();
        vault = _deploy();
        usdc.mint(address(vault), 10_000e6);
    }
}

contract AgentTreasuryInitTest is AgentTreasuryTestBase {
    function test_storesRolesAndConfig() public view {
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(vault.legalManager(), address(legal));
        assertEq(vault.manager(), manager);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.operator(), operator);
        assertEq(vault.payoutAddress(), payout);
        assertEq(vault.cap(), CAP);
        assertEq(vault.period(), PERIOD);
        assertEq(vault.policyDelay(), DELAY);
        assertEq(vault.allowlistEnabled(), false);
    }

    function test_initialWindowAndAvailable() public view {
        assertEq(vault.spentInWindow(), 0);
        assertEq(vault.available(), CAP);
        assertEq(vault.paused(), false);
    }
}

contract AgentTreasurySpendTest is AgentTreasuryTestBase {
    address internal payee = makeAddr("payee");

    event Spent(address indexed to, uint256 amount);

    function test_operatorCanSpendWithinCap() public {
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit Spent(payee, 100e6);
        vault.spend(payee, 100e6);
        assertEq(usdc.balanceOf(payee), 100e6);
        assertEq(vault.spentInWindow(), 100e6);
        assertEq(vault.available(), CAP - 100e6);
    }

    function test_nonOperatorCannotSpend() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        vault.spend(payee, 1e6);
    }

    function test_spendRevertsOverCap() public {
        vm.prank(operator);
        vault.spend(payee, CAP); // uses the whole cap
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.CapExceeded.selector);
        vault.spend(payee, 1);
    }

    function test_capResetsAfterPeriod() public {
        vm.prank(operator);
        vault.spend(payee, CAP);
        vm.warp(block.timestamp + PERIOD); // new window
        assertEq(vault.available(), CAP);
        vm.prank(operator);
        vault.spend(payee, CAP);
        assertEq(usdc.balanceOf(payee), 2 * CAP);
    }

    function test_spendRejectsZeroAddressAndZeroAmount() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        vault.spend(address(0), 1e6);
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.ZeroAmount.selector);
        vault.spend(payee, 0);
    }
}

contract AgentTreasuryFundOperatorTest is AgentTreasuryTestBase {
    event OperatorFunded(address indexed operator, uint256 amount);

    function test_fundOperatorTransfersToOperatorAndUsesCap() public {
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit OperatorFunded(operator, 200e6);
        vault.fundOperator(200e6);
        assertEq(usdc.balanceOf(operator), 200e6);
        assertEq(vault.available(), CAP - 200e6);
    }

    function test_fundOperatorShareSameCapAsSpend() public {
        vm.prank(operator);
        vault.fundOperator(CAP - 50e6);
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.CapExceeded.selector);
        vault.spend(makeAddr("p"), 51e6);
    }

    function test_onlyOperatorFunds() public {
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        vault.fundOperator(1e6);
    }

    function test_fundOperatorRejectsZeroAmount() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.ZeroAmount.selector);
        vault.fundOperator(0);
    }
}

contract AgentTreasuryPauseLockTest is AgentTreasuryTestBase {
    address internal payee = makeAddr("payee2");

    function test_guardianPauseBlocksSpend() public {
        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.IsPaused.selector);
        vault.spend(payee, 1e6);
    }

    function test_guardianUnpauseRestoresSpend() public {
        vm.prank(guardian);
        vault.pause();
        vm.prank(guardian);
        vault.unpause();
        vm.prank(operator);
        vault.spend(payee, 1e6);
        assertEq(usdc.balanceOf(payee), 1e6);
    }

    function test_onlyGuardianPauses() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotGuardian.selector);
        vault.pause();
    }

    function test_dissolutionBlocksSpendAndFund() public {
        legal.setStatus(1); // WindingDown
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.LegalNotActive.selector);
        vault.spend(payee, 1e6);
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.LegalNotActive.selector);
        vault.fundOperator(1e6);
    }
}

contract AgentTreasuryGuardianPowersTest is AgentTreasuryTestBase {
    address internal newOp = makeAddr("newOperator");

    event OperatorRotated(address indexed previous, address indexed next);
    event EmergencyWithdrawn(address indexed payoutAddress, uint256 amount);

    function test_guardianRotatesOperator() public {
        vm.prank(guardian);
        vm.expectEmit(true, true, false, false);
        emit OperatorRotated(operator, newOp);
        vault.setOperator(newOp);
        assertEq(vault.operator(), newOp);
        // old operator can no longer spend
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        vault.spend(makeAddr("x"), 1e6);
    }

    function test_setOperatorRejectsZero() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        vault.setOperator(address(0));
    }

    // ── Audit hardening (finding 1): setOperator must preserve the constructor's role
    //    distinctness — a rotation can't collapse operator into manager/guardian/payout. ──

    function test_setOperatorRejectsManager() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.RolesMustDiffer.selector);
        vault.setOperator(manager);
    }

    function test_setOperatorRejectsGuardian() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.RolesMustDiffer.selector);
        vault.setOperator(guardian);
    }

    /// Rotating operator onto the payout sink would mean emergencyWithdraw funds the agent's key.
    function test_setOperatorRejectsPayout() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.RolesMustDiffer.selector);
        vault.setOperator(payout);
    }

    function test_emergencyWithdrawSweepsToPayout() public {
        uint256 bal = usdc.balanceOf(address(vault));
        vm.prank(guardian);
        vm.expectEmit(true, false, false, true);
        emit EmergencyWithdrawn(payout, bal);
        vault.emergencyWithdraw();
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(payout), bal);
    }

    function test_onlyGuardianEmergencyWithdraw() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotGuardian.selector);
        vault.emergencyWithdraw();
    }

    function test_guardianManagesAllowlist() public {
        address ok = makeAddr("ok");
        vm.prank(guardian);
        vault.setAllowlistEntry(ok, true);
        assertTrue(vault.isAllowed(ok));
        vm.prank(guardian);
        vault.setAllowlistEntry(ok, false);
        assertFalse(vault.isAllowed(ok));
    }
}

contract AgentTreasuryAllowlistTest is AgentTreasuryTestBase {
    function setUp() public override {
        super.setUp();
        // redeploy with allowlist enabled
        vault = new AgentTreasury(
            address(usdc), address(legal), manager, guardian, operator, payout,
            CAP, PERIOD, DELAY, true
        );
        usdc.mint(address(vault), 10_000e6);
    }

    function test_spendBlockedForNonAllowlisted() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotAllowed.selector);
        vault.spend(makeAddr("stranger"), 1e6);
    }

    function test_spendAllowedAfterGuardianAllowlists() public {
        address ok = makeAddr("ok");
        vm.prank(guardian);
        vault.setAllowlistEntry(ok, true);
        vm.prank(operator);
        vault.spend(ok, 1e6);
        assertEq(usdc.balanceOf(ok), 1e6);
    }

    function test_fundOperatorExemptFromAllowlist() public {
        vm.prank(operator);
        vault.fundOperator(5e6); // operator not on allowlist, still allowed
        assertEq(usdc.balanceOf(operator), 5e6);
    }
}

contract AgentTreasuryPolicyTest is AgentTreasuryTestBase {
    address internal newPayout = makeAddr("newPayout");

    function _schedule() internal returns (bytes32) {
        vm.prank(manager);
        return vault.schedulePolicyUpdate(1000e6, 12 hours, true, newPayout);
    }

    function test_executeAfterDelayAppliesNewPolicy() public {
        bytes32 id = _schedule();
        vm.warp(block.timestamp + DELAY);
        vm.prank(manager);
        vault.executePolicyUpdate(id);
        assertEq(vault.cap(), 1000e6);
        assertEq(vault.period(), 12 hours);
        assertTrue(vault.allowlistEnabled());
        assertEq(vault.payoutAddress(), newPayout);
    }

    function test_executeBeforeDelayReverts() public {
        bytes32 id = _schedule();
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.TooEarly.selector);
        vault.executePolicyUpdate(id);
    }

    function test_guardianVetoBlocksExecute() public {
        bytes32 id = _schedule();
        vm.prank(guardian);
        vault.vetoPolicyUpdate(id);
        // Veto deletes the pending entry — execute now reverts NotScheduled, not PolicyVetoed.
        vm.warp(block.timestamp + DELAY);
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.NotScheduled.selector);
        vault.executePolicyUpdate(id);
    }

    function test_onlyManagerSchedules() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotManager.selector);
        vault.schedulePolicyUpdate(1, 1, false, newPayout);
    }

    function test_scheduleRejectsZeroPayoutAndZeroPeriod() public {
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        vault.schedulePolicyUpdate(1, 1, false, address(0));
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.ZeroAmount.selector);
        vault.schedulePolicyUpdate(1, 0, false, newPayout);
    }

    /// Audit hardening (finding 2): a policy period above the cap is rejected at schedule time.
    function test_scheduleRejectsPeriodTooLong() public {
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.PeriodTooLong.selector);
        vault.schedulePolicyUpdate(1000e6, 365 days + 1, false, newPayout);
    }

    /// Audit hardening (finding 1): a policy may schedule payout == operator (the operator can
    /// rotate before execution), but executing while payout still equals the operator is rejected,
    /// preserving the constructor's `payout != operator` invariant. The guardian can also veto it.
    function test_executeRejectsPayoutEqualsOperator() public {
        vm.prank(manager);
        bytes32 id = vault.schedulePolicyUpdate(1000e6, 12 hours, false, operator);
        vm.warp(block.timestamp + DELAY);
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.RolesMustDiffer.selector);
        vault.executePolicyUpdate(id);
        // payout/cap unchanged — the bad policy did not apply.
        assertEq(vault.payoutAddress(), payout);
        assertEq(vault.cap(), CAP);
    }

    /// The same policy becomes executable once the operator is rotated away from the payout target.
    function test_executePayoutAllowedAfterOperatorRotated() public {
        vm.prank(manager);
        bytes32 id = vault.schedulePolicyUpdate(1000e6, 12 hours, false, operator);
        // Guardian rotates the operator to a fresh key, so payout (== old operator) is now distinct.
        address oldOperator = operator;
        vm.prank(guardian);
        vault.setOperator(makeAddr("rotatedOperator"));
        vm.warp(block.timestamp + DELAY);
        vm.prank(manager);
        vault.executePolicyUpdate(id);
        assertEq(vault.payoutAddress(), oldOperator);
        assertEq(vault.cap(), 1000e6);
    }
}

// ── Constructor validation ────────────────────────────────────────────────────

contract AgentTreasuryConstructorValidationTest is AgentTreasuryTestBase {
    address internal u    = makeAddr("usdc_ctor");
    address internal lm_  = makeAddr("lm_ctor");
    address internal mgr  = makeAddr("mgr_ctor");
    address internal grd  = makeAddr("grd_ctor");
    address internal op_  = makeAddr("op_ctor");
    address internal pay_ = makeAddr("pay_ctor");

    function _make(
        address usdc_, address lm__, address mgr_, address grd_, address op__, address pay__,
        uint256 period_, uint256 delay_
    ) internal returns (AgentTreasury) {
        return new AgentTreasury(usdc_, lm__, mgr_, grd_, op__, pay__, 500e6, period_, delay_, false);
    }

    function test_rejectsZeroUsdc() public {
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        _make(address(0), lm_, mgr, grd, op_, pay_, PERIOD, DELAY);
    }

    function test_rejectsZeroLegalManager() public {
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        _make(u, address(0), mgr, grd, op_, pay_, PERIOD, DELAY);
    }

    function test_rejectsZeroPayoutAddress() public {
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        _make(u, lm_, mgr, grd, op_, address(0), PERIOD, DELAY);
    }

    function test_rejectsManagerEqualsGuardian() public {
        vm.expectRevert(AgentTreasury.RolesMustDiffer.selector);
        _make(u, lm_, mgr, mgr, op_, pay_, PERIOD, DELAY);
    }

    function test_rejectsManagerEqualsOperator() public {
        vm.expectRevert(AgentTreasury.RolesMustDiffer.selector);
        _make(u, lm_, mgr, grd, mgr, pay_, PERIOD, DELAY);
    }

    function test_rejectsGuardianEqualsOperator() public {
        vm.expectRevert(AgentTreasury.RolesMustDiffer.selector);
        _make(u, lm_, mgr, grd, grd, pay_, PERIOD, DELAY);
    }

    function test_rejectsDelayTooShort() public {
        vm.expectRevert(AgentTreasury.DelayTooShort.selector);
        _make(u, lm_, mgr, grd, op_, pay_, PERIOD, 1 minutes);
    }

    function test_rejectsZeroPeriod() public {
        vm.expectRevert(AgentTreasury.ZeroAmount.selector);
        _make(u, lm_, mgr, grd, op_, pay_, 0, DELAY);
    }

    // ── Audit hardening (finding 2 & 3) ──────────────────────────────────────

    /// payout must not be the operator: otherwise emergencyWithdraw would dump funds straight
    /// back to the agent's hot key, defeating the bounded-override design.
    function test_rejectsPayoutEqualsOperator() public {
        vm.expectRevert(AgentTreasury.RolesMustDiffer.selector);
        new AgentTreasury(u, address(legal), mgr, grd, op_, op_, 500e6, PERIOD, DELAY, false);
    }

    /// period above MAX_POLICY_PERIOD is rejected (prevents windowStart+period overflow brick).
    function test_rejectsPeriodTooLong() public {
        vm.expectRevert(AgentTreasury.PeriodTooLong.selector);
        _make(u, address(legal), mgr, grd, op_, pay_, 365 days + 1, DELAY);
    }

    /// legalManager must be a contract (an EOA would revert every spend via the status() call).
    function test_rejectsNonContractLegalManager() public {
        vm.expectRevert(AgentTreasury.NotAContract.selector);
        _make(u, lm_, mgr, grd, op_, pay_, PERIOD, DELAY); // lm_ is an EOA (makeAddr)
    }

    /// Boundary: a period exactly at MAX_POLICY_PERIOD is accepted.
    function test_acceptsPeriodAtMax() public {
        AgentTreasury t =
            new AgentTreasury(address(usdc), address(legal), mgr, grd, op_, pay_, 500e6, 365 days, DELAY, false);
        assertEq(t.period(), 365 days);
        assertEq(t.MAX_POLICY_PERIOD(), 365 days);
    }
}

// ── Policy negative / sticky-veto paths ──────────────────────────────────────

contract AgentTreasuryPolicyStickyVetoTest is AgentTreasuryTestBase {
    address internal newPayout = makeAddr("newPayoutSV");

    event PolicyUpdateVetoed(bytes32 indexed policyId);
    event VetoLifted(bytes32 indexed policyId);
    event PolicyUpdateScheduled(
        bytes32 indexed policyId, uint256 cap, uint256 period, bool allowlistOn, address payoutAddress, uint256 executableAt
    );

    function _schedule() internal returns (bytes32) {
        vm.prank(manager);
        return vault.schedulePolicyUpdate(1000e6, 12 hours, true, newPayout);
    }

    // Schedule same tuple twice → AlreadyScheduled
    function test_scheduleTwiceSameTupleReverts() public {
        _schedule();
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.AlreadyScheduled.selector);
        vault.schedulePolicyUpdate(1000e6, 12 hours, true, newPayout);
    }

    // Veto then re-schedule same tuple → PolicyVetoed
    function test_vetoThenRescheduleReverts() public {
        bytes32 id = _schedule();
        vm.prank(guardian);
        vault.vetoPolicyUpdate(id);
        assertTrue(vault.policyVetoed(id));
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.PolicyVetoed.selector);
        vault.schedulePolicyUpdate(1000e6, 12 hours, true, newPayout);
    }

    // LiftVeto then reschedule → succeeds
    function test_liftVetoAllowsReschedule() public {
        bytes32 id = _schedule();
        vm.prank(guardian);
        vault.vetoPolicyUpdate(id);
        vm.prank(guardian);
        vault.liftVeto(id);
        assertFalse(vault.policyVetoed(id));
        // Must succeed (no revert)
        vm.prank(manager);
        vault.schedulePolicyUpdate(1000e6, 12 hours, true, newPayout);
    }

    // vetoPolicyUpdate on unscheduled id → NotScheduled
    function test_vetoUnscheduledReverts() public {
        bytes32 id = keccak256(abi.encode(uint256(9999), uint256(1 days), false, newPayout));
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.NotScheduled.selector);
        vault.vetoPolicyUpdate(id);
    }

    // executePolicyUpdate on unscheduled id → NotScheduled
    function test_executeUnscheduledReverts() public {
        bytes32 id = keccak256(abi.encode(uint256(9999), uint256(1 days), false, newPayout));
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.NotScheduled.selector);
        vault.executePolicyUpdate(id);
    }

    // liftVeto can only be called by guardian
    function test_liftVetoOnlyGuardian() public {
        bytes32 id = _schedule();
        vm.prank(guardian);
        vault.vetoPolicyUpdate(id);
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.NotGuardian.selector);
        vault.liftVeto(id);
    }

    // vetoPolicyUpdate: only guardian
    function test_vetoPolicyUpdateOnlyGuardian() public {
        bytes32 id = _schedule();
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.NotGuardian.selector);
        vault.vetoPolicyUpdate(id);
    }

    // executePolicyUpdate: only manager
    function test_executePolicyUpdateOnlyManager() public {
        bytes32 id = _schedule();
        vm.warp(block.timestamp + DELAY);
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.NotManager.selector);
        vault.executePolicyUpdate(id);
    }

    // schedulePolicyUpdate: only manager (not guardian or operator)
    function test_schedulePolicyUpdateOnlyManager_guardian() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.NotManager.selector);
        vault.schedulePolicyUpdate(1000e6, 12 hours, true, newPayout);
    }

    // VetoLifted event is emitted by liftVeto
    function test_liftVetoEmitsEvent() public {
        bytes32 id = _schedule();
        vm.prank(guardian);
        vault.vetoPolicyUpdate(id);
        vm.prank(guardian);
        vm.expectEmit(true, false, false, false);
        emit VetoLifted(id);
        vault.liftVeto(id);
    }

    // Audit hygiene fix: lifting a veto that was never set reverts.
    function test_liftVetoRevertsIfNotVetoed() public {
        bytes32 id = keccak256(abi.encode(uint256(1), uint256(1 days), false, newPayout));
        assertFalse(vault.policyVetoed(id));
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.NotVetoed.selector);
        vault.liftVeto(id);
    }
}

// ── fundOperator: paused path ─────────────────────────────────────────────────

contract AgentTreasuryFundOperatorPausedTest is AgentTreasuryTestBase {
    function test_fundOperatorRevertsWhenPaused() public {
        vm.prank(guardian);
        vault.pause();
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.IsPaused.selector);
        vault.fundOperator(1e6);
    }
}

// ── setAllowlistEntry: zero address ──────────────────────────────────────────

contract AgentTreasuryAllowlistZeroAddressTest is AgentTreasuryTestBase {
    function test_setAllowlistEntryRejectsZeroAddress() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        vault.setAllowlistEntry(address(0), true);
    }
}

// ── Reentrancy tests ──────────────────────────────────────────────────────────
//
// Design: to exercise nonReentrant (not just the role check), the vault is
// constructed so that the ReentrantToken address IS the authorised role.
// That way, when the token re-enters the vault from inside its own transfer
// hook, msg.sender == token == operator (or guardian), the role check passes,
// and the nonReentrant guard is what causes the revert.
//
// Role constraints (RolesMustDiffer): manager, guardian, operator must all
// differ. We fix the two non-token roles to distinct makeAddr() addresses.
//
// Non-vacuousness: if nonReentrant were removed, the re-entrant call would
// succeed (role check passes, legal/cap/balance all valid), so removing the
// modifier would make these tests fail.

contract AgentTreasuryReentrancyTest is Test {
    MockLegalManagerStatus internal legal;
    ReentrantToken internal evil;

    // Fixed role addresses that are NOT the token address.
    address internal mgr     = makeAddr("reentrancy_manager");
    address internal grd     = makeAddr("reentrancy_guardian");
    address internal op      = makeAddr("reentrancy_operator");
    address internal payee   = makeAddr("reentrancy_payee");
    address internal payoutAddr = makeAddr("reentrancy_payout");

    uint256 internal constant CAP    = 500e6;
    uint256 internal constant PERIOD = 1 days;
    uint256 internal constant DELAY  = 2 days;

    function setUp() public {
        legal = new MockLegalManagerStatus();
        evil  = new ReentrantToken();
    }

    /// @dev spend() reentrancy: vault.operator == address(evil).
    ///      Outer call: test pranks as evil (operator). During safeTransfer the
    ///      token re-enters vault.spend() — msg.sender == evil == operator,
    ///      so onlyOperator passes and nonReentrant reverts.
    function test_reentrantSpendIsBlocked() public {
        // operator is the token itself; manager and guardian are distinct non-token addresses
        AgentTreasury spendVault = new AgentTreasury(
            address(evil), address(legal),
            mgr,            // manager  (≠ evil, ≠ grd)
            grd,            // guardian (≠ evil, ≠ mgr)
            address(evil),  // operator == token address
            payoutAddr,
            CAP, PERIOD, DELAY, false
        );

        // Fund the vault so the outer spend() has tokens to transfer
        evil.mint(address(spendVault), 10_000e6);
        // Allowlist the payee so we don't hit NotAllowed
        // (allowlistEnabled is false by default, so no allowlist needed)

        // Arm: re-enter spend() with the same payee and a small amount
        evil.arm(address(spendVault), payee, 100e6, false);

        // Outer spend call: prank as evil == operator
        vm.prank(address(evil));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        spendVault.spend(payee, 100e6);

        // Entire tx reverted — vault balance unchanged
        assertEq(evil.balanceOf(address(spendVault)), 10_000e6);
        assertEq(evil.balanceOf(payee), 0);
    }

    /// @dev emergencyWithdraw() reentrancy: vault.guardian == address(evil).
    ///      Outer call: test pranks as evil (guardian). During safeTransfer the
    ///      token re-enters vault.emergencyWithdraw() — msg.sender == evil == guardian,
    ///      so onlyGuardian passes and nonReentrant reverts.
    function test_reentrantEmergencyWithdrawIsBlocked() public {
        // guardian is the token itself; manager and operator are distinct non-token addresses
        AgentTreasury ewVault = new AgentTreasury(
            address(evil), address(legal),
            mgr,            // manager  (≠ evil, ≠ op)
            address(evil),  // guardian == token address
            op,             // operator (≠ evil, ≠ mgr)
            address(evil),  // payoutAddress — emergencyWithdraw sends here; token address is fine
            CAP, PERIOD, DELAY, false
        );

        // Fund the vault
        evil.mint(address(ewVault), 10_000e6);

        // Arm: re-enter emergencyWithdraw
        evil.arm(address(ewVault), address(0), 0, true);

        // Outer emergencyWithdraw call: prank as evil == guardian
        vm.prank(address(evil));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ewVault.emergencyWithdraw();

        // Entire tx reverted — vault balance unchanged
        assertEq(evil.balanceOf(address(ewVault)), 10_000e6);
    }
}
