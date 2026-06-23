// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal stand-in for LegalManager.status() (0 = Active, 1 = WindingDown, 2 = Dissolved).
contract MockLegalManagerStatus {
    uint8 public status; // defaults to 0 (Active)
    function setStatus(uint8 s) external { status = s; }
}
