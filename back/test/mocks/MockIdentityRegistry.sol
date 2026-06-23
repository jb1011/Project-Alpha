// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

/// @notice Faithful test double for the canonical ERC-8004 IdentityRegistry on Arc.
/// @dev Mirrors the verified on-chain implementation so tests catch the same reverts the
///      real contract would produce:
///        - `register` uses `_safeMint` (a contract caller MUST implement IERC721Receiver),
///          assigns sequential ids starting at 0, and auto-sets the `agentWallet` to the caller;
///        - `setAgentWallet` requires the caller to be owner/approved AND an EIP-712 signature
///          from the wallet being bound, within a bounded deadline.
contract MockIdentityRegistry is ERC721, EIP712, IIdentityRegistry {
    bytes32 public constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    // Verified against the live Arc registry (0x8004…BD9e) on 2026-06-16: it reverts "deadline too
    // far" beyond block.timestamp + 300s. Keep this faithful so CI catches over-long deadlines.
    uint256 public constant MAX_DEADLINE_DELAY = 5 minutes;
    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;

    uint256 private _lastId;
    mapping(bytes32 => bytes) private _meta;
    mapping(uint256 => address) private _agentWallet;

    // Faithful to live (read 2026-06-15): ERC-721 name() == "AgentIdentity", but the EIP-712 domain
    // name is "ERC8004IdentityRegistry" (eip712Domain()). They are deliberately different.
    constructor() ERC721("AgentIdentity", "AGENT") EIP712("ERC8004IdentityRegistry", "1") {}

    function register(string calldata) external returns (uint256 agentId) {
        agentId = _lastId++;
        _agentWallet[agentId] = msg.sender;
        _meta[_key(agentId, "agentWallet")] = abi.encodePacked(msg.sender);
        _safeMint(msg.sender, agentId);
    }

    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external {
        require(_isAuthorized(ownerOf(agentId), msg.sender, agentId), "not authorized");
        _meta[_key(agentId, key)] = value;
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        return _meta[_key(agentId, key)];
    }

    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        address owner = ownerOf(agentId);
        require(
            msg.sender == owner || isApprovedForAll(owner, msg.sender)
                || msg.sender == getApproved(agentId),
            "Not authorized"
        );
        require(newWallet != address(0), "bad wallet");
        require(block.timestamp <= deadline, "expired");
        require(deadline <= block.timestamp + MAX_DEADLINE_DELAY, "deadline too far");

        // Mirror live: ECDSA first (EOAs + EIP-7702), then ERC-1271 fallback for contract wallets.
        bytes32 digest = walletSetDigest(agentId, newWallet, owner, deadline);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != newWallet) {
            (bool ok, bytes memory res) =
                newWallet.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            require(
                ok && res.length >= 32 && abi.decode(res, (bytes4)) == ERC1271_MAGICVALUE,
                "invalid wallet sig"
            );
        }

        _agentWallet[agentId] = newWallet;
        _meta[_key(agentId, "agentWallet")] = abi.encodePacked(newWallet);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallet[agentId];
    }

    // --- disambiguate functions declared by both ERC721 and IIdentityRegistry ---

    function ownerOf(uint256 agentId)
        public
        view
        override(ERC721, IIdentityRegistry)
        returns (address)
    {
        return super.ownerOf(agentId);
    }

    function transferFrom(address from, address to, uint256 tokenId)
        public
        override(ERC721, IIdentityRegistry)
    {
        super.transferFrom(from, to, tokenId);
    }

    /// @dev Exposed so tests can compute the digest the bound wallet must sign.
    function walletSetDigest(uint256 agentId, address newWallet, address owner, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner, deadline))
        );
    }

    function _key(uint256 agentId, string memory key) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(agentId, key));
    }
}
