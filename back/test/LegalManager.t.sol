// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Shared helper. LegalManager.constructor() calls _disableInitializers(),
///      so initialize() can only run through a proxy (the production path is a
///      BeaconProxy created by the Factory). Unit tests deploy behind an
///      ERC1967Proxy to exercise that same delegatecall/storage context.
abstract contract LegalManagerTestBase is Test {
    function _deploy(
        address manager_,
        address guardian_,
        uint256 amendmentDelay_,
        uint256 agentId_,
        string memory ein_,
        uint64 formationDate_,
        bytes32 oaHash_
    ) internal returns (LegalManager) {
        LegalManager impl = new LegalManager();
        bytes memory data = abi.encodeCall(
            LegalManager.initialize,
            (manager_, guardian_, amendmentDelay_, agentId_, ein_, formationDate_, oaHash_)
        );
        return LegalManager(payable(address(new ERC1967Proxy(address(impl), data))));
    }
}

contract LegalManagerInitTest is LegalManagerTestBase {
    LegalManager internal lm;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);

    function setUp() public {
        lm = _deploy(manager, guardian, 2 days, 42, "EIN-99-1234567", 1748476800, keccak256("oa-v1"));
    }

    function test_initialStateIsActive() public view {
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
    }

    function test_storesManagerGuardianAndDelay() public view {
        assertEq(lm.manager(), manager);
        assertEq(lm.guardian(), guardian);
        assertEq(lm.amendmentDelay(), 2 days);
    }

    function test_storesLegalMetadata() public view {
        (string memory ein, uint64 formationDate, bytes32 oaHash, uint256 agentId) = lm.meta();
        assertEq(ein, "EIN-99-1234567");
        assertEq(formationDate, 1748476800);
        assertEq(oaHash, keccak256("oa-v1"));
        assertEq(agentId, 42);
    }

    function test_cannotInitializeTwice() public {
        vm.expectRevert();
        lm.initialize(manager, guardian, 1 days, 1, "x", 1, bytes32(0));
    }

    /// @dev The constructor calls `_disableInitializers()`, so the logic contract itself can
    ///      never be initialized directly — initialization may only happen through a proxy's
    ///      delegatecall storage context. This pins that security property (an un-disabled
    ///      implementation is a classic proxy-takeover footgun).
    function test_implementationIsLockedAgainstInitialize() public {
        LegalManager impl = new LegalManager();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(manager, guardian, 1 days, 1, "x", 1, bytes32(0));
    }

    /// @dev Deploys the impl up-front, then asserts the *proxy* creation (which runs
    ///      initialize) reverts — so vm.expectRevert targets the right call.
    function _expectInitRevert(
        bytes4 err,
        address manager_,
        address guardian_,
        uint256 delay_
    ) internal {
        LegalManager impl = new LegalManager();
        bytes memory data = abi.encodeCall(
            LegalManager.initialize,
            (manager_, guardian_, delay_, 1, "x", 1, bytes32(0))
        );
        vm.expectRevert(err);
        new ERC1967Proxy(address(impl), data);
    }

    function test_rejectsZeroManager() public {
        _expectInitRevert(LegalManager.ZeroAddress.selector, address(0), guardian, 1 days);
    }

    function test_rejectsZeroGuardian() public {
        _expectInitRevert(LegalManager.ZeroAddress.selector, manager, address(0), 1 days);
    }

    function test_rejectsSameManagerAndGuardian() public {
        _expectInitRevert(LegalManager.RolesMustDiffer.selector, manager, manager, 1 days);
    }

    function test_rejectsDelayBelowFloor() public {
        _expectInitRevert(
            LegalManager.DelayTooShort.selector, manager, guardian, lm.MIN_AMENDMENT_DELAY() - 1
        );
    }

    function test_acceptsDelayAtFloor() public {
        LegalManager m = _deploy(manager, guardian, lm.MIN_AMENDMENT_DELAY(), 1, "x", 1, bytes32(0));
        assertEq(m.amendmentDelay(), m.MIN_AMENDMENT_DELAY());
    }
}

