// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AgentTreasury} from "../../src/AgentTreasury.sol";

/// @dev Malicious ERC-20 that attempts to re-enter AgentTreasury on transfer.
///      Used to verify that nonReentrant blocks the second call.
///
///      Design: the token is deployed as BOTH the vault's USDC token AND an
///      authorized role (operator or guardian). This ensures the re-entrant call
///      passes the role check and actually hits the nonReentrant modifier.
///
///      The re-entry fires at most once (one-shot) to avoid unbounded recursion,
///      and only when called from the vault (to avoid interfering with setup mints).
contract ReentrantToken is ERC20 {
    AgentTreasury public vault;
    address public reentrantTo;
    uint256 public reentrantAmount;
    bool public useEmergencyWithdraw;
    bool private _armed;

    constructor() ERC20("ReentrantToken", "RENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @param vault_                The AgentTreasury to attack.
    /// @param reentrantTo_          The `to` address for the re-entrant spend call (ignored for emergencyWithdraw).
    /// @param reentrantAmount_      The amount for the re-entrant spend call (ignored for emergencyWithdraw).
    /// @param useEmergencyWithdraw_ If true, re-enter emergencyWithdraw; otherwise re-enter spend.
    function arm(
        address vault_,
        address reentrantTo_,
        uint256 reentrantAmount_,
        bool useEmergencyWithdraw_
    ) external {
        vault = AgentTreasury(vault_);
        reentrantTo = reentrantTo_;
        reentrantAmount = reentrantAmount_;
        useEmergencyWithdraw = useEmergencyWithdraw_;
        _armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // Fire only when:
        //   - armed (one-shot, cleared before the call to prevent unbounded recursion)
        //   - the transfer originates from the vault (outer spend / emergencyWithdraw)
        if (_armed && from == address(vault)) {
            _armed = false; // disarm before re-entering to prevent infinite recursion
            if (useEmergencyWithdraw) {
                // msg.sender is this token == vault.guardian(), so onlyGuardian passes
                vault.emergencyWithdraw();
            } else {
                // msg.sender is this token == vault.operator(), so onlyOperator passes
                vault.spend(reentrantTo, reentrantAmount);
            }
        }
    }
}
