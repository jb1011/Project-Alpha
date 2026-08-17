// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ControllerRelayHarness} from "./helpers/ControllerRelayHarness.sol";
import {NoviController} from "../src/NoviController.sol";
import {BreakGlassOneShot} from "../src/BreakGlassOneShot.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockLegalManagerStatus} from "./mocks/MockLegalManagerStatus.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @dev Generic relay target. Deliberately exercises every shape the relay must preserve:
///      no-arg calls (the 24-byte minimum), value-returning calls, dynamic returns, custom-error
///      reverts, and a caller-recording write so tests can prove `msg.sender == controller`.
contract Echo {
    error Boom(uint256 code, address who);

    address public lastCaller;
    uint256 public lastX;
    uint256 public counter;

    function ping(uint256 x) external returns (uint256) {
        lastCaller = msg.sender;
        lastX = x;
        return x * 2;
    }

    function noArgs() external returns (uint256) {
        lastCaller = msg.sender;
        return 42;
    }

    /// @dev State-free so gas measurements are not dominated by a cold SSTORE.
    function touch() external pure returns (bool) {
        return true;
    }

    function blob() external pure returns (bytes memory) {
        return hex"deadbeefcafe0123456789abcdef00112233445566778899aabbccddeeff00112233";
    }

    function boom(uint256 code) external view {
        revert Boom(code, msg.sender);
    }
}

