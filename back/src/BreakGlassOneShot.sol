// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NoviController} from "./NoviController.sol";

/// @title BreakGlassOneShot
/// @notice Single-use ceremony contract that makes a break-glass relay atomic under a
///         single-EOA controller admin: act + self-revoke happen in ONE transaction, so the
///         dangerous grant never lives across blocks.
/// @dev    Design §3. The full ceremony is exactly two admin transactions:
///           1. `controller.grantRole(bytes32(helper.selector()), helper)`  (or WILDCARD_ROLE)
///           2. `helper.execute()`                                          (relay + renounce)
///         Deliberately dumb: one target, one payload, one shot, fixed at construction. Deploy a
///         new helper per ceremony rather than making this contract configurable — a reusable
///         break-glass contract is a standing privilege waiting to be re-granted by mistake.
contract BreakGlassOneShot {
    NoviController public immutable controller;
    /// @notice The only address allowed to fire the ceremony: whoever deployed this helper.
    /// @dev    Separate from the controller admin on purpose — the deployer is the operator
    ///         running the runbook; the admin's authority is expressed by the grant in step 1,
    ///         which is what actually gates the power. Without the grant, `execute` reverts.
    address public immutable admin;
    address public immutable target;
    /// @notice Selector of {callData}; the role the controller must have granted this helper.
    bytes4 public immutable selector;

    /// @notice One-shot latch. Set before the external call (checks-effects-interactions), so a
    ///         reentrant `execute` is impossible even if the target calls back.
    bool public used;
    /// @notice The exact payload relayed. `bytes` cannot be `immutable`; it is written once in
    ///         the constructor and never again.
    bytes public callData;

    error NotAdmin();
    error AlreadyUsed();
    error RoleNotGranted();
    error CallDataTooShort();

    event BreakGlassExecuted(address indexed target, bytes4 indexed selector, bool viaWildcard);

    constructor(NoviController controller_, address target_, bytes memory callData_) {
        if (callData_.length < 4) revert CallDataTooShort();
        bytes4 sel;
        assembly {
            // First word of the bytes payload; a bytes4 assignment keeps the leading 4 bytes.
            sel := mload(add(callData_, 0x20))
        }
        controller = controller_;
        admin = msg.sender;
        target = target_;
        selector = sel;
        callData = callData_;
    }

    /// @notice Relay {callData} to {target} through the controller, then renounce whichever role
    ///         made it possible. Reverts (leaving the helper spent) if the target reverts, so a
    ///         failed ceremony is never mistaken for a completed one.
    /// @return The target's return data, verbatim.
    function execute() external returns (bytes memory) {
        if (msg.sender != admin) revert NotAdmin();
        if (used) revert AlreadyUsed();
        used = true;

        bytes32 role = bytes32(selector);
        bytes32 wildcard = controller.WILDCARD_ROLE();
        bool viaSelector = controller.hasRole(role, address(this));
        bool viaWildcard = controller.hasRole(wildcard, address(this));
        if (!viaSelector && !viaWildcard) revert RoleNotGranted();

        // Euler encoding: payload with the target appended as the trailing 20 bytes.
        (bool ok, bytes memory ret) = address(controller).call(abi.encodePacked(callData, target));
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        // Self-revoke last: the roles are needed for the call above. `renounceRole` requires the
        // caller to be the account, which is exactly this contract.
        if (viaSelector) controller.renounceRole(role, address(this));
        if (viaWildcard) controller.renounceRole(wildcard, address(this));

        emit BreakGlassExecuted(target, selector, viaWildcard);
        return ret;
    }
}
