// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegalManager} from "../../src/LegalManager.sol";

contract LegalManagerV2 is LegalManager {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