/// @dev Shared fixture: a controller whose executor holds exactly the design §3 granted
///      selector set, plus real vaults so relayed reverts are genuine vault custom errors.
///      The relay mechanics themselves (wrapping, relaying, break-glass) come from
///      {ControllerRelayHarness}, which the live-state fork suite inherits too.
abstract contract ControllerTestBase is ControllerRelayHarness {
    Echo internal echo;
    MockUSDC internal usdc;
    MockLegalManagerStatus internal legal;

    /// @dev manager == controller: the production shape (relayed policy ops land here).
    AgentTreasury internal vault;
    /// @dev operator == controller: test-only wiring used to make a REAL `CapExceeded`
    ///      travel back through the relay. `spend` is never granted in production.
    AgentTreasury internal opVault;

    address internal stranger = makeAddr("stranger");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal payout = makeAddr("payout");
    address internal otherManager = makeAddr("otherManager");

    /// @dev Cached in setUp: reading a public constant off the controller inside a pranked
    ///      statement would consume the prank (the getter is itself an external call).
    bytes32 internal WILDCARD;
    bytes32 internal ADMIN_ROLE;

    uint48 internal constant ADMIN_DELAY = 24 hours;
    uint256 internal constant CAP = 500e6;
    uint256 internal constant PERIOD = 1 days;
    uint256 internal constant POLICY_DELAY = 2 days;

    function setUp() public virtual {
        // No constructor pins in the base fixture: every relay target here is one of OUR audited
        // contracts, where coarse-across-targets is the intended semantics (design §3). The M5
        // pins are exercised in NoviControllerBoundTargetTest + the integration suite.
        (bytes4[] memory pinSelectors, address[] memory pinTargets) = _noPins();
        controller = new NoviController(ADMIN_DELAY, admin, executor, _grantedSelectors(), pinSelectors, pinTargets);
        WILDCARD = controller.WILDCARD_ROLE();
        ADMIN_ROLE = controller.DEFAULT_ADMIN_ROLE();
        echo = new Echo();
        usdc = new MockUSDC();
        legal = new MockLegalManagerStatus();

        vault = new AgentTreasury(
            address(usdc),
            address(legal),
            address(controller),
            guardian,
            operator,
            payout,
            CAP,
            PERIOD,
            POLICY_DELAY,
            false
        );
        opVault = new AgentTreasury(
            address(usdc),
            address(legal),
            otherManager,
            guardian,
            address(controller),
            payout,
            CAP,
            PERIOD,
            POLICY_DELAY,
            false
        );
        usdc.mint(address(vault), 10_000e6);
        usdc.mint(address(opVault), 10_000e6);
    }

    // ── selector sets ────────────────────────────────────────────────────

    /// @dev design §3: deliberately UNgranted — admin break-glass only. Still part of the
    ///      RELAYED set for disjointness purposes (they must route to the fallback).
    function _breakGlassSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](14);
        s[0] = LegalManager.initiateDissolution.selector;
        s[1] = LegalManager.cancelDissolution.selector;
        s[2] = LegalManager.sweep.selector;
        s[3] = LegalManager.sweepNative.selector;
        s[4] = LegalManager.finalizeDissolution.selector;
        s[5] = IIdentityRegistry.transferFrom.selector;
        // ERC-721 overloads / approvals cannot be reached via `.selector` (overload ambiguity),
        // so they are derived from the canonical signature strings, not hardcoded hex.
        s[6] = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        s[7] = bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
        s[8] = bytes4(keccak256("approve(address,uint256)"));
        s[9] = bytes4(keccak256("setApprovalForAll(address,bool)"));
        s[10] = UpgradeableBeacon.upgradeTo.selector;
        s[11] = Ownable.renounceOwnership.selector;
        s[12] = Ownable.transferOwnership.selector;
        s[13] = Ownable2Step.acceptOwnership.selector;
    }

    // ── the controller's own ABI, read from the compiled artifact ────────

    /// @dev The controller's LOCAL selector surface, loaded from the build artifact
    ///      (`methodIdentifiers` = the exact signature -> selector map solc emitted for THIS
    ///      compilation) instead of a hand-pinned list. A hand-pinned list can only ever be as
    ///      fresh as the last time someone re-ran `forge inspect`; this one cannot go stale, and
    ///      a function added to the controller shows up in the disjointness check immediately.
    ///      `test_everyRelayedSelectorRoutesToFallback` remains the behavioral backstop.
    function _localSelectors() internal view returns (bytes4[] memory s) {
        string memory artifact = vm.readFile("out/NoviController.sol/NoviController.json");
        string[] memory sigs = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        s = new bytes4[](sigs.length);
        for (uint256 i = 0; i < sigs.length; i++) {
            // The keys ARE canonical signatures, so the selector is their keccak prefix — the
            // same derivation solc used, not a re-transcribed hex value.
            s[i] = bytes4(keccak256(bytes(sigs[i])));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Role gating
// ─────────────────────────────────────────────────────────────────────────

contract NoviControllerRoleTest is ControllerTestBase {
    function test_deployGrantsEveryExecutorSelector() public view {
        bytes4[] memory s = _grantedSelectors();
        for (uint256 i = 0; i < s.length; i++) {
            assertTrue(controller.hasRole(bytes32(s[i]), executor), "executor missing granted selector");
        }
        assertEq(controller.defaultAdmin(), admin);
        assertEq(controller.defaultAdminDelay(), ADMIN_DELAY);
        // The partition the design relies on: wildcard is right-aligned, admin is zero.
        assertEq(WILDCARD, bytes32(uint256(1)));
        assertEq(ADMIN_ROLE, bytes32(0));
        // WILDCARD is granted to NO ONE at deploy (design §3).
        assertFalse(controller.hasRole(WILDCARD, executor));
        assertFalse(controller.hasRole(WILDCARD, admin));
    }

    function test_ungrantedSelectorReverts() public {
        (bool ok, bytes memory ret) = _relay(stranger, address(echo), abi.encodeCall(Echo.ping, (7)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, Echo.ping.selector, stranger));
    }

    function test_grantedSelectorRelaysWithControllerAsSender() public {
        _grant(Echo.ping.selector, executor);
        bytes memory ret = _relayOk(executor, address(echo), abi.encodeCall(Echo.ping, (21)));
        assertEq(abi.decode(ret, (uint256)), 42);
        assertEq(echo.lastCaller(), address(controller)); // the vault sees the controller, not the EOA
        assertEq(echo.lastX(), 21);
    }

    function test_grantedSelectorIsCoarseAcrossTargets() public {
        // Design §3: a granted selector works on EVERY (unbound) target — that IS the semantics.
        Echo second = new Echo();
        _grant(Echo.ping.selector, executor);
        _relayOk(executor, address(echo), abi.encodeCall(Echo.ping, (1)));
        _relayOk(executor, address(second), abi.encodeCall(Echo.ping, (2)));
        assertEq(echo.lastX(), 1);
        assertEq(second.lastX(), 2);
    }

    function test_wildcardRelaysAnySelectorAndIsRevocable() public {
        vm.prank(admin);
        controller.grantRole(WILDCARD, stranger);

        bytes memory ret = _relayOk(stranger, address(echo), abi.encodeCall(Echo.ping, (5)));
        assertEq(abi.decode(ret, (uint256)), 10);

        vm.prank(admin);
        controller.revokeRole(WILDCARD, stranger);

        (bool ok, bytes memory err) = _relay(stranger, address(echo), abi.encodeCall(Echo.ping, (5)));
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(NoviController.NotAuthorized.selector, Echo.ping.selector, stranger));
    }

    /// @notice The admin manages roles; it does NOT get implicit relay rights (design §6).
    function test_adminWithoutExplicitGrantCannotRelay() public {
        // ...not for an arbitrary selector...
        (bool ok, bytes memory ret) = _relay(admin, address(echo), abi.encodeCall(Echo.ping, (1)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, Echo.ping.selector, admin));

        // ...nor for a selector that IS in the production granted set (it is granted to the
        // executor account, not to the role-administering admin).
        bytes memory inner = abi.encodeCall(AgentTreasury.schedulePolicyUpdate, (1e6, 1 days, false, payout));
        (bool ok2, bytes memory ret2) = _relay(admin, address(vault), inner);
        assertFalse(ok2);
        assertEq(
            ret2,
            abi.encodeWithSelector(
                NoviController.NotAuthorized.selector, AgentTreasury.schedulePolicyUpdate.selector, admin
            )
        );
    }

    function test_revokedSelectorStopsRelaying() public {
        vm.prank(admin);
        controller.revokeRole(bytes32(AgentTreasury.schedulePolicyUpdate.selector), executor);
        bytes memory inner = abi.encodeCall(AgentTreasury.schedulePolicyUpdate, (1e6, 1 days, false, payout));
        (bool ok,) = _relay(executor, address(vault), inner);
        assertFalse(ok);
    }

    function test_onlyAdminGrantsRoles() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ADMIN_ROLE)
        );
        controller.grantRole(bytes32(Echo.ping.selector), stranger);
    }

    // ── M1: the zero selector aliases DEFAULT_ADMIN_ROLE ─────────────────

    function _assertZeroSelectorRejected(address caller) internal {
        bytes memory raw = abi.encodePacked(bytes4(0), address(echo)); // exactly 24 bytes
        (bool ok, bytes memory ret) = _relayRaw(caller, raw);
        assertFalse(ok, "zero selector must never relay");
        assertEq(ret, abi.encodeWithSelector(NoviController.InvalidSelector.selector));
    }

    function test_m1_zeroSelectorRevertsEvenForAdmin() public {
        _assertZeroSelectorRejected(admin);
        _assertZeroSelectorRejected(executor);
        _assertZeroSelectorRejected(stranger);
    }

    function test_m1_zeroSelectorWithArgsAlsoReverts() public {
        bytes memory raw = abi.encodePacked(bytes4(0), uint256(1), address(echo));
        (bool ok, bytes memory ret) = _relayRaw(admin, raw);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.InvalidSelector.selector));
    }

    /// @notice The namespace partition M1 protects: left-aligned selector roles can never
    ///         collide with WILDCARD_ROLE, and collide with DEFAULT_ADMIN_ROLE only at zero
    ///         (which the fallback rejects).
    function testFuzz_selectorNamespaceIsPartitioned(bytes4 selector) public view {
        assertTrue(bytes32(selector) != WILDCARD);
        if (selector == bytes4(0)) {
            assertEq(bytes32(selector), ADMIN_ROLE);
        } else {
            assertTrue(bytes32(selector) != ADMIN_ROLE);
        }
    }

    function test_setBoundTargetRejectsZeroSelector() public {
        vm.prank(admin);
        vm.expectRevert(NoviController.InvalidSelector.selector);
        controller.setBoundTarget(bytes4(0), address(echo));
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Encoding, bubbling, payability, target checks
// ─────────────────────────────────────────────────────────────────────────

contract NoviControllerEncodingTest is ControllerTestBase {
    function test_lengthBelow24Reverts() public {
        // 23 bytes: one short of selector(4) + target(20).
        bytes memory raw = new bytes(23);
        raw[0] = 0x12;
        (bool ok, bytes memory ret) = _relayRaw(executor, raw);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.MsgDataInvalid.selector));
    }

    function test_emptyCalldataReverts() public {
        (bool ok, bytes memory ret) = _relayRaw(executor, "");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.MsgDataInvalid.selector));
    }

    function test_bareSelectorWithoutTargetReverts() public {
        (bool ok, bytes memory ret) = _relayRaw(executor, abi.encodePacked(Echo.noArgs.selector));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.MsgDataInvalid.selector));
    }

    function test_exactly24BytesRelays() public {
        _grant(Echo.noArgs.selector, executor);
        bytes memory raw = abi.encodePacked(Echo.noArgs.selector, address(echo));
        assertEq(raw.length, 24);
        vm.prank(executor);
        (bool ok, bytes memory ret) = address(controller).call(raw);
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), 42);
        assertEq(echo.lastCaller(), address(controller));
    }

    /// @notice The trailing 20 bytes are the target and are stripped exactly — the inner call
    ///         must receive the ABI payload untouched, for any target address.
    function testFuzz_trailingTargetExtractionIsExact(address target, uint256 x) public {
        x = bound(x, 0, type(uint256).max / 2); // Echo.ping returns x * 2
        vm.assume(uint160(target) > 0x0a); // dodge precompiles + zero
        vm.assume(target != address(controller) && target != address(echo));
        vm.assume(target != address(this) && target != address(vm));
        vm.assume(target != 0x000000000000000000636F6e736F6c652e6c6f67); // forge console
        // Anything already carrying code (the CREATE2 deployer, other fixtures) is excluded:
        // etching over it would corrupt the test environment.
        vm.assume(target.code.length == 0);
        vm.etch(target, address(echo).code);

        _grant(Echo.ping.selector, executor);
        bytes memory ret = _relayOk(executor, target, abi.encodeCall(Echo.ping, (x)));

        assertEq(abi.decode(ret, (uint256)), x * 2);
        assertEq(Echo(target).lastX(), x);
        assertEq(Echo(target).lastCaller(), address(controller));
        assertEq(echo.lastX(), 0); // the real echo was never touched
    }

    function test_returnDataPassesThroughVerbatim() public {
        _grant(Echo.blob.selector, executor);
        bytes memory ret = _relayOk(executor, address(echo), abi.encodeCall(Echo.blob, ()));
        assertEq(ret, abi.encode(echo.blob()));
        assertEq(abi.decode(ret, (bytes)), echo.blob());
    }

    function test_customErrorBubblesByteIdentical() public {
        _grant(Echo.boom.selector, executor);
        (bool ok, bytes memory ret) = _relay(executor, address(echo), abi.encodeCall(Echo.boom, (99)));
        assertFalse(ok);
        // The vault's error, verbatim — including args, and with the CONTROLLER as `who`.
        assertEq(ret, abi.encodeWithSelector(Echo.Boom.selector, uint256(99), address(controller)));
    }

    /// @notice The design's named example: a real AgentTreasury.CapExceeded must reach the
    ///         caller byte-identical through the relay.
    function test_agentTreasuryCapExceededBubblesByteIdentical() public {
        // `spend` is NEVER granted in production; granted here only to produce a genuine
        // vault revert through the relay (opVault's operator is the controller).
        _grant(AgentTreasury.spend.selector, executor);
        (bool ok, bytes memory ret) =
            _relay(executor, address(opVault), abi.encodeCall(AgentTreasury.spend, (stranger, CAP + 1)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(AgentTreasury.CapExceeded.selector));
    }

    /// @notice Same property on a PRODUCTION-granted selector: the executor relays
    ///         executePolicyUpdate for an unscheduled id and sees the vault's NotScheduled.
    function test_productionSelectorRevertBubbles() public {
        (bool ok, bytes memory ret) =
            _relay(executor, address(vault), abi.encodeCall(AgentTreasury.executePolicyUpdate, (keccak256("nope"))));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(AgentTreasury.NotScheduled.selector));
    }

    function test_relayEmitsRelayed() public {
        _grant(Echo.ping.selector, executor);
        vm.expectEmit(true, true, true, true, address(controller));
        emit NoviController.Relayed(executor, address(echo), Echo.ping.selector);
        _relayOk(executor, address(echo), abi.encodeCall(Echo.ping, (3)));
    }

    // ── non-payable ──────────────────────────────────────────────────────

    function test_relayWithValueReverts() public {
        _grant(Echo.ping.selector, executor);
        vm.deal(executor, 1 ether);
        bytes memory raw = _wrap(abi.encodeCall(Echo.ping, (1)), address(echo));
        vm.prank(executor);
        (bool ok,) = address(controller).call{value: 1}(raw);
        assertFalse(ok, "fallback must be non-payable");
        assertEq(address(controller).balance, 0);
    }

    function test_plainValueTransferReverts() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(controller).call{value: 1 ether}("");
        assertFalse(ok, "no receive(): native dust is refused");
        assertEq(address(controller).balance, 0);
    }

    // ── target must be a contract ────────────────────────────────────────

    function test_nonContractTargetReverts() public {
        _grant(Echo.ping.selector, executor);
        address eoa = makeAddr("eoaTarget");
        (bool ok, bytes memory ret) = _relay(executor, eoa, abi.encodeCall(Echo.ping, (1)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.TargetNotContract.selector, eoa));
    }

    function test_zeroTargetReverts() public {
        _grant(Echo.ping.selector, executor);
        (bool ok, bytes memory ret) = _relay(executor, address(0), abi.encodeCall(Echo.ping, (1)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.TargetNotContract.selector, address(0)));
    }

    // ── NFT custody ──────────────────────────────────────────────────────

    function test_onERC721ReceivedReturnsSelector() public view {
        assertEq(controller.onERC721Received(address(0), address(0), 0, ""), IERC721Receiver.onERC721Received.selector);
    }

    function test_controllerAcceptsSafeMintedIdentity() public {
        MockIdentityRegistry registry = new MockIdentityRegistry();
        vm.prank(address(controller));
        uint256 agentId = registry.register("ipfs://direct");
        assertEq(registry.ownerOf(agentId), address(controller));
    }
}

