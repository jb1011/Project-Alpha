// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentTreasury} from "../AgentTreasury.sol";
import {LegalManager} from "../LegalManager.sol";
import {LegalManagerFactory} from "../LegalManagerFactory.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";

/// @title ControllerSelectors
/// @notice THE definition of the NoviController executor's standing grant set (design §3).
/// @dev    One source imported by the deploy script AND both test suites: a selector added in one
///         place and not another would mean the tests pass against a grant set that is not what
///         mainnet deploys — the exact drift the design's test plan exists to prevent. Computed
///         from the ABIs, never hardcoded hex, so a signature change moves everything together.
library ControllerSelectors {
    function granted() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = AgentTreasury.schedulePolicyUpdate.selector;
        s[1] = AgentTreasury.executePolicyUpdate.selector;
        s[2] = LegalManager.scheduleOperatingAgreementUpdate.selector;
        s[3] = LegalManager.executeOperatingAgreementUpdate.selector;
        s[4] = LegalManagerFactory.createEntity.selector;
        s[5] = IIdentityRegistry.setAgentWallet.selector;
        s[6] = IIdentityRegistry.setMetadata.selector;
    }
}
