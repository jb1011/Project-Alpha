// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {LegalManager} from "./LegalManager.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {AgentTreasury} from "./AgentTreasury.sol";

/// @title LegalManagerFactory
/// @notice Registers an agent on ERC-8004, deploys a per-agent LegalManager beacon
///         proxy, hands the agent its identity NFT, and maintains a public registry
///         of all created legal bodies.
/// @dev    "Register-only": this contract does NOT bind the manager's wallet. Canonical
///         ERC-8004 `setAgentWallet` requires an EIP-712 signature from the wallet being
///         bound, which a contract cannot produce on-chain. Wallet binding is therefore a
///         separate, signed step performed by the manager (now the NFT owner) after creation.
///         The factory implements IERC721Receiver because `register()` _safeMints to it.
///         Onboarding is platform-gated: only the owner may create entities, matching the
///         backend-orchestrated flow (the platform issues each agent its legal body + manager
///         wallet). This prevents anyone from forging a legal body bound to an arbitrary address.
contract LegalManagerFactory is IERC721Receiver, Ownable2Step {
    UpgradeableBeacon public immutable beacon;
    IIdentityRegistry public immutable identityRegistry;

    /// @notice Per-agent AgentTreasury wiring, passed at creation (also keeps createEntity's
    ///         parameter list from growing further).
    struct TreasuryConfig {
        address usdc;
        address payoutAddress;
        uint256 cap;
        uint256 period;
        bool    allowlistEnabled;
    }

    address[] public entities;
    mapping(uint256 => address) public entityByAgentId;   // agentId => proxy
    mapping(uint256 => address) public treasuryByAgentId; // agentId => AgentTreasury

    event EntityCreated(uint256 indexed agentId, address indexed proxy, address indexed manager);
    event TreasuryCreated(uint256 indexed agentId, address indexed treasury, address indexed operator);

    /// @dev The registry returned an agentId already recorded here. The canonical registry assigns
    ///      monotonic ids so this cannot happen in practice, but the guard prevents an upgraded /
    ///      misbehaving registry from silently overwriting an existing entity's mappings.
    error AgentIdAlreadyUsed(uint256 agentId);

    /// @dev Renouncing ownership would permanently brick onboarding (no party could ever create a
    ///      new legal body again). Disabled deliberately; use `transferOwnership` (two-step) instead.
    error OwnershipRenounceDisabled();

    /// @param implementation     the LegalManager logic contract the beacon points at
    /// @param identityRegistry_  the live ERC-8004 IdentityRegistry
    /// @param beaconOwner        the address allowed to upgrade every LegalManager at once
    ///                           (use a multisig/timelock in production, not an EOA)
    constructor(address implementation, address identityRegistry_, address beaconOwner)
        Ownable(msg.sender)
    {
        beacon = new UpgradeableBeacon(implementation, beaconOwner);
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @notice Registers an agent identity, deploys its LegalManager proxy and its immutable
    ///         AgentTreasury, and records both. Atomic and platform-gated (onlyOwner).
    /// @param  operator the agent's non-custodial spending key (e.g. Turnkey EOA) — the treasury's bounded operator
    /// @param  tcfg     the AgentTreasury wiring (USDC, payout, cap, period, allowlist flag)
    /// @return agentId  the ERC-8004 identity id minted for the agent
    /// @return proxy    the per-agent LegalManager beacon proxy
    /// @return treasury the AgentTreasury vault deployed for this agent
    function createEntity(
        address manager,
        address guardian,
        address operator,
        uint256 amendmentDelay,
        string calldata metadataURI,
        string calldata ein,
        uint64 formationDate,
        bytes32 operatingAgreementHash,
        TreasuryConfig calldata tcfg
    ) external onlyOwner returns (uint256 agentId, address proxy, address treasury) {
        // 1. Register the agent's on-chain identity (ERC-8004). _safeMints the NFT to this
        //    factory (hence IERC721Receiver) and returns the agentId.
        agentId = identityRegistry.register(metadataURI);

        // 2. Deploy the per-agent LegalManager behind a beacon proxy, initialized atomically.
        proxy = _deployProxy(manager, guardian, amendmentDelay, agentId, ein, formationDate, operatingAgreementHash);

        // 3. Deploy the immutable AgentTreasury vault, wired to the proxy as its legalManager.
        //    Reuses amendmentDelay as the treasury policyDelay so policy changes are gated
        //    by the same timelock cadence as operating-agreement amendments.
        treasury = _deployTreasury(manager, guardian, operator, amendmentDelay, proxy, tcfg);

        // 4. Hand the identity NFT to the agent's manager. Wallet binding (setAgentWallet)
        //    happens later as a separate manager-signed step.
        identityRegistry.transferFrom(address(this), manager, agentId);

        // 5. Record both in the public registry. Guard against an id the registry has already
        //    handed out, so a misbehaving/upgraded registry cannot orphan an existing entity.
        if (entityByAgentId[agentId] != address(0)) revert AgentIdAlreadyUsed(agentId);
        entities.push(proxy);
        entityByAgentId[agentId] = proxy;
        treasuryByAgentId[agentId] = treasury;

        emit EntityCreated(agentId, proxy, manager);
        emit TreasuryCreated(agentId, treasury, operator);
    }

    function _deployProxy(
        address manager,
        address guardian,
        uint256 amendmentDelay,
        uint256 agentId,
        string calldata ein,
        uint64 formationDate,
        bytes32 operatingAgreementHash
    ) internal returns (address proxy) {
        bytes memory initData = abi.encodeCall(
            LegalManager.initialize,
            (manager, guardian, amendmentDelay, agentId, ein, formationDate, operatingAgreementHash)
        );
        proxy = address(new BeaconProxy(address(beacon), initData));
    }

    function _deployTreasury(
        address manager,
        address guardian,
        address operator,
        uint256 amendmentDelay,
        address proxy,
        TreasuryConfig calldata tcfg
    ) internal returns (address treasury) {
        treasury = address(new AgentTreasury(
            tcfg.usdc,
            proxy,
            manager,
            guardian,
            operator,
            tcfg.payoutAddress,
            tcfg.cap,
            tcfg.period,
            amendmentDelay,
            tcfg.allowlistEnabled
        ));
    }

    function entitiesCount() external view returns (uint256) {
        return entities.length;
    }

    /// @notice Disabled — see {OwnershipRenounceDisabled}. Ownership can only be handed off via the
    ///         two-step {transferOwnership}/{acceptOwnership} flow, never dropped to address(0).
    function renounceOwnership() public pure override {
        revert OwnershipRenounceDisabled();
    }

    /// @dev Accept the identity NFT minted to us during `register()`.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
