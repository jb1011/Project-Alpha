// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BreakGlassOneShot} from "../../src/BreakGlassOneShot.sol";
import {ControllerSelectors} from "../../src/libraries/ControllerSelectors.sol";
import {NoviController} from "../../src/NoviController.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

/// @title ControllerRelayHarness
/// @notice The shared scaffolding for driving a NoviController the way production does: Euler
///         calldata wrapping, the relay call itself, and the break-glass ceremony.
/// @dev    ONE copy, inherited by both the local suite (NoviController.t.sol) and the live-state
///         suite (NoviControllerFork.t.sol). They previously carried two near-identical copies
///         that had already drifted; a fork test that wraps calldata differently from the local
///         test is a deploy gate proving something other than what production does.
///
///         Deliberately holds no fixture (no vaults, no factory, no registry): the two suites
///         build very different worlds around the same relay mechanics.
abstract contract ControllerRelayHarness is Test {
    NoviController internal controller;

    /// @dev The two identities every relay test needs: the cold role admin and the hot executor.
    ///      Same labels in both suites, so a trace reads identically local vs fork.
    address internal admin = makeAddr("noviAdmin");
    address internal executor = makeAddr("noviExecutor");

    /// @dev The ONE grant-set definition — src/libraries/ControllerSelectors.sol. Imported by the
    ///      deploy script too, so the tests can never pass against a set mainnet does not deploy.
    function _grantedSelectors() internal pure returns (bytes4[] memory) {
        return ControllerSelectors.granted();
    }

    /// @dev M5: the two registry selectors, pinned to `registry` — the constructor arguments the
    ///      deploy script passes, so both suites construct the controller exactly as mainnet does.
    function _registryPins(address registry)
        internal
        pure
        returns (bytes4[] memory pinSelectors, address[] memory pinTargets)
    {
        pinSelectors = new bytes4[](2);
        pinSelectors[0] = IIdentityRegistry.setAgentWallet.selector;
        pinSelectors[1] = IIdentityRegistry.setMetadata.selector;
        pinTargets = new address[](2);
        pinTargets[0] = registry;
        pinTargets[1] = registry;
    }

    /// @dev The empty-pin pair, for fixtures whose relay targets are all our own contracts.
    function _noPins() internal pure returns (bytes4[] memory pinSelectors, address[] memory pinTargets) {
        pinSelectors = new bytes4[](0);
        pinTargets = new address[](0);
    }

    // ── relay helpers ────────────────────────────────────────────────────

    /// @dev Euler encoding: target-function calldata with the target appended as 20 trailing bytes.
    function _wrap(bytes memory inner, address target) internal pure returns (bytes memory) {
        return abi.encodePacked(inner, target);
    }

    function _relay(address caller, address target, bytes memory inner) internal returns (bool ok, bytes memory ret) {
        vm.prank(caller);
        (ok, ret) = address(controller).call(_wrap(inner, target));
    }

    function _relayOk(address caller, address target, bytes memory inner) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = _relay(caller, target, inner);
        assertTrue(ok, "relay reverted unexpectedly");
        return ret;
    }

    /// @dev Relay bytes the ABI could never produce (short calldata, zero selectors, fuzz blobs).
    function _relayRaw(address caller, bytes memory raw) internal returns (bool ok, bytes memory ret) {
        vm.prank(caller);
        (ok, ret) = address(controller).call(raw);
    }

    /// @dev Leading 4 bytes of an encoded payload.
    function _sel(bytes memory data) internal pure returns (bytes4 s) {
        assembly {
            s := mload(add(data, 0x20))
        }
    }

    function _grant(bytes4 selector, address account) internal {
        vm.prank(admin);
        controller.grantRole(bytes32(selector), account);
    }

    /// @dev The design's ceremony, exactly as the runbook performs it: deploy a single-use helper,
    ///      the ADMIN grants it the selector role, one call acts and gives the role back.
    ///      `execute` reports failure through its `ok` return rather than reverting (reverting
    ///      would roll the revocation back — see BreakGlassOneShot.execute), so success is
    ///      asserted here explicitly. Also asserts the grant did not outlive the transaction.
    function _breakGlass(address target, bytes memory data) internal returns (bytes memory) {
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, target, data);
        bytes32 role = bytes32(_sel(data));
        vm.prank(admin);
        controller.grantRole(role, address(helper));
        (bool ok, bytes memory ret) = helper.execute();
        assertTrue(ok, "break-glass ceremony did not succeed");
        assertFalse(controller.hasRole(role, address(helper)), "grant outlived the ceremony");
        return ret;
    }
}
