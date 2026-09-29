// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice A minimal smart-contract wallet: one EOA signer, ERC-1271 validation, and a call
///         passthrough so it can own an ERC-8004 identity and write its metadata.
contract MockERC1271Wallet is IERC1271, IERC721Receiver {
    address public immutable signer;
    bool public refuseAll;

    constructor(address signer_) {
        signer = signer_;
    }

    function setRefuseAll(bool v) external {
        require(msg.sender == signer, "not signer");
        refuseAll = v;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (refuseAll) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == signer, "not signer");
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
}