// ─────────────────────────────────────────────────────────────────────────
// M2 — no self-roles (relay-bounce escalation)
// ─────────────────────────────────────────────────────────────────────────

contract NoviControllerSelfRoleTest is ControllerTestBase {
    function test_m2_grantSelectorRoleToSelfReverts() public {
        vm.prank(admin);
        vm.expectRevert(NoviController.SelfRoleForbidden.selector);
        controller.grantRole(bytes32(Echo.ping.selector), address(controller));
    }

    function test_m2_grantWildcardToSelfReverts() public {
        vm.prank(admin);
        vm.expectRevert(NoviController.SelfRoleForbidden.selector);
        controller.grantRole(WILDCARD, address(controller));
    }

    function test_m2_grantProductionSelectorToSelfReverts() public {
        vm.prank(admin);
        vm.expectRevert(NoviController.SelfRoleForbidden.selector);
        controller.grantRole(bytes32(AgentTreasury.schedulePolicyUpdate.selector), address(controller));
    }

    /// @notice The escalation M2 kills: relaying a granted selector WITH the controller as the
    ///         target bounces back into the fallback with `msg.sender == controller`. Because no
    ///         role can ever be self-granted, the bounce dies on the role check.
    function test_m2_selfTargetBounceIsNeutralized() public {
        _grant(Echo.ping.selector, executor);
        // inner payload is itself a well-formed relay (ping + echo), target = the controller
        bytes memory inner = _wrap(abi.encodeCall(Echo.ping, (1)), address(echo));
        (bool ok, bytes memory ret) = _relay(executor, address(controller), inner);
        assertFalse(ok);
        assertEq(
            ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, Echo.ping.selector, address(controller))
        );
        assertEq(echo.lastX(), 0); // never reached
    }

    /// @notice The other bounce shape: a payload too short to be a relay dies on the length
    ///         guard instead of the role check. Either way it never executes.
    function test_m2_selfTargetShortBounceRevertsOnLength() public {
        _grant(Echo.noArgs.selector, executor);
        // inner payload is a bare 4-byte selector; after the controller strips its own trailing
        // address the self-call carries 4 bytes, below the 24-byte minimum.
        (bool ok, bytes memory ret) = _relay(executor, address(controller), abi.encodeCall(Echo.noArgs, ()));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.MsgDataInvalid.selector));
    }

    /// @notice A bounce whose inner payload IS well-formed still dies on the role check, and the
    ///         selector it carried is reported verbatim (M2's guarantee, not luck of encoding).
    function test_m2_selfTargetBounceReportsInnerSelector() public {
        _grant(Echo.ping.selector, executor);
        (bool ok, bytes memory ret) = _relay(executor, address(controller), abi.encodeCall(Echo.ping, (1)));
        assertFalse(ok);
        assertEq(
            ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, Echo.ping.selector, address(controller))
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────
// M5 — target-bound selectors
// ─────────────────────────────────────────────────────────────────────────

contract NoviControllerBoundTargetTest is ControllerTestBase {
    function test_m5_boundSelectorRejectsOtherTargets() public {
        Echo other = new Echo();
        _grant(Echo.ping.selector, executor);

        vm.prank(admin);
        controller.setBoundTarget(Echo.ping.selector, address(echo));
        assertEq(controller.boundTarget(Echo.ping.selector), address(echo));

        _relayOk(executor, address(echo), abi.encodeCall(Echo.ping, (1)));

        (bool ok, bytes memory ret) = _relay(executor, address(other), abi.encodeCall(Echo.ping, (1)));
        assertFalse(ok);
        assertEq(
            ret, abi.encodeWithSelector(NoviController.TargetNotBound.selector, Echo.ping.selector, address(other))
        );
    }

    function test_m5_unbindRestoresCoarseRelay() public {
        Echo other = new Echo();
        _grant(Echo.ping.selector, executor);
        vm.prank(admin);
        controller.setBoundTarget(Echo.ping.selector, address(echo));
        (bool blocked,) = _relay(executor, address(other), abi.encodeCall(Echo.ping, (1)));
        assertFalse(blocked);

        vm.prank(admin);
        controller.setBoundTarget(Echo.ping.selector, address(0)); // unbind
        assertEq(controller.boundTarget(Echo.ping.selector), address(0));
        _relayOk(executor, address(other), abi.encodeCall(Echo.ping, (2)));
        assertEq(other.lastX(), 2);
    }

    function test_m5_boundTargetIsPerSelector() public {
        Echo other = new Echo();
        _grant(Echo.ping.selector, executor);
        _grant(Echo.noArgs.selector, executor);
        vm.prank(admin);
        controller.setBoundTarget(Echo.ping.selector, address(echo));

        // an unbound selector is unaffected by another selector's binding
        _relayOk(executor, address(other), abi.encodeCall(Echo.noArgs, ()));
        assertEq(other.lastCaller(), address(controller));
    }

    function test_m5_onlyAdminSetsBoundTarget() public {
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, executor, ADMIN_ROLE)
        );
        controller.setBoundTarget(Echo.ping.selector, address(echo));
    }

    function test_m5_emitsBoundTargetSet() public {
        vm.expectEmit(true, true, false, true, address(controller));
        emit NoviController.BoundTargetSet(Echo.ping.selector, address(echo));
        vm.prank(admin);
        controller.setBoundTarget(Echo.ping.selector, address(echo));
    }

    /// @notice Binding also constrains WILDCARD holders (it is a target check, not a role check).
    function test_m5_boundTargetConstrainsWildcard() public {
        Echo other = new Echo();
        vm.prank(admin);
        controller.grantRole(WILDCARD, stranger);
        vm.prank(admin);
        controller.setBoundTarget(Echo.ping.selector, address(echo));

        (bool ok,) = _relay(stranger, address(other), abi.encodeCall(Echo.ping, (1)));
        assertFalse(ok);
        _relayOk(stranger, address(echo), abi.encodeCall(Echo.ping, (1)));
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Admin lifecycle (AccessControlDefaultAdminRules)
// ─────────────────────────────────────────────────────────────────────────

contract NoviControllerAdminLifecycleTest is ControllerTestBase {
    address internal newAdmin = makeAddr("newAdmin");

    function test_transferRequiresDelayThenAccept() public {
        vm.prank(admin);
        controller.beginDefaultAdminTransfer(newAdmin);
        (address pending, uint48 schedule) = controller.pendingDefaultAdmin();
        assertEq(pending, newAdmin);
        assertEq(schedule, uint48(block.timestamp) + ADMIN_DELAY);

        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule
            )
        );
        controller.acceptDefaultAdminTransfer();
        assertEq(controller.defaultAdmin(), admin);

        // Exactly AT the schedule is still too early: OZ requires `schedule < block.timestamp`.
        vm.warp(schedule);
        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule
            )
        );
        controller.acceptDefaultAdminTransfer();

        vm.warp(schedule + 1);
        vm.prank(newAdmin);
        controller.acceptDefaultAdminTransfer();
        assertEq(controller.defaultAdmin(), newAdmin);
        assertFalse(controller.hasRole(ADMIN_ROLE, admin));
    }

    function test_transferCancellableDuringWindow() public {
        vm.prank(admin);
        controller.beginDefaultAdminTransfer(newAdmin);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(admin);
        controller.cancelDefaultAdminTransfer();

        (address pending, uint48 schedule) = controller.pendingDefaultAdmin();
        assertEq(pending, address(0));
        assertEq(schedule, 0);

        vm.warp(block.timestamp + ADMIN_DELAY + 1);
        vm.prank(newAdmin);
        vm.expectRevert();
        controller.acceptDefaultAdminTransfer();
        assertEq(controller.defaultAdmin(), admin);
    }

    /// @notice design §3/§6: ONLY the admin role moves. Any selector/WILDCARD role the outgoing
    ///         admin held SURVIVES — the handoff ceremony must revoke-sweep them explicitly.
    function test_outgoingAdminOtherRolesSurviveTransfer() public {
        vm.startPrank(admin);
        controller.grantRole(bytes32(Echo.ping.selector), admin);
        controller.grantRole(WILDCARD, admin);
        controller.beginDefaultAdminTransfer(newAdmin);
        vm.stopPrank();

        vm.warp(block.timestamp + ADMIN_DELAY + 1);
        vm.prank(newAdmin);
        controller.acceptDefaultAdminTransfer();

        // The old key is no longer admin...
        assertFalse(controller.hasRole(ADMIN_ROLE, admin));
        // ...but it can still relay ANYTHING until swept. This is the ceremony's live footgun.
        assertTrue(controller.hasRole(bytes32(Echo.ping.selector), admin));
        assertTrue(controller.hasRole(WILDCARD, admin));
        _relayOk(admin, address(echo), abi.encodeCall(Echo.noArgs, ())); // via WILDCARD

        // The revoke-sweep the runbook must perform.
        vm.startPrank(newAdmin);
        controller.revokeRole(bytes32(Echo.ping.selector), admin);
        controller.revokeRole(WILDCARD, admin);
        vm.stopPrank();

        assertFalse(controller.hasRole(bytes32(Echo.ping.selector), admin));
        assertFalse(controller.hasRole(WILDCARD, admin));
        (bool ok,) = _relay(admin, address(echo), abi.encodeCall(Echo.noArgs, ()));
        assertFalse(ok);
    }

    function test_defaultAdminRoleCannotBeGrantedDirectly() public {
        vm.prank(admin);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        controller.grantRole(ADMIN_ROLE, stranger);
    }

    /// @notice Monitoring hook (design §8): the delay change is itself scheduled, and the OLD
    ///         delay is honored before it bites.
    function test_changeDefaultAdminDelayIsScheduled() public {
        vm.prank(admin);
        controller.changeDefaultAdminDelay(1 hours);
        (uint48 newDelay, uint48 schedule) = controller.pendingDefaultAdminDelay();
        assertEq(newDelay, 1 hours);
        assertTrue(schedule > block.timestamp);
        assertEq(controller.defaultAdminDelay(), ADMIN_DELAY); // not yet in effect

        vm.warp(schedule); // still the old delay AT the schedule
        assertEq(controller.defaultAdminDelay(), ADMIN_DELAY);
        vm.warp(schedule + 1);
        assertEq(controller.defaultAdminDelay(), 1 hours);
    }

    function test_newAdminCanRekeyExecutor() public {
        address newExecutor = makeAddr("newExecutor");
        vm.prank(admin);
        controller.beginDefaultAdminTransfer(newAdmin);
        vm.warp(block.timestamp + ADMIN_DELAY + 1);
        vm.prank(newAdmin);
        controller.acceptDefaultAdminTransfer();

        vm.startPrank(newAdmin);
        controller.revokeRole(bytes32(AgentTreasury.schedulePolicyUpdate.selector), executor);
        controller.grantRole(bytes32(AgentTreasury.schedulePolicyUpdate.selector), newExecutor);
        vm.stopPrank();

        bytes memory inner = abi.encodeCall(AgentTreasury.schedulePolicyUpdate, (1e6, 1 days, false, payout));
        (bool oldOk,) = _relay(executor, address(vault), inner);
        assertFalse(oldOk);
        _relayOk(newExecutor, address(vault), inner);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// M3 — selector disjointness (local surface vs RELAYED set)
// ─────────────────────────────────────────────────────────────────────────

contract NoviControllerDisjointnessTest is ControllerTestBase {
    function _relayedSelectors() internal pure returns (bytes4[] memory s) {
        bytes4[] memory granted = _grantedSelectors();
        bytes4[] memory bg = _breakGlassSelectors();
        s = new bytes4[](granted.length + bg.length);
        for (uint256 i = 0; i < granted.length; i++) {
            s[i] = granted[i];
        }
        for (uint256 i = 0; i < bg.length; i++) {
            s[granted.length + i] = bg[i];
        }
    }

    /// @notice design §6 (audit M3): local ∩ RELAYED = ∅. Full-ABI disjointness is FALSE
    ///         (owner()/supportsInterface exist on both sides) and is deliberately NOT asserted.
    function test_localSelectorsDisjointFromRelayedSet() public view {
        bytes4[] memory local = _localSelectors();
        bytes4[] memory relayed = _relayedSelectors();
        // Counts are derived, never pinned: the local set is whatever the artifact says the
        // controller's ABI is, and the relayed set is the two design §3 lists concatenated.
        assertGt(local.length, 0, "controller artifact carried no methodIdentifiers");
        assertEq(relayed.length, _grantedSelectors().length + _breakGlassSelectors().length);
        for (uint256 i = 0; i < local.length; i++) {
            for (uint256 j = 0; j < relayed.length; j++) {
                assertTrue(local[i] != relayed[j], "local/relayed selector collision");
            }
        }
    }

    function test_relayedSelectorsAreInternallyDistinct() public pure {
        bytes4[] memory relayed = _relayedSelectors();
        for (uint256 i = 0; i < relayed.length; i++) {
            assertTrue(relayed[i] != bytes4(0));
            for (uint256 j = i + 1; j < relayed.length; j++) {
                assertTrue(relayed[i] != relayed[j], "duplicate relayed selector");
            }
        }
    }

    /// @notice The behavioral half of M3: every relayed selector actually reaches the fallback
    ///         (an unauthorized caller gets NotAuthorized, which only the relay can emit). If a
    ///         future local function shadowed one of these, this goes red.
    function _assertRoutesToFallback(bytes4 selector) internal {
        bytes memory raw = abi.encodePacked(selector, new bytes(160), address(echo));
        (bool ok, bytes memory ret) = _relayRaw(stranger, raw);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, selector, stranger));
    }

    function test_everyRelayedSelectorRoutesToFallback() public {
        bytes4[] memory relayed = _relayedSelectors();
        for (uint256 i = 0; i < relayed.length; i++) {
            _assertRoutesToFallback(relayed[i]);
        }
    }

    /// @notice The known, harmless shadowing the design calls out explicitly: `owner()` on the
    ///         controller answers locally instead of relaying (it is not in the relayed set).
    function test_localOwnerShadowsButIsNotRelayed() public view {
        assertEq(controller.owner(), admin); // IERC5313: the default admin
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Fuzz + storage-neutrality + gas
// ─────────────────────────────────────────────────────────────────────────

contract NoviControllerFuzzTest is ControllerTestBase {
    function _isLocal(bytes4 sel) internal view returns (bool) {
        // Membership derived from _localSelectors() — the compiled artifact's own ABI, so a new
        // controller function is excluded from the fuzz domain the moment it is added.
        bytes4[] memory local = _localSelectors();
        for (uint256 i = 0; i < local.length; i++) {
            if (local[i] == sel) return true;
        }
        return false;
    }

    /// @notice Random calldata from an unauthorized caller ALWAYS reverts and NEVER writes storage.
    function testFuzz_unauthorizedRandomCalldataAlwaysReverts(bytes4 sel, bytes memory args, address caller) public {
        vm.assume(caller != admin && caller != executor);
        vm.assume(sel != bytes4(0) && !_isLocal(sel));
        bytes memory raw = abi.encodePacked(sel, args, address(echo));

        vm.record();
        (bool ok, bytes memory ret) = _relayRaw(caller, raw);
        (, bytes32[] memory writes) = vm.accesses(address(controller));

        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, sel, caller));
        assertEq(writes.length, 0, "relay must not write controller storage");
        assertEq(controller.defaultAdmin(), admin);
        assertFalse(controller.hasRole(bytes32(sel), caller));
    }

    /// @notice Even a SUCCESSFUL relay is storage-neutral in the controller (design §6: the
    ///         relay touches nothing but events).
    function test_successfulRelayWritesNoControllerStorage() public {
        _grant(Echo.ping.selector, executor);
        vm.record();
        _relayOk(executor, address(echo), abi.encodeCall(Echo.ping, (7)));
        (, bytes32[] memory writes) = vm.accesses(address(controller));
        assertEq(writes.length, 0, "relay path must be stateless");
    }

    function testFuzz_authorizedRelayNeverEscalates(bytes4 sel, address caller) public {
        vm.assume(sel != bytes4(0) && !_isLocal(sel));
        vm.assume(caller != address(0) && caller != address(controller));
        _grant(sel, caller);
        // The grant is exactly one selector: any OTHER selector still fails for this caller.
        bytes4 other = bytes4(uint32(sel) ^ 0xffffffff);
        vm.assume(other != bytes4(0) && !_isLocal(other) && other != sel);
        (bool ok, bytes memory ret) = _relayRaw(caller, abi.encodePacked(other, address(echo)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, other, caller));
    }
}

