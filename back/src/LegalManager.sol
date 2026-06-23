// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title LegalManager
/// @notice Per-agent on-chain "managing smart contract" for a Wyoming DAO LLC body.
///         Holds the operating-agreement binding + legal metadata, links the agent's
///         ERC-8004 agentId, and enforces a delayed, guardian-vetoable amendment and
///         dissolution process. Deployed per agent behind an UpgradeableBeacon proxy.
/// @dev    Status is monotonic: Active -> WindingDown -> Dissolved. Amendments are only
///         allowed while Active; asset sweeps only while WindingDown. A guardian veto is
///         permanent for that operating-agreement hash until the guardian lifts it.
contract LegalManager is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    enum Status { Active, WindingDown, Dissolved }

    struct LegalMeta {
        string ein;
        uint64 formationDate;
        bytes32 operatingAgreementHash;
        uint256 agentId;
    }

    /// @notice Lower bound on the amendment timelock, so a 0 delay can never bypass it.
    uint256 public constant MIN_AMENDMENT_DELAY = 1 hours;

    address public manager;   // the agent's controller (e.g. the platform-held wallet)
    address public guardian;  // can veto scheduled amendments / trigger dissolution
    uint256 public amendmentDelay; // also used as the dissolution timelock
    Status public status;
    LegalMeta public meta;

    mapping(bytes32 => uint256) public scheduledAt; // newHash => earliest execution time
    mapping(bytes32 => bool) public vetoed;         // newHash => permanently blocked until lifted

    address public dissolutionInitiator;   // who initiated the pending dissolution
    uint256 public dissolutionExecutableAt; // earliest time sweep/finalize are allowed

    error NotManager();
    error NotGuardian();
    error NotActive();
    error NotWindingDown();
    error TooEarly();
    error NotScheduled();
    error NotAuthorized();
    error ZeroAddress();
    error RolesMustDiffer();
    error DelayTooShort();
    error Vetoed();
    error NotVetoed();
    error NativeSweepFailed();
    error NotDissolving();

    event AmendmentScheduled(bytes32 indexed newHash, uint256 executableAt);
    event AmendmentVetoed(bytes32 indexed newHash);
    event VetoLifted(bytes32 indexed newHash);
    event OperatingAgreementUpdated(bytes32 indexed newHash);
    event DissolutionInitiated(address indexed initiator, uint256 executableAt);
    event DissolutionVetoed(address indexed vetoedBy);
    event AssetsSwept(address indexed token, address indexed payoutTo, uint256 amount);
    event NativeSwept(address indexed payoutTo, uint256 amount);
    event Dissolved();

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }
    modifier whenActive() {
        if (status != Status.Active) revert NotActive();
        _;
    }
    modifier whenWindingDown() {
        if (status != Status.WindingDown) revert NotWindingDown();
        _;
    }
    /// @dev Asset recovery is allowed once dissolution has begun (WindingDown) AND remains
    ///      allowed after the body is Dissolved, so residual or late-arriving assets can never
    ///      be permanently stranded by finalizing before a sweep.
    modifier whenDissolving() {
        if (status == Status.Active) revert NotDissolving();
        _;
    }
    modifier afterDissolutionWindow() {
        if (block.timestamp < dissolutionExecutableAt) revert TooEarly();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address manager_,
        address guardian_,
        uint256 amendmentDelay_,
        uint256 agentId_,
        string calldata ein_,
        uint64 formationDate_,
        bytes32 operatingAgreementHash_
    ) external initializer {
        if (manager_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (manager_ == guardian_) revert RolesMustDiffer();
        if (amendmentDelay_ < MIN_AMENDMENT_DELAY) revert DelayTooShort();
        __ReentrancyGuard_init();
        manager = manager_;
        guardian = guardian_;
        amendmentDelay = amendmentDelay_;
        status = Status.Active;
        meta = LegalMeta({
            ein: ein_,
            formationDate: formationDate_,
            operatingAgreementHash: operatingAgreementHash_,
            agentId: agentId_
        });
    }

    // ------------------------------------------------------------------
    // Operating-agreement amendments (delayed, guardian hard-vetoable)
    // ------------------------------------------------------------------

    function scheduleOperatingAgreementUpdate(bytes32 newHash) external onlyManager whenActive {
        if (vetoed[newHash]) revert Vetoed();
        uint256 executableAt = block.timestamp + amendmentDelay;
        scheduledAt[newHash] = executableAt;
        emit AmendmentScheduled(newHash, executableAt);
    }

    /// @notice Guardian veto. Permanently blocks this hash until the guardian lifts it,
    ///         so the manager cannot simply re-schedule a vetoed amendment.
    function cancelOperatingAgreementUpdate(bytes32 newHash) external onlyGuardian {
        delete scheduledAt[newHash];
        vetoed[newHash] = true;
        emit AmendmentVetoed(newHash);
    }

    /// @notice Guardian re-approval: lifts a prior veto so the manager may schedule it again.
    ///         Reverts if the hash was not actually vetoed, so the emitted event is meaningful
    ///         and a stray call cannot silently churn veto state.
    function liftVeto(bytes32 newHash) external onlyGuardian {
        if (!vetoed[newHash]) revert NotVetoed();
        vetoed[newHash] = false;
        emit VetoLifted(newHash);
    }

    function executeOperatingAgreementUpdate(bytes32 newHash) external onlyManager whenActive {
        uint256 t = scheduledAt[newHash];
        if (t == 0) revert NotScheduled();
        if (block.timestamp < t) revert TooEarly();
        delete scheduledAt[newHash];
        meta.operatingAgreementHash = newHash;
        emit OperatingAgreementUpdated(newHash);
    }

    // ------------------------------------------------------------------
    // Dissolution: initiate -> (timelock; non-initiator may veto) -> sweep -> finalize
    // ------------------------------------------------------------------

    /// @notice Begin winding down. Either role may initiate; the other role can veto during
    ///         the timelock window, and no asset moves until the window elapses.
    function initiateDissolution() external whenActive {
        if (msg.sender != manager && msg.sender != guardian) revert NotAuthorized();
        status = Status.WindingDown;
        dissolutionInitiator = msg.sender;
        dissolutionExecutableAt = block.timestamp + amendmentDelay;
        emit DissolutionInitiated(msg.sender, dissolutionExecutableAt);
    }

    /// @notice Veto a pending dissolution, returning the body to Active. Callable only by the
    ///         authorized role that did NOT initiate it (the check on a single rogue/compromised
    ///         key). Allowed any time before finalization.
    function cancelDissolution() external whenWindingDown {
        bool isRole = msg.sender == manager || msg.sender == guardian;
        if (!isRole || msg.sender == dissolutionInitiator) revert NotAuthorized();
        status = Status.Active;
        dissolutionInitiator = address(0);
        dissolutionExecutableAt = 0;
        emit DissolutionVetoed(msg.sender);
    }

    /// @notice Sweep one or more ERC-20 balances (e.g. USDC, EURC) to the payout address.
    ///         Repeatable while winding down (and after dissolution) so no asset can be stranded
    ///         by a single call, by finalizing before a sweep, or by a late-arriving transfer.
    ///         Only after the veto window closes. Either authorized role may sweep (symmetric with
    ///         initiate/finalize) so residual assets are recoverable even if one role's key is lost.
    function sweep(address[] calldata tokens, address payoutTo)
        external
        whenDissolving
        afterDissolutionWindow
        nonReentrant
    {
        if (msg.sender != manager && msg.sender != guardian) revert NotAuthorized();
        if (payoutTo == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) {
                IERC20(tokens[i]).safeTransfer(payoutTo, bal);
                emit AssetsSwept(tokens[i], payoutTo, bal);
            }
        }
    }

    /// @notice Sweep the native balance (Arc's native gas token is USDC) on wind-down or after
    ///         dissolution, so native dust that arrives at any point can always be recovered.
    function sweepNative(address payoutTo)
        external
        whenDissolving
        afterDissolutionWindow
        nonReentrant
    {
        if (msg.sender != manager && msg.sender != guardian) revert NotAuthorized();
        if (payoutTo == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = payoutTo.call{value: bal}("");
            if (!ok) revert NativeSweepFailed();
            emit NativeSwept(payoutTo, bal);
        }
    }

    /// @notice Mark the body dissolved. Either authorized role may finalize once the timelock
    ///         has elapsed; separate from sweeping so the manager can drain every asset first.
    ///         Status becomes terminal (no transition out of Dissolved), but `sweep`/`sweepNative`
    ///         deliberately remain callable afterwards so residual/late assets are never stranded.
    function finalizeDissolution() external whenWindingDown afterDissolutionWindow {
        if (msg.sender != manager && msg.sender != guardian) revert NotAuthorized();
        status = Status.Dissolved;
        emit Dissolved();
    }

    receive() external payable {}
}
