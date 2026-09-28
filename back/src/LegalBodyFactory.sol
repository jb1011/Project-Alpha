// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
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
///         Only the amendment scheduled last may execute, and only once: a new schedule
///         supersedes any older pending one. The body itself never forgets a scheduled hash,
///         so without this rule anyone could execute a superseded amendment later and roll the
///         anchored agreement back.
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

    /// @notice The identity-metadata key the owner writes the pointer under.
    string public constant POINTER_KEY = "legalBody";
    uint8 public constant POINTER_VERSION = 1;
    uint256 private constant POINTER_LENGTH = 96;

    address public immutable implementation;
    IIdentityRegistry public immutable identityRegistry;

    /// @notice body => the identity owner who signed its LegalBodyLink. Non-zero means this
    ///         factory created the body.
    mapping(address => address) public identityOwnerAtCreation;

    /// @notice body => the nonce the guardian's next amendment signature must carry.
    mapping(address => uint256) public amendmentNonce;

    /// @notice body => the only amendment that may execute: the one scheduled last. A new
    ///         schedule supersedes any older pending one, and executing it clears this slot.
    mapping(address => bytes32) public pendingAmendment;

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
    error NotImplementation(address account);
    error NotLegalBody(address account);
    error NotPendingAmendment(bytes32 newHash);
    error OwnershipRenounceDisabled();

    /// @param implementation_   the deployed, locked LegalManager logic contract every body clones
    /// @param identityRegistry_ the ERC-8004 identity registry
    /// @param owner_            the platform controller; the only caller of the owner functions
    constructor(address implementation_, address identityRegistry_, address owner_)
        Ownable(owner_)
        EIP712("Novi LegalBodyFactory", "1")
    {
        if (implementation_.code.length == 0) revert NotContract(implementation_);
        if (identityRegistry_.code.length == 0) revert NotContract(identityRegistry_);
        _requireLockedImplementation(implementation_);
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
        LegalManager(payable(legalBody))
            .initialize(address(this), guardian, amendmentDelay, agentId, "", 0, operatingAgreementHash);
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
    ///         still enforces its delay, and the guardian can still veto during it. This hash
    ///         becomes the body's only pending amendment and supersedes any older one, which
    ///         can then never execute.
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
        pendingAmendment[legalBody] = newHash;
        LegalManager(payable(legalBody)).scheduleOperatingAgreementUpdate(newHash);
    }

    /// @notice Execute the pending amendment once its delay has passed. Callable by anyone:
    ///         the body only executes a hash that was scheduled, not vetoed, and has waited out
    ///         the delay, so nobody can hold back a guardian-approved amendment.
    /// @dev    Only `pendingAmendment[legalBody]`, the hash scheduled last, may execute, and
    ///         only once. A superseded or already executed hash reverts, so no one can choose
    ///         the order of two approvals or replay an old one to roll the agreement back.
    function executeOperatingAgreementUpdate(address legalBody, bytes32 newHash) external {
        if (!isLegalBody(legalBody)) revert NotLegalBody(legalBody);
        if (newHash == bytes32(0) || pendingAmendment[legalBody] != newHash) revert NotPendingAmendment(newHash);
        delete pendingAmendment[legalBody];
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

    /// @notice The exact pointer value the identity owner writes under `POINTER_KEY`.
    function encodePointer(address legalBody) external view returns (bytes memory) {
        return abi.encode(POINTER_VERSION, block.chainid, legalBody);
    }

    /// @notice The legal body `agentId` is linked to right now, or address(0).
    /// @dev    One predicate for everyone (this platform's backend and any third party). Linked
    ///         means all of these hold: the owner's pointer is exactly the 96-byte encoding for
    ///         this chain; it names a body this factory created; that body names this agentId
    ///         and is Active; and the identity still belongs to the owner who signed the link.
    ///         The pointer is written by the identity owner, so it can hold any bytes: this
    ///         function decodes by hand and never reverts, whatever it finds.
    function linkedLegalBody(uint256 agentId) external view returns (address) {
        bytes memory pointer;
        try identityRegistry.getMetadata(agentId, POINTER_KEY) returns (bytes memory p) {
            pointer = p;
        } catch {
            return address(0);
        }
        if (pointer.length != POINTER_LENGTH) return address(0);
        uint256 version;
        uint256 chainId;
        uint256 bodyWord;
        assembly {
            version := mload(add(pointer, 0x20))
            chainId := mload(add(pointer, 0x40))
            bodyWord := mload(add(pointer, 0x60))
        }
        if (version != POINTER_VERSION || chainId != block.chainid || bodyWord >> 160 != 0) return address(0);
        // Safe: the line above returned early unless every bit above the low 160 is zero.
        // forge-lint: disable-next-line(unsafe-typecast)
        address candidate = address(uint160(bodyWord));
        address creator = identityOwnerAtCreation[candidate];
        if (creator == address(0)) return address(0);

        LegalManager lm = LegalManager(payable(candidate));
        (,,, uint256 bodyAgentId) = lm.meta();
        if (bodyAgentId != agentId || lm.status() != LegalManager.Status.Active) return address(0);

        try identityRegistry.ownerOf(agentId) returns (address currentOwner) {
            if (currentOwner != creator) return address(0);
        } catch {
            return address(0);
        }
        return candidate;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Bodies are immutable clones, so cloning anything but the locked LegalManager
    ///      implementation could never be repaired. A proxy, for example, would forward every
    ///      body to an upgradeable beacon, and whoever controls that beacon could rewrite them.
    ///      Two checks, both needed:
    ///      1. `manager()` is empty. A proxy of a live body has a manager; a contract that is
    ///         not a LegalManager at all reverts here, which also refuses it.
    ///      2. `initialize` reverts with exactly `InvalidInitialization`, which proves the
    ///         target's initialisers were disabled at construction. An uninitialised proxy or
    ///         clone would accept the call instead; the revert below then undoes that
    ///         initialisation along with this whole deployment, so the probe leaves no trace.
    function _requireLockedImplementation(address implementation_) private {
        LegalManager lm = LegalManager(payable(implementation_));
        if (lm.manager() != address(0)) revert NotImplementation(implementation_);
        try lm.initialize(address(1), address(2), MIN_AMENDMENT_DELAY, 0, "", 0, bytes32(0)) {
            revert NotImplementation(implementation_);
        } catch (bytes memory reason) {
            // Truncating to the first 4 bytes is the point: it reads the error selector.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (reason.length < 4 || bytes4(reason) != Initializable.InvalidInitialization.selector) {
                revert NotImplementation(implementation_);
            }
        }
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_SIGNATURE_WINDOW) revert BadDeadline();
    }

    /// @dev Renouncing would leave no one able to create bodies or record amendments.
    function renounceOwnership() public pure override {
        revert OwnershipRenounceDisabled();
    }
}