contract LegalManagerAmendTest is LegalManagerTestBase {
    LegalManager internal lm;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);
    address internal stranger = address(0xBAD);

    function setUp() public {
        lm = _deploy(manager, guardian, 2 days, 1, "EIN", 1, keccak256("oa-v1"));
    }

    function test_managerSchedulesAndExecutesAfterDelay() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);

        vm.warp(block.timestamp + 2 days);
        vm.prank(manager);
        lm.executeOperatingAgreementUpdate(newHash);

        (, , bytes32 oaHash, ) = lm.meta();
        assertEq(oaHash, newHash);
    }

    function test_cannotExecuteBeforeDelay() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);

        vm.prank(manager);
        vm.expectRevert(LegalManager.TooEarly.selector);
        lm.executeOperatingAgreementUpdate(newHash);
    }

    function test_cannotExecuteUnscheduled() public {
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotScheduled.selector);
        lm.executeOperatingAgreementUpdate(keccak256("never"));
    }

    function test_strangerCannotSchedule() public {
        vm.prank(stranger);
        vm.expectRevert(LegalManager.NotManager.selector);
        lm.scheduleOperatingAgreementUpdate(keccak256("x"));
    }

    function test_strangerCannotExecute() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);
        vm.warp(block.timestamp + 2 days);
        vm.prank(stranger);
        vm.expectRevert(LegalManager.NotManager.selector);
        lm.executeOperatingAgreementUpdate(newHash);
    }

    function test_strangerCannotVeto() public {
        vm.prank(stranger);
        vm.expectRevert(LegalManager.NotGuardian.selector);
        lm.cancelOperatingAgreementUpdate(keccak256("x"));
    }

    // --- Hard veto semantics (M2) ---

    function test_guardianVetoBlocksExecution() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);

        vm.prank(guardian);
        lm.cancelOperatingAgreementUpdate(newHash);

        vm.warp(block.timestamp + 2 days);
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotScheduled.selector);
        lm.executeOperatingAgreementUpdate(newHash);
    }

    function test_vetoedHashCannotBeRescheduled() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);
        vm.prank(guardian);
        lm.cancelOperatingAgreementUpdate(newHash);

        // Manager tries to re-push the same vetoed hash: hard veto must block it.
        vm.prank(manager);
        vm.expectRevert(LegalManager.Vetoed.selector);
        lm.scheduleOperatingAgreementUpdate(newHash);
    }

    function test_guardianCanLiftVetoToReallow() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);
        vm.prank(guardian);
        lm.cancelOperatingAgreementUpdate(newHash);

        vm.prank(guardian);
        lm.liftVeto(newHash);

        // Now manager can reschedule and execute.
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);
        vm.warp(block.timestamp + 2 days);
        vm.prank(manager);
        lm.executeOperatingAgreementUpdate(newHash);
        (, , bytes32 oaHash, ) = lm.meta();
        assertEq(oaHash, newHash);
    }

    function test_strangerCannotLiftVeto() public {
        vm.prank(stranger);
        vm.expectRevert(LegalManager.NotGuardian.selector);
        lm.liftVeto(keccak256("x"));
    }

    /// Audit hygiene fix: lifting a veto that was never set reverts, so VetoLifted events
    /// always correspond to a real prior veto.
    function test_liftVetoRevertsIfNotVetoed() public {
        vm.prank(guardian);
        vm.expectRevert(LegalManager.NotVetoed.selector);
        lm.liftVeto(keccak256("never-vetoed"));
    }
}

