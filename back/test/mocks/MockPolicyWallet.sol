// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice A test smart-contract wallet: one EOA signer, ERC-1271 validation, an ERC-721 receiver
///         hook and a call passthrough, so it can own an ERC-8004 identity. Its signer can switch
///         on three behaviours of its signature check:
///         - approved digests: a digest the signer approved is valid with an EMPTY signature;
///         - a costly check: `isValidSignature` spends about `burnGas` gas before it answers;
///         - a wrapped digest: the signer's signature is checked over
///           `keccak256(abi.encode(WRAP_TYPEHASH, address(this), digest))` instead of the plain
///           digest, as smart accounts that guard against replay across accounts do.
contract MockPolicyWallet is IERC1271, IERC721Receiver {
    bytes32 public constant WRAP_TYPEHASH = keccak256("Wrap(address account,bytes32 digest)");

    address public immutable signer;
    mapping(bytes32 => bool) public approved;
    uint256 public burnGas;
    bool public wrap;

    constructor(address signer_) {
        signer = signer_;
    }

    modifier onlySigner() {
        require(msg.sender == signer, "not signer");
        _;
    }

    function approve(bytes32 digest) external onlySigner {
        approved[digest] = true;
    }

    function setBurn(uint256 gas_) external onlySigner {
        burnGas = gas_;
    }

    function setWrap(bool on) external onlySigner {
        wrap = on;
    }

    /// @notice The hash the signer signs for `digest` while wrapping is on.
    function wrappedDigest(bytes32 digest) public view returns (bytes32) {
        return keccak256(abi.encode(WRAP_TYPEHASH, address(this), digest));
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        _burn();
        if (signature.length == 0) return approved[digest] ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
        bytes32 hash = wrap ? wrappedDigest(digest) : digest;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }

    function execute(address target, bytes calldata data) external onlySigner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev A hashing loop that runs until about `burnGas` gas is spent. Reads only, writes nothing.
    function _burn() private view {
        uint256 target = burnGas;
        if (target == 0) return;
        uint256 start = gasleft();
        bytes32 h = bytes32(target);
        while (start - gasleft() < target) {
            h = keccak256(abi.encode(h));
        }
    }
}