contract NoviControllerGasTest is ControllerTestBase {
    /// @notice design §6 budget: relay overhead ≤ 10k gas vs a direct call. Measured cold
    ///         (vm.cool resets both accounts + their slots) so the number is the honest
    ///         production delta: one extra cold account hop, two cold SLOADs, one EXTCODESIZE,
    ///         one LOG3.
    function test_relayOverheadUnderTenThousandGas() public {
        _grant(Echo.touch.selector, executor);
        bytes memory raw = _wrap(abi.encodeCall(Echo.touch, ()), address(echo));

        vm.cool(address(echo));
        uint256 g0 = gasleft();
        echo.touch();
        uint256 direct = g0 - gasleft();

        vm.cool(address(echo));
        vm.cool(address(controller));
        vm.prank(executor);
        uint256 g1 = gasleft();
        (bool ok,) = address(controller).call(raw);
        uint256 relayed = g1 - gasleft();
        assertTrue(ok);

        console2.log("direct call gas   :", direct);
        console2.log("relayed call gas  :", relayed);
        console2.log("relay overhead gas:", relayed - direct);
        assertLt(relayed - direct, 10_000, "relay overhead budget blown");
    }

    /// @notice The warm-path number (repeat relays in the same tx), recorded for the snapshot.
    function test_relayOverheadWarm() public {
        _grant(Echo.touch.selector, executor);
        bytes memory raw = _wrap(abi.encodeCall(Echo.touch, ()), address(echo));
        vm.prank(executor);
        (bool warmup,) = address(controller).call(raw);
        assertTrue(warmup);

        uint256 g0 = gasleft();
        echo.touch();
        uint256 direct = g0 - gasleft();

        vm.prank(executor);
        uint256 g1 = gasleft();
        (bool ok,) = address(controller).call(raw);
        uint256 relayed = g1 - gasleft();
        assertTrue(ok);

        console2.log("warm direct gas   :", direct);
        console2.log("warm relayed gas  :", relayed);
        console2.log("warm overhead gas :", relayed - direct);
        assertLt(relayed - direct, 10_000);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// M4 — factory pins the manager to the owner
// ─────────────────────────────────────────────────────────────────────────

contract FactoryManagerPinTest is Test {
    LegalManagerFactory internal factory;
    MockIdentityRegistry internal registry;
    MockUSDC internal usdc;

    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal payout = makeAddr("payout");

    function setUp() public {
        registry = new MockIdentityRegistry();
        usdc = new MockUSDC();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry), makeAddr("beaconOwner"));
    }

    function _cfg() internal view returns (LegalManagerFactory.TreasuryConfig memory) {
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc), payoutAddress: payout, cap: 500e6, period: 1 days, allowlistEnabled: false
        });
    }

    function test_m4_rejectsManagerThatIsNotOwner() public {
        LegalManagerFactory.TreasuryConfig memory cfg = _cfg();
        vm.expectRevert(LegalManagerFactory.ManagerMustBeOwner.selector);
        factory.createEntity(makeAddr("rogue"), guardian, operator, 2 days, "ipfs://x", "EIN", 1, keccak256("x"), cfg);
    }

    function test_m4_acceptsManagerEqualToOwner() public {
        (uint256 agentId, address proxy,) = factory.createEntity(
            address(this), guardian, operator, 2 days, "ipfs://x", "EIN", 1, keccak256("x"), _cfg()
        );
        assertEq(LegalManager(payable(proxy)).manager(), address(this));
        assertEq(registry.ownerOf(agentId), address(this));
    }

    /// @notice M4 follows ownership: after a handoff, the NEW owner is the only valid manager.
    function test_m4_followsOwnershipHandoff() public {
        address newOwner = makeAddr("newOwner");
        factory.transferOwnership(newOwner);
        vm.prank(newOwner);
        factory.acceptOwnership();

        LegalManagerFactory.TreasuryConfig memory cfg = _cfg();
        vm.prank(newOwner);
        vm.expectRevert(LegalManagerFactory.ManagerMustBeOwner.selector);
        factory.createEntity(address(this), guardian, operator, 2 days, "ipfs://x", "EIN", 1, keccak256("x"), cfg);

        vm.prank(newOwner);
        (, address proxy,) =
            factory.createEntity(newOwner, guardian, operator, 2 days, "ipfs://y", "EIN", 1, keccak256("y"), cfg);
        assertEq(LegalManager(payable(proxy)).manager(), newOwner);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// BreakGlassOneShot
// ─────────────────────────────────────────────────────────────────────────

contract BreakGlassOneShotTest is ControllerTestBase {
    function test_executeRelaysThenSelfRevokes() public {
        bytes memory data = abi.encodeCall(Echo.ping, (11));
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, address(echo), data);

        vm.prank(admin);
        controller.grantRole(bytes32(Echo.ping.selector), address(helper));
        assertTrue(controller.hasRole(bytes32(Echo.ping.selector), address(helper)));

        (bool ok, bytes memory ret) = helper.execute();
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), 22);
        assertEq(echo.lastCaller(), address(controller));
        // grant + act + revoke: the dangerous grant never outlives the ceremony tx
        assertFalse(controller.hasRole(bytes32(Echo.ping.selector), address(helper)));
        assertTrue(helper.used());
    }

    function test_executeIsSingleUse() public {
        bytes memory data = abi.encodeCall(Echo.ping, (11));
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, address(echo), data);
        vm.prank(admin);
        controller.grantRole(bytes32(Echo.ping.selector), address(helper));
        helper.execute();

        vm.prank(admin);
        controller.grantRole(bytes32(Echo.ping.selector), address(helper)); // even if re-granted
        vm.expectRevert(BreakGlassOneShot.AlreadyUsed.selector);
        helper.execute();
    }

    function test_onlyDeployerCanExecute() public {
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, address(echo), abi.encodeCall(Echo.ping, (1)));
        vm.prank(admin);
        controller.grantRole(bytes32(Echo.ping.selector), address(helper));
        vm.prank(stranger);
        vm.expectRevert(BreakGlassOneShot.NotAdmin.selector);
        helper.execute();
    }

    /// @notice An ungranted helper is not a special case: the controller's fallback is the
    ///         authority, so the ceremony simply comes back `ok == false` carrying NotAuthorized —
    ///         and is spent, because a helper that could retry after a missing grant is a helper
    ///         that outlives its ceremony.
    function test_executeWithoutGrantReportsNotAuthorizedAndIsSpent() public {
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, address(echo), abi.encodeCall(Echo.ping, (1)));
        (bool ok, bytes memory ret) = helper.execute();
        assertFalse(ok);
        assertEq(
            ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, Echo.ping.selector, address(helper))
        );
        assertTrue(helper.used());
        assertEq(echo.lastX(), 0);
    }

    function test_executeWorksViaWildcardAndRevokesIt() public {
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, address(echo), abi.encodeCall(Echo.ping, (3)));
        vm.prank(admin);
        controller.grantRole(WILDCARD, address(helper));
        (bool ok,) = helper.execute();
        assertTrue(ok);
        assertEq(echo.lastX(), 3);
        assertFalse(controller.hasRole(WILDCARD, address(helper)));
        // The selector role it never held is renounced too — a no-op, which is why the helper
        // needs no `hasRole` pre-check to decide what to give back.
        assertFalse(controller.hasRole(bytes32(Echo.ping.selector), address(helper)));
    }

    /// @notice THE property this contract exists for: a ceremony whose ACTION fails still SPENDS
    ///         the helper and REVOKES the grant, in the same transaction. The old shape reverted
    ///         on a failed target, which rolled `used` and both renounces back — leaving a live
    ///         dangerous grant on the controller after an admin believed the ceremony was over.
    function test_failedActionStillSpendsTheHelperAndRevokesBothRoles() public {
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, address(echo), abi.encodeCall(Echo.boom, (5)));
        bytes32 role = bytes32(Echo.boom.selector);
        vm.startPrank(admin);
        controller.grantRole(role, address(helper));
        controller.grantRole(WILDCARD, address(helper));
        vm.stopPrank();

        bytes memory revertData = abi.encodeWithSelector(Echo.Boom.selector, uint256(5), address(controller));
        // The receipt names the failure: ok == false, plus the target's revert data verbatim.
        vm.expectEmit(true, true, false, true, address(helper));
        emit BreakGlassOneShot.BreakGlassExecuted(address(echo), Echo.boom.selector, false, revertData);
        (bool ok, bytes memory ret) = helper.execute();

        assertFalse(ok, "execute must report failure, not revert");
        assertEq(ret, revertData);
        assertTrue(helper.used(), "a failed ceremony still spends the helper");
        assertFalse(controller.hasRole(role, address(helper)), "selector grant outlived a FAILED ceremony");
        assertFalse(controller.hasRole(WILDCARD, address(helper)), "WILDCARD outlived a FAILED ceremony");

        // ...and it can never fire again: a failed action needs a fresh grant + a fresh helper.
        vm.prank(admin);
        controller.grantRole(role, address(helper));
        vm.expectRevert(BreakGlassOneShot.AlreadyUsed.selector);
        helper.execute();
    }

    function test_constructorRejectsShortCallData() public {
        vm.expectRevert(BreakGlassOneShot.CallDataTooShort.selector);
        new BreakGlassOneShot(controller, address(echo), hex"010203");
    }

    function test_helperExposesItsCeremony() public {
        bytes memory data = abi.encodeCall(Echo.ping, (11));
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, address(echo), data);
        assertEq(address(helper.controller()), address(controller));
        assertEq(helper.target(), address(echo));
        assertEq(helper.selector(), Echo.ping.selector);
        assertEq(helper.callData(), data);
        assertEq(helper.admin(), address(this));
        assertFalse(helper.used());
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Integration: controller as factory owner, beacon owner and per-agent manager
// ─────────────────────────────────────────────────────────────────────────

