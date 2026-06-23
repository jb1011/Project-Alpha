// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ILegalManagerStatus {
    function status() external view returns (uint8); // 0 = Active
}

/// @title AgentTreasury
/// @notice Immutable, per-agent non-custodial USDC vault. The operator (agent's Turnkey EOA) spends
///         within a rolling per-period cap; the guardian (human) has instant safety powers + policy veto;
///         the manager (platform) proposes timelocked policy changes; spending halts when the agent's
///         LegalManager leaves Active. No upgrade key — no party can drain beyond the on-chain rules.
contract AgentTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_POLICY_DELAY = 1 hours;
    /// @notice Upper bound on the spending `period`. Caps the rolling window so a (malicious or
    ///         mistaken) manager cannot set a period large enough to overflow `windowStart + period`
    ///         — which would brick `available()`/`spend` — or to freeze the window indefinitely.
    uint256 public constant MAX_POLICY_PERIOD = 365 days;

    IERC20  public immutable usdc;
    address public immutable legalManager;
    address public immutable manager;
    address public immutable guardian;
    uint256 public immutable policyDelay;

    address public operator;
    address public payoutAddress;
    uint256 public cap;
    uint256 public period;
    bool    public allowlistEnabled;

    uint256 public spentInWindow;
    uint256 public windowStart;
    bool    public paused;
    mapping(address => bool) public isAllowed;

    struct PendingPolicy {
        uint256 cap;
        uint256 period;
        address payoutAddress;
        bool    allowlistEnabled;
        uint256 executableAt;
        bool    exists;
    }
    mapping(bytes32 => PendingPolicy) public pendingPolicy;
    mapping(bytes32 => bool) public policyVetoed;

    error ZeroAddress();
    error RolesMustDiffer();
    error DelayTooShort();
    error ZeroAmount();
    error PeriodTooLong();
    error NotAContract();
    error NotVetoed();
    error NotOperator();
    error NotGuardian();
    error NotManager();
    error IsPaused();
    error LegalNotActive();
    error CapExceeded();
    error NotAllowed();
    error AlreadyScheduled();
    error NotScheduled();
    error TooEarly();
    error PolicyVetoed();

    event Spent(address indexed to, uint256 amount);
    event OperatorFunded(address indexed operator, uint256 amount);
    event Paused();
    event Unpaused();
    event OperatorRotated(address indexed previous, address indexed next);
    event AllowlistUpdated(address indexed account, bool allowed);
    event EmergencyWithdrawn(address indexed payoutAddress, uint256 amount);
    event PolicyUpdateScheduled(
        bytes32 indexed policyId, uint256 cap, uint256 period, bool allowlistOn, address payoutAddress, uint256 executableAt
    );
    event PolicyUpdateVetoed(bytes32 indexed policyId);
    event VetoLifted(bytes32 indexed policyId);
    event PolicyUpdated(uint256 cap, uint256 period, bool allowlistOn, address payoutAddress);

    modifier onlyOperator() { if (msg.sender != operator) revert NotOperator(); _; }
    modifier onlyGuardian() { if (msg.sender != guardian) revert NotGuardian(); _; }
    modifier onlyManager()  { if (msg.sender != manager)  revert NotManager();  _; }

    constructor(
        address usdc_,
        address legalManager_,
        address manager_,
        address guardian_,
        address operator_,
        address payoutAddress_,
        uint256 cap_,
        uint256 period_,
        uint256 policyDelay_,
        bool allowlistEnabled_
    ) {
        if (
            usdc_ == address(0) || legalManager_ == address(0) || manager_ == address(0) ||
            guardian_ == address(0) || operator_ == address(0) || payoutAddress_ == address(0)
        ) revert ZeroAddress();
        if (
            manager_ == guardian_ || manager_ == operator_ || guardian_ == operator_ ||
            payoutAddress_ == operator_ // the safe-sink payout must not be the agent's hot key
        ) revert RolesMustDiffer();
        if (policyDelay_ < MIN_POLICY_DELAY) revert DelayTooShort();
        if (period_ == 0) revert ZeroAmount();
        if (period_ > MAX_POLICY_PERIOD) revert PeriodTooLong();
        // legalManager gates every spend via a staticcall to status(); an EOA here would revert
        // all spends and permanently brick the (immutable) vault.
        if (legalManager_.code.length == 0) revert NotAContract();

        usdc = IERC20(usdc_);
        legalManager = legalManager_;
        manager = manager_;
        guardian = guardian_;
        operator = operator_;
        payoutAddress = payoutAddress_;
        cap = cap_;
        period = period_;
        policyDelay = policyDelay_;
        allowlistEnabled = allowlistEnabled_;
        windowStart = block.timestamp;
    }

    /// @notice USDC still spendable in the current window.
    function available() public view returns (uint256) {
        if (block.timestamp >= windowStart + period) return cap;
        return spentInWindow >= cap ? 0 : cap - spentInWindow;
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    function _useCap(uint256 amount) internal {
        if (block.timestamp >= windowStart + period) {
            windowStart = block.timestamp;
            spentInWindow = 0;
        }
        if (spentInWindow + amount > cap) revert CapExceeded();
        spentInWindow += amount;
    }

    function _requireSpendable(address to) internal view {
        if (to == address(0)) revert ZeroAddress();
        if (paused) revert IsPaused();
        if (ILegalManagerStatus(legalManager).status() != 0) revert LegalNotActive();
    }

    // ── Operator: capped spending ─────────────────────────────────────────

    /// @notice Capped on-chain USDC payment by the agent operator.
    function spend(address to, uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _requireSpendable(to);
        if (allowlistEnabled && !isAllowed[to]) revert NotAllowed();
        _useCap(amount);
        usdc.safeTransfer(to, amount);
        emit Spent(to, amount);
    }

    /// @notice Top up the operator's hot EOA (for x402/Gateway/nanopayments), within the same cap.
    function fundOperator(uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (paused) revert IsPaused();
        if (ILegalManagerStatus(legalManager).status() != 0) revert LegalNotActive();
        _useCap(amount);
        usdc.safeTransfer(operator, amount);
        emit OperatorFunded(operator, amount);
    }

    // ── Guardian: instant safety powers ──────────────────────────────────

    function pause() external onlyGuardian { paused = true; emit Paused(); }
    function unpause() external onlyGuardian { paused = false; emit Unpaused(); }

    function setOperator(address newOperator) external onlyGuardian {
        if (newOperator == address(0)) revert ZeroAddress();
        // Preserve the constructor's role-distinctness: a rotation must not collapse the operator
        // into the manager, guardian, or the payout sink (the last would let emergencyWithdraw
        // route funds straight back to the agent's hot key).
        if (newOperator == manager || newOperator == guardian || newOperator == payoutAddress) {
            revert RolesMustDiffer();
        }
        address previous = operator;
        operator = newOperator;
        emit OperatorRotated(previous, newOperator);
    }

    function setAllowlistEntry(address account, bool allowed) external onlyGuardian {
        if (account == address(0)) revert ZeroAddress();
        isAllowed[account] = allowed;
        emit AllowlistUpdated(account, allowed);
    }

    /// @notice Sweep the entire USDC balance to the fixed payoutAddress (the bounded human override).
    function emergencyWithdraw() external onlyGuardian nonReentrant {
        uint256 bal = usdc.balanceOf(address(this));
        if (bal > 0) usdc.safeTransfer(payoutAddress, bal);
        emit EmergencyWithdrawn(payoutAddress, bal);
    }

    // ── Policy changes: timelocked + guardian-vetoable ────────────────────

    function _policyId(uint256 c, uint256 p, bool a, address pout) internal pure returns (bytes32) {
        return keccak256(abi.encode(c, p, a, pout));
    }

    function schedulePolicyUpdate(uint256 newCap, uint256 newPeriod, bool allowlistOn, address newPayout)
        external onlyManager returns (bytes32 policyId)
    {
        if (newPayout == address(0)) revert ZeroAddress();
        if (newPeriod == 0) revert ZeroAmount();
        if (newPeriod > MAX_POLICY_PERIOD) revert PeriodTooLong();
        policyId = _policyId(newCap, newPeriod, allowlistOn, newPayout);
        if (policyVetoed[policyId]) revert PolicyVetoed();
        if (pendingPolicy[policyId].exists) revert AlreadyScheduled();
        uint256 executableAt = block.timestamp + policyDelay;
        pendingPolicy[policyId] = PendingPolicy({
            cap: newCap,
            period: newPeriod,
            payoutAddress: newPayout,
            allowlistEnabled: allowlistOn,
            executableAt: executableAt,
            exists: true
        });
        emit PolicyUpdateScheduled(policyId, newCap, newPeriod, allowlistOn, newPayout, executableAt);
    }

    function vetoPolicyUpdate(bytes32 policyId) external onlyGuardian {
        if (!pendingPolicy[policyId].exists) revert NotScheduled();
        policyVetoed[policyId] = true;
        delete pendingPolicy[policyId];
        emit PolicyUpdateVetoed(policyId);
    }

    /// @notice Guardian lifts a prior veto so the manager may schedule this policy tuple again.
    ///         Reverts if the tuple was not vetoed, so the emitted event is meaningful.
    function liftVeto(bytes32 policyId) external onlyGuardian {
        if (!policyVetoed[policyId]) revert NotVetoed();
        policyVetoed[policyId] = false;
        emit VetoLifted(policyId);
    }

    /// @dev Applies to the IN-FLIGHT spend window: `windowStart`/`spentInWindow` are not reset here, so a
    ///      raised cap grants the extra headroom immediately and a shortened period resets on the next spend.
    ///      The invariant "spent within any window <= cap-in-effect" always holds (no cap bypass / drain).
    function executePolicyUpdate(bytes32 policyId) external onlyManager {
        PendingPolicy storage pp = pendingPolicy[policyId];
        if (!pp.exists) revert NotScheduled();
        if (block.timestamp < pp.executableAt) revert TooEarly();
        // Re-enforce the constructor's `payout != operator` invariant against the CURRENT operator
        // (which may have been rotated since the policy was scheduled). The guardian can also veto
        // such a policy during the timelock; this is the on-chain backstop if they don't.
        if (pp.payoutAddress == operator) revert RolesMustDiffer();
        cap = pp.cap;
        period = pp.period;
        allowlistEnabled = pp.allowlistEnabled;
        payoutAddress = pp.payoutAddress;
        delete pendingPolicy[policyId];
        emit PolicyUpdated(cap, period, allowlistEnabled, payoutAddress);
    }
}
