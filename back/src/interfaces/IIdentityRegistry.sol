// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal subset of the ERC-8004 IdentityRegistry we interact with.
/// @dev Signatures verified 2026-06-04 against the live Arc-testnet implementation
///      (proxy 0x8004A818BFB912233c491871b3d84c89A494BD9e -> impl 0x7274e874ca62410a93bd8bf61c69d8045e399c02)
///      via arcscan's verified ABI. The registry is an upgradeable ERC-721 ("AgentIdentity"/"AGENT").
interface IIdentityRegistry {
    /// @dev Mints an agent identity NFT to msg.sender (via _safeMint) and returns its agentId.
    ///      Because it _safeMints, a contract caller MUST implement IERC721Receiver.
    function register(string calldata metadataURI) external returns (uint256 agentId);

    /// @dev Stores an on-chain key/value against an agent. Value is raw bytes (e.g. EIN, OA hash).
    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external;

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);

    /// @dev Binds a wallet to the agent identity. Requires `signature` to be a valid EIP-712
    ///      AgentWalletSet signature produced by `newWallet` (ECDSA or ERC-1271), and the caller
    ///      to be the agent owner / approved. `deadline` bounds signature validity.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external;

    function getAgentWallet(uint256 agentId) external view returns (address);

    function ownerOf(uint256 agentId) external view returns (address);

    /// @dev Standard ERC-721 transfer (does not invoke the receiver hook).
    function transferFrom(address from, address to, uint256 tokenId) external;
}
