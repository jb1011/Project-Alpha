// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {LegalManager} from "./LegalManager.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title LegalBodyFactory
/// @notice Creates a legal body for an ERC-8004 identity that its customer owns and keeps.
///         Each body is an immutable EIP-1167 clone of the audited LegalManager implementation,
///         with no treasury. The identity owner authorises the creation with an EIP-712
///         `LegalBodyLink`, and later writes a pointer to the body in their own identity's
///         metadata. This contract never holds, moves or is approved for any identity.
/// @dev    This factory is the `manager` of every body it creates, on purpose. LegalManager
///         gives its manager the right to initiate or cancel a dissolution and to sweep assets.
///         This contract exposes none of those. Its only power over a body is to schedule an
///         operating-agreement amendment that the body's guardian has signed. So no key held
///         by the platform (the owner of this factory, or any key granted roles on it) can
///         amend, dissolve or sweep a body on its own. Only the guardian can dissolve.
///         Bodies are deterministic clones salted by the link digest: one signature can create
///         at most one body. Several bodies may exist for one identity over time. The live one
///         is the body the identity owner's pointer names (see `linkedLegalBody`).
contract LegalBodyFactory is Ownable2Step, EIP712 {
    bytes32 public constant LINK_TYPEHASH = keccak256(
        "LegalBodyLink(uint256 agentId,address guardian,uint256 amendmentDelay,bytes32 operatingAgreementHash,uint256 deadline)"
    );

    bytes32 public constant AMENDMENT_TYPEHASH =
        keccak256("OperatingAgreementUpdate(address legalBody,bytes32 newHash,uint256 nonce,uint256 deadline)");

    /// @notice Amendments and dissolutions wait at least this long, so the guardian always has
    ///         two days to react.
    uint256 public constant MIN_AMENDMENT_DELAY = 48 hours;
    /// @notice Upper bound: a very large delay would overflow the dissolution timestamp inside
    ///         LegalManager and leave the guardian unable to ever dissolve.
    uint256 public constant MAX_AMENDMENT_DELAY = 30 days;
    /// @notice A signature may be used at most this long before its deadline.
    uint256 public constant MAX_SIGNATURE_WINDOW = 24 hours;

    address public immutable implementation;
    IIdentityRegistry public immutable identityRegistry;

    /// @notice body => the identity owner who signed its LegalBodyLink. Non-zero means this
    ///         factory created the body.
    mapping(address => address) public identityOwnerAtCreation;

    /// @notice body => the nonce the guardian's next amendment signature must carry.
    mapping(address => uint256) public amendmentNonce;

    event LegalBodyCreated(
        uint256 indexed agentId,
        address indexed legalBody,
        address indexed identityOwner,
        address guardian,
        bytes32 linkDigest
    );

    error BadDeadline();
    error BadDelay();
    error BadGuardian();
    error BadSignature();
    error LegalBodyExists(address legalBody);
    error NotContract(address account);
    error NotLegalBody(address account);
    error OwnershipRenounceDisabled();

    /// @param implementation_   the deployed LegalManager logic contract every body clones
    /// @param identityRegistry_ the ERC-8004 identity registry
    /// @param owner_            the platform controller; the only caller of the owner functions
    constructor(address implementation_, address identityRegistry_, address owner_)
        Ownable(owner_)
        EIP712("Novi LegalBodyFactory", "1")
    {
        if (implementation_.code.length == 0) revert NotContract(implementation_);
        if (identityRegistry_.code.length == 0) revert NotContract(identityRegistry_);
        implementation = implementation_;
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    // ------------------------------------------------------------------
    // Creation
    // ------------------------------------------------------------------

    /// @notice Create a legal body for `agentId`, authorised by its current owner's signature.
    /// @dev    The owner is read from the registry, never passed in, so a link signed before an
    ///         identity transfer stops working after it. The body is a deterministic clone
    ///         salted by the link digest; the collision check before cloning turns a replay
    ///         into a cheap, explicit revert instead of a CREATE2 failure that burns the gas.
    function createLegalBody(
        uint256 agentId,
        address guardian,
        uint256 amendmentDelay,
        bytes32 operatingAgreementHash,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOwner returns (address legalBody) {
        _checkDeadline(deadline);
        if (amendmentDelay < MIN_AMENDMENT_DELAY || amendmentDelay > MAX_AMENDMENT_DELAY) revert BadDelay();
        // A guardian that is the caller or this factory could never veto or dissolve.
        if (guardian == address(0) || guardian == msg.sender || guardian == address(this)) revert BadGuardian();

        address identityOwner = identityRegistry.ownerOf(agentId);
        bytes32 digest = linkDigest(agentId, guardian, amendmentDelay, operatingAgreementHash, deadline);
        if (!SignatureChecker.isValidSignatureNow(identityOwner, digest, signature)) revert BadSignature();

        address predicted = predictLegalBody(digest);
        if (predicted.code.length != 0) revert LegalBodyExists(predicted);

        legalBody = Clones.cloneDeterministic(implementation, digest);
        LegalManager(payable(legalBody)).initialize(
            address(this), guardian, amendmentDelay, agentId, "", 0, operatingAgreementHash
        );
        identityOwnerAtCreation[legalBody] = identityOwner;
        emit LegalBodyCreated(agentId, legalBody, identityOwner, guardian, digest);
    }

    // ------------------------------------------------------------------
    // Amendments: guardian-signed, platform-recorded, guardian-vetoable
    // ------------------------------------------------------------------

    /// @notice Schedule an operating-agreement amendment the body's guardian signed.
    /// @dev    Both parties are needed. The platform alone cannot amend (it needs the
    ///         guardian's signature), and the guardian alone cannot either (only the owner
    ///         schedules), so the anchored agreement changes only when both agree. The body
    ///         still enforces its delay, and the guardian can still veto during it.
    function scheduleOperatingAgreementUpdate(
        address legalBody,
        bytes32 newHash,
        uint256 deadline,
        bytes calldata guardianSignature
    ) external onlyOwner {
        if (!isLegalBody(legalBody)) revert NotLegalBody(legalBody);
        _checkDeadline(deadline);
        uint256 nonce = amendmentNonce[legalBody];
        address guardian = LegalManager(payable(legalBody)).guardian();
        bytes32 digest = amendmentDigest(legalBody, newHash, nonce, deadline);
        if (!SignatureChecker.isValidSignatureNow(guardian, digest, guardianSignature)) revert BadSignature();
        amendmentNonce[legalBody] = nonce + 1;
        LegalManager(payable(legalBody)).scheduleOperatingAgreementUpdate(newHash);
    }

    /// @notice Execute a scheduled amendment once its delay has passed. Callable by anyone:
    ///         the body only executes a hash that was scheduled, not vetoed, and has waited out
    ///         the delay, so nobody can hold back a guardian-approved amendment.
    function executeOperatingAgreementUpdate(address legalBody, bytes32 newHash) external {
        if (!isLegalBody(legalBody)) revert NotLegalBody(legalBody);
        LegalManager(payable(legalBody)).executeOperatingAgreementUpdate(newHash);
    }

    /// @notice The EIP-712 digest the guardian signs to approve an amendment.
    function amendmentDigest(address legalBody, bytes32 newHash, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(AMENDMENT_TYPEHASH, legalBody, newHash, nonce, deadline)));
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function isLegalBody(address legalBody) public view returns (bool) {
        return identityOwnerAtCreation[legalBody] != address(0);
    }

    /// @notice The EIP-712 digest the identity owner signs to authorise a body.
    function linkDigest(
        uint256 agentId,
        address guardian,
        uint256 amendmentDelay,
        bytes32 operatingAgreementHash,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(LINK_TYPEHASH, agentId, guardian, amendmentDelay, operatingAgreementHash, deadline))
        );
    }

    /// @notice The address the body for this link digest has, or will have.
    function predictLegalBody(bytes32 linkDigest_) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, linkDigest_);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _checkDeadline(uint256 deadline) internal view {
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_SIGNATURE_WINDOW) revert BadDeadline();
    }

    /// @dev Renouncing would leave no one able to create bodies or record amendments.
    function renounceOwnership() public pure override {
        revert OwnershipRenounceDisabled();
    }
}