contract NoviControllerIntegrationTest is ControllerTestBase {
    LegalManagerFactory internal factory;
    MockIdentityRegistry internal registry;

    uint256 internal agentId;
    address internal proxy;
    address internal agentTreasury;

    address internal agentGuardian = makeAddr("agentGuardian");
    address internal agentOperator = makeAddr("agentOperator");
    address internal agentPayout = makeAddr("agentPayout");

    function setUp() public override {
        super.setUp();
        registry = new MockIdentityRegistry();
        LegalManager impl = new LegalManager();
        // Beacon owner = controller from day one (design §4).
        factory = new LegalManagerFactory(address(impl), address(registry), address(controller));
        factory.transferOwnership(address(controller));
    }

    function _cfg() internal view returns (LegalManagerFactory.TreasuryConfig memory) {
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc), payoutAddress: agentPayout, cap: CAP, period: PERIOD, allowlistEnabled: false
        });
    }

    function _acceptFactoryOwnership() internal {
        _breakGlass(address(factory), abi.encodeCall(Ownable2Step.acceptOwnership, ()));
    }

    function _createAgent() internal {
        bytes memory data = abi.encodeCall(
            LegalManagerFactory.createEntity,
            (
                address(controller),
                agentGuardian,
                agentOperator,
                POLICY_DELAY,
                "ipfs://agent",
                "EIN-INT",
                1,
                keccak256("oa"),
                _cfg()
            )
        );
        bytes memory ret = _relayOk(executor, address(factory), data);
        (agentId, proxy, agentTreasury) = abi.decode(ret, (uint256, address, address));
        usdc.mint(agentTreasury, 10_000e6);
    }

    // ── step 2 of design §7: factory ownership ceremony ──────────────────

    function test_breakGlassAcceptsFactoryOwnership() public {
        assertEq(factory.owner(), address(this));
        _acceptFactoryOwnership();
        assertEq(factory.owner(), address(controller));
        assertEq(factory.pendingOwner(), address(0));

        // The old deployer can no longer create entities (design §7 verification step).
        LegalManagerFactory.TreasuryConfig memory cfg = _cfg();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.createEntity(
            address(this), agentGuardian, agentOperator, POLICY_DELAY, "ipfs://x", "EIN", 1, keccak256("x"), cfg
        );
    }

    function test_beaconOwnerIsController() public view {
        assertEq(factory.beacon().owner(), address(controller));
    }

    /// @notice `upgradeTo` is deliberately ungranted: the executor cannot upgrade the fleet.
    function test_executorCannotUpgradeBeacon() public {
        address newImpl = address(new LegalManager());
        (bool ok, bytes memory ret) =
            _relay(executor, address(factory.beacon()), abi.encodeCall(UpgradeableBeacon.upgradeTo, (newImpl)));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                NoviController.NotAuthorized.selector, UpgradeableBeacon.upgradeTo.selector, executor
            )
        );
    }

    function test_breakGlassUpgradesBeacon() public {
        address newImpl = address(new LegalManager());
        _breakGlass(address(factory.beacon()), abi.encodeCall(UpgradeableBeacon.upgradeTo, (newImpl)));
        assertEq(factory.beacon().implementation(), newImpl);
    }

    // ── full agent lifecycle through the relay ───────────────────────────

    function test_createAgentThroughRelayWithControllerAsManager() public {
        _acceptFactoryOwnership();
        _createAgent();

        assertEq(LegalManager(payable(proxy)).manager(), address(controller));
        assertEq(AgentTreasury(agentTreasury).manager(), address(controller));
        assertEq(registry.ownerOf(agentId), address(controller)); // identity custody
        assertEq(factory.entityByAgentId(agentId), proxy);
    }

    function test_relayedPolicyScheduleThenGuardianVeto() public {
        _acceptFactoryOwnership();
        _createAgent();
        AgentTreasury t = AgentTreasury(agentTreasury);

        bytes memory ret = _relayOk(
            executor,
            agentTreasury,
            abi.encodeCall(AgentTreasury.schedulePolicyUpdate, (1_000e6, PERIOD, false, agentPayout))
        );
        bytes32 policyId = abi.decode(ret, (bytes32));
        (,,,, uint256 executableAt, bool exists) = t.pendingPolicy(policyId);
        assertTrue(exists);
        assertEq(executableAt, block.timestamp + POLICY_DELAY);

        vm.prank(agentGuardian);
        t.vetoPolicyUpdate(policyId);
        assertTrue(t.policyVetoed(policyId));

        // Vetoed: even after the delay the manager cannot execute it.
        vm.warp(block.timestamp + POLICY_DELAY + 1);
        (bool ok, bytes memory err) =
            _relay(executor, agentTreasury, abi.encodeCall(AgentTreasury.executePolicyUpdate, (policyId)));
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(AgentTreasury.NotScheduled.selector));
        assertEq(t.cap(), CAP); // unchanged
    }

    function test_relayedPolicyScheduleThenExecute() public {
        _acceptFactoryOwnership();
        _createAgent();
        AgentTreasury t = AgentTreasury(agentTreasury);

        bytes memory ret = _relayOk(
            executor,
            agentTreasury,
            abi.encodeCall(AgentTreasury.schedulePolicyUpdate, (1_000e6, PERIOD, false, agentPayout))
        );
        bytes32 policyId = abi.decode(ret, (bytes32));

        // The vault timelock still binds the controller.
        (bool tooEarly, bytes memory err) =
            _relay(executor, agentTreasury, abi.encodeCall(AgentTreasury.executePolicyUpdate, (policyId)));
        assertFalse(tooEarly);
        assertEq(err, abi.encodeWithSelector(AgentTreasury.TooEarly.selector));

        vm.warp(block.timestamp + POLICY_DELAY);
        _relayOk(executor, agentTreasury, abi.encodeCall(AgentTreasury.executePolicyUpdate, (policyId)));
        assertEq(t.cap(), 1_000e6);
    }

    function test_relayedOperatingAgreementAmendment() public {
        _acceptFactoryOwnership();
        _createAgent();
        LegalManager lm = LegalManager(payable(proxy));
        bytes32 newHash = keccak256("oa-v2");

        _relayOk(executor, proxy, abi.encodeCall(LegalManager.scheduleOperatingAgreementUpdate, (newHash)));
        assertEq(lm.scheduledAt(newHash), block.timestamp + POLICY_DELAY);

        vm.warp(block.timestamp + POLICY_DELAY);
        _relayOk(executor, proxy, abi.encodeCall(LegalManager.executeOperatingAgreementUpdate, (newHash)));
        (,, bytes32 oaHash,) = lm.meta();
        assertEq(oaHash, newHash);
    }

    function test_relayedWalletBindAndMetadataOnMockRegistry() public {
        _acceptFactoryOwnership();
        _createAgent();

        // M5: pin the registry selectors to the registry address.
        vm.startPrank(admin);
        controller.setBoundTarget(IIdentityRegistry.setAgentWallet.selector, address(registry));
        controller.setBoundTarget(IIdentityRegistry.setMetadata.selector, address(registry));
        vm.stopPrank();

        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + 5 minutes;
        // The EIP-712 struct's `owner` field is the CONTROLLER (design §3).
        bytes32 digest = registry.walletSetDigest(agentId, wallet, address(controller), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, digest);

        _relayOk(
            executor,
            address(registry),
            abi.encodeCall(IIdentityRegistry.setAgentWallet, (agentId, wallet, deadline, abi.encodePacked(r, s, v)))
        );
        assertEq(registry.getAgentWallet(agentId), wallet);

        _relayOk(
            executor,
            address(registry),
            abi.encodeCall(IIdentityRegistry.setMetadata, (agentId, "ensName", bytes("agent.novicorpus.eth")))
        );
        assertEq(registry.getMetadata(agentId, "ensName"), bytes("agent.novicorpus.eth"));
    }

    /// @notice M5 in the shape the design specifies: a stolen executor cannot aim a registry
    ///         selector at a look-alike contract once the binding is set.
    function test_boundRegistrySelectorRejectsDecoyRegistry() public {
        _acceptFactoryOwnership();
        _createAgent();
        MockIdentityRegistry decoy = new MockIdentityRegistry();
        vm.prank(admin);
        controller.setBoundTarget(IIdentityRegistry.setMetadata.selector, address(registry));

        (bool ok, bytes memory ret) =
            _relay(executor, address(decoy), abi.encodeCall(IIdentityRegistry.setMetadata, (agentId, "k", bytes("v"))));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                NoviController.TargetNotBound.selector, IIdentityRegistry.setMetadata.selector, address(decoy)
            )
        );
    }

    // ── dissolution break-glass ──────────────────────────────────────────

    function test_executorCannotInitiateDissolution() public {
        _acceptFactoryOwnership();
        _createAgent();
        (bool ok, bytes memory ret) = _relay(executor, proxy, abi.encodeCall(LegalManager.initiateDissolution, ()));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                NoviController.NotAuthorized.selector, LegalManager.initiateDissolution.selector, executor
            )
        );
    }

    function test_breakGlassDissolutionThenGuardianCancels() public {
        _acceptFactoryOwnership();
        _createAgent();
        LegalManager lm = LegalManager(payable(proxy));

        _breakGlass(proxy, abi.encodeCall(LegalManager.initiateDissolution, ()));
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.WindingDown));
        assertEq(lm.dissolutionInitiator(), address(controller));

        // The guardian (the user's own wallet) is the check on the platform.
        vm.prank(agentGuardian);
        lm.cancelDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
        assertEq(lm.dissolutionInitiator(), address(0));
    }

    /// @notice A stolen executor key cannot move the identity NFT (transfer selectors ungranted).
    function test_executorCannotMoveIdentityNft() public {
        _acceptFactoryOwnership();
        _createAgent();
        bytes memory data = abi.encodeCall(IIdentityRegistry.transferFrom, (address(controller), stranger, agentId));
        (bool ok,) = _relay(executor, address(registry), data);
        assertFalse(ok);
        assertEq(registry.ownerOf(agentId), address(controller));
    }
}