contract LegalManagerDissolveTest is LegalManagerTestBase {
    LegalManager internal lm;
    MockUSDC internal usdc;
    MockUSDC internal eurc;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);
    address internal treasury = address(0x7EA);
    uint256 internal constant DELAY = 2 days;

    function setUp() public {
        lm = _deploy(manager, guardian, DELAY, 1, "EIN", 1, keccak256("oa-v1"));
        usdc = new MockUSDC();
        eurc = new MockUSDC();
        usdc.mint(address(lm), 1_000_000); // 1.0 USDC (6 decimals)
        eurc.mint(address(lm), 2_000_000); // 2.0 EURC
    }

    // initiate by guardian, then wait out the timelock window
    function _windDown() internal {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.warp(block.timestamp + DELAY);
    }

    // --- initiation ---

    function test_initiateWindsDownAndSetsTimelock() public {
        uint256 t0 = block.timestamp;
        vm.prank(guardian);
        lm.initiateDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.WindingDown));
        assertEq(lm.dissolutionExecutableAt(), t0 + DELAY);
        assertEq(lm.dissolutionInitiator(), guardian);
    }

    function test_managerCanAlsoInitiate() public {
        vm.prank(manager);
        lm.initiateDissolution();
        assertEq(lm.dissolutionInitiator(), manager);
    }

    function test_strangerCannotInitiate() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.initiateDissolution();
    }

    function test_cannotInitiateTwice() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotActive.selector);
        lm.initiateDissolution();
    }

    function test_amendmentsBlockedAfterWindingDown() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotActive.selector);
        lm.scheduleOperatingAgreementUpdate(keccak256("x"));
    }

    // --- non-initiator veto (the "guardian veto" of dissolution) ---

    function test_managerVetoesGuardianInitiatedDissolution() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.prank(manager); // the role that did NOT initiate
        lm.cancelDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
        assertEq(lm.dissolutionExecutableAt(), 0);
        assertEq(lm.dissolutionInitiator(), address(0));
    }

    function test_guardianVetoesManagerInitiatedDissolution() public {
        vm.prank(manager);
        lm.initiateDissolution();
        vm.prank(guardian);
        lm.cancelDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
    }

    function test_amendmentsResumeAfterVeto() public {
        vm.prank(manager);
        lm.initiateDissolution();
        vm.prank(guardian);
        lm.cancelDissolution();
        // back to Active: amendments work again
        bytes32 h = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(h);
        vm.warp(block.timestamp + DELAY);
        vm.prank(manager);
        lm.executeOperatingAgreementUpdate(h);
        (, , bytes32 oa, ) = lm.meta();
        assertEq(oa, h);
    }

    function test_initiatorCannotVetoOwnDissolution() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.prank(guardian); // initiator cannot veto itself
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.cancelDissolution();
    }

    function test_strangerCannotVeto() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.prank(address(0xBAD));
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.cancelDissolution();
    }

    function test_cannotVetoWhenActive() public {
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotWindingDown.selector);
        lm.cancelDissolution();
    }

    // --- timelock enforcement on sweep + finalize ---

    function test_cannotSweepBeforeWindow() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.prank(manager);
        vm.expectRevert(LegalManager.TooEarly.selector);
        lm.sweep(tokens, treasury);
    }

    function test_cannotSweepNativeBeforeWindow() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.deal(address(lm), 1 ether);
        vm.prank(manager);
        vm.expectRevert(LegalManager.TooEarly.selector);
        lm.sweepNative(treasury);
    }

    function test_cannotFinalizeBeforeWindow() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.prank(manager);
        vm.expectRevert(LegalManager.TooEarly.selector);
        lm.finalizeDissolution();
    }

    // --- sweeping (after the window) ---

    function test_sweepMultipleTokens() public {
        _windDown();
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(eurc);

        vm.prank(manager);
        lm.sweep(tokens, treasury);

        assertEq(usdc.balanceOf(treasury), 1_000_000);
        assertEq(eurc.balanceOf(treasury), 2_000_000);
        assertEq(usdc.balanceOf(address(lm)), 0);
        assertEq(eurc.balanceOf(address(lm)), 0);
    }

    function test_sweepIsRepeatableBeforeFinalize() public {
        _windDown();
        address[] memory one = new address[](1);
        one[0] = address(usdc);
        vm.prank(manager);
        lm.sweep(one, treasury);

        eurc.mint(address(lm), 500_000); // more arrives after the first sweep
        address[] memory two = new address[](1);
        two[0] = address(eurc);
        vm.prank(manager);
        lm.sweep(two, treasury);

        assertEq(usdc.balanceOf(treasury), 1_000_000);
        assertEq(eurc.balanceOf(treasury), 2_500_000);
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.WindingDown));
    }

    function test_sweepNative() public {
        _windDown();
        vm.deal(address(lm), 5 ether);
        vm.prank(manager);
        lm.sweepNative(treasury);
        assertEq(treasury.balance, 5 ether);
        assertEq(address(lm).balance, 0);
    }

    function test_strangerCannotSweep() public {
        _windDown();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.prank(address(0xBAD));
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.sweep(tokens, treasury);
    }

    /// Audit hardening (finding 3): the guardian may also sweep, so residual assets are recoverable
    /// even if the manager key is lost (manager/guardian symmetry, matching initiate/finalize).
    function test_guardianCanSweep() public {
        _windDown();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.prank(guardian);
        lm.sweep(tokens, treasury);
        assertEq(usdc.balanceOf(treasury), 1_000_000);
        assertEq(usdc.balanceOf(address(lm)), 0);
    }

    function test_guardianCanSweepNative() public {
        _windDown();
        vm.deal(address(lm), 4 ether);
        vm.prank(guardian);
        lm.sweepNative(treasury);
        assertEq(treasury.balance, 4 ether);
        assertEq(address(lm).balance, 0);
    }

    function test_sweepRejectsZeroPayout() public {
        _windDown();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.prank(manager);
        vm.expectRevert(LegalManager.ZeroAddress.selector);
        lm.sweep(tokens, address(0));
    }

    function test_sweepNativeRejectsZeroPayout() public {
        _windDown();
        vm.deal(address(lm), 1 ether);
        vm.prank(manager);
        vm.expectRevert(LegalManager.ZeroAddress.selector);
        lm.sweepNative(address(0));
    }

    function test_cannotSweepWhileActive() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotDissolving.selector); // sweeps blocked until dissolution begins
        lm.sweep(tokens, treasury);
    }

    function test_cannotSweepNativeWhileActive() public {
        vm.deal(address(lm), 1 ether);
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotDissolving.selector);
        lm.sweepNative(treasury);
    }

    // --- finalize (after the window) ---

    function test_finalizeMarksDissolved() public {
        _windDown();
        vm.prank(manager);
        lm.finalizeDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Dissolved));
    }

    function test_eitherRoleCanFinalizeAfterWindow() public {
        _windDown();
        vm.prank(guardian); // non-manager authorized role may finalize too
        lm.finalizeDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Dissolved));
    }

    function test_strangerCannotFinalize() public {
        _windDown();
        vm.prank(address(0xBAD));
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.finalizeDissolution();
    }

    function test_cannotFinalizeWhileActive() public {
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotWindingDown.selector);
        lm.finalizeDissolution();
    }

    /// Audit fix (finding 1): sweeps remain possible AFTER finalize so residual/late-arriving
    /// assets can never be permanently stranded by finalizing before a sweep.
    function test_sweepAllowedAfterFinalizeRecoversResidualAssets() public {
        _windDown();
        vm.prank(manager);
        lm.finalizeDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Dissolved));

        // ERC-20 that was already held is still recoverable post-dissolution.
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.prank(manager);
        lm.sweep(tokens, treasury);
        assertEq(usdc.balanceOf(treasury), 1_000_000);
        assertEq(usdc.balanceOf(address(lm)), 0);
    }

    /// Native (USDC-as-gas on Arc) that arrives AFTER dissolution is still recoverable.
    function test_sweepNativeAllowedAfterFinalizeRecoversLateFunds() public {
        _windDown();
        vm.prank(manager);
        lm.finalizeDissolution();

        vm.deal(address(lm), 3 ether); // funds land after the body is already Dissolved
        vm.prank(manager);
        lm.sweepNative(treasury);
        assertEq(treasury.balance, 3 ether);
        assertEq(address(lm).balance, 0);
    }

    /// Only an authorized role may sweep post-dissolution; a stranger still cannot.
    function test_strangerCannotSweepAfterFinalize() public {
        _windDown();
        vm.prank(manager);
        lm.finalizeDissolution();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.prank(address(0xBAD));
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.sweep(tokens, treasury);
    }

    function test_cannotFinalizeTwice() public {
        _windDown();
        vm.prank(manager);
        lm.finalizeDissolution();
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotWindingDown.selector);
        lm.finalizeDissolution();
    }

    function test_cannotVetoAfterFinalize() public {
        _windDown();
        vm.prank(manager);
        lm.finalizeDissolution();
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotWindingDown.selector);
        lm.cancelDissolution();
    }
}
