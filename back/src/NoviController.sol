// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @title NoviController
/// @notice The single governed root of platform authority: the immutable `manager` of every
///         agent's AgentTreasury + LegalManager, the owner of the factory and its upgrade
///         beacon, and the custodian of every agent's ERC-8004 identity NFT.
/// @dev    A selector-allowlisted relay (Euler v2 `GovernorAccessControl` shape, built from
///         audited OZ 5.1.0 primitives). A cold ADMIN manages roles and can re-key everything;
///         a hot EXECUTOR (the backend key) may call exactly the selectors it holds, on any
///         target, with zero per-agent configuration.
///
///         Deliberately absent, because the agent vaults already provide them on-chain:
///         - no timelock (AgentTreasury/LegalManager each enforce their own delay + guardian veto)
///         - no pause (the guardian pauses its own vault)
///         - no upgradeability (this contract is small enough to replace; note that a replacement
///           implies a new factory and new agents, since `AgentTreasury.manager` is immutable —
///           the same immutability bet the vaults already make)
///
///         The relay is stateless: it writes no storage, holds no ERC-20 approvals, and cannot
///         hold a role on itself (see {_grantRole}), so a relayed call that re-enters this
///         contract can never gain authority.
contract NoviController is AccessControlDefaultAdminRules, IERC721Receiver {
    /// @notice Role permitting relay of ANY selector. Granted to NO ONE at deployment; it exists
    ///         for admin break-glass ceremonies (grant, act, revoke — ideally atomically via a
    ///         one-shot helper).
    /// @dev    `bytes32(uint256(1))` is right-aligned, so it can never collide with a
    ///         left-aligned `bytes32(bytes4 selector)` role, nor with DEFAULT_ADMIN_ROLE (0x00).
    ///         (Euler uses `type(uint256).max`; this value is equally collision-free.)
    bytes32 public constant WILDCARD_ROLE = bytes32(uint256(1));

    /// @notice Optional per-selector target pin. When set, the relay accepts ONLY this target for
    ///         that selector.
    /// @dev    M5: the ERC-8004 registry is a third-party UPGRADEABLE proxy whose future ABI could
    ///         grow a selector colliding with one we grant. Pinning `setAgentWallet`/`setMetadata`
    ///         to the registry address bounds that unknown. Our own audited contracts stay
    ///         unpinned (coarse-across-targets is the intended platform-operator semantics).
    ///         `address(0)` means "unpinned", which is why unbinding is a write of `address(0)`.
    mapping(bytes4 => address) public boundTarget;

    /// @dev Calldata shorter than 4-byte selector + 20-byte trailing target cannot be a relay.
    ///      (Tightened vs Euler, whose guard is `<= 20`.)
    error MsgDataInvalid();
    /// @dev The selector namespace must stay disjoint from the role namespace: `bytes4(0)` casts
    ///      to DEFAULT_ADMIN_ROLE and would let the admin relay anything without a grant (M1).
    error InvalidSelector();
    error NotAuthorized(bytes4 selector, address caller);
    error TargetNotBound(bytes4 selector, address target);
    /// @dev A bare `call` to an EOA succeeds silently; a decoy relay would pollute the event log
    ///      and read as a successful platform action that never happened.
    error TargetNotContract(address target);
    /// @dev M2: a role held by this contract would be reachable by relaying a call back into the
    ///      fallback (`msg.sender == address(this)`) — total escalation.
    error SelfRoleForbidden();
    /// @dev Granting selectors to the zero address would emit a governance event that authorizes
    ///      no one; almost certainly a mis-scripted deployment.
    error ZeroExecutor();

    /// @notice Emitted for every relayed call. Monitoring keys off the TARGET's own events
    ///         (design §8); this is the audit trail of who asked.
    event Relayed(address indexed caller, address indexed target, bytes4 indexed selector);
    event BoundTargetSet(bytes4 indexed selector, address indexed target);

    /// @param initialDelay      DEFAULT_ADMIN handover delay (24h at launch). The admin may later
    ///                          change it via `changeDefaultAdminDelay` (honoring the old delay,
    ///                          increases capped at 5 days) — a monitored call, not a guarantee.
    /// @param admin_            the cold role administrator (hardware/multisig on mainnet: the
    ///                          24h delay gates HANDOVER only, never an admin compromise).
    /// @param executor_         the hot backend key receiving the standing selector grants.
    /// @param executorSelectors the exact selectors the executor may relay at deploy.
    constructor(uint48 initialDelay, address admin_, address executor_, bytes4[] memory executorSelectors)
        AccessControlDefaultAdminRules(initialDelay, admin_)
    {
        uint256 len = executorSelectors.length;
        if (len != 0 && executor_ == address(0)) revert ZeroExecutor();
        for (uint256 i = 0; i < len; i++) {
            bytes4 selector = executorSelectors[i];
            // Same partition guard the relay enforces, applied at grant time so a mis-scripted
            // deploy cannot even record a role in the admin/wildcard namespace.
            if (selector == bytes4(0) || bytes32(selector) == WILDCARD_ROLE) revert InvalidSelector();
            _grantRole(bytes32(selector), executor_);
        }
    }

    /// @notice Pin (or unpin, with `address(0)`) the only target a selector may be relayed to.
    /// @dev    Admin-only and instant: it is a tightening control, and the delay that matters for
    ///         governance is on the admin role itself.
    function setBoundTarget(bytes4 selector, address target) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (selector == bytes4(0) || bytes32(selector) == WILDCARD_ROLE) revert InvalidSelector();
        boundTarget[selector] = target;
        emit BoundTargetSet(selector, target);
    }

    /// @notice The entire runtime surface: relay `msg.data[:len-20]` to the address encoded in the
    ///         final 20 bytes, if the caller holds that selector's role (or WILDCARD).
    /// @dev    Non-payable and without a `receive`, so the controller never holds or forwards
    ///         native value (Arc's gas token is USDC — dust sent here is refused, not trapped).
    ///         Return data and reverts are copied back verbatim so vault custom errors reach the
    ///         backend SDK intact.
    fallback() external {
        if (msg.data.length < 24) revert MsgDataInvalid();

        bytes4 selector = bytes4(msg.data[0:4]);
        // M1. The zero check is load-bearing (bytes32(bytes4(0)) == DEFAULT_ADMIN_ROLE); the
        // WILDCARD check is unreachable for a left-aligned selector and is kept as an assertion
        // of the partition, so the invariant survives any future change to WILDCARD_ROLE.
        if (selector == bytes4(0) || bytes32(selector) == WILDCARD_ROLE) revert InvalidSelector();

        address target = address(bytes20(msg.data[msg.data.length - 20:]));

        if (!hasRole(bytes32(selector), msg.sender) && !hasRole(WILDCARD_ROLE, msg.sender)) {
            revert NotAuthorized(selector, msg.sender);
        }

        address bound = boundTarget[selector];
        if (bound != address(0) && target != bound) revert TargetNotBound(selector, target);

        // EXTCODESIZE also warms the target, so the CALL below pays the warm price: the guard is
        // effectively free relative to an unguarded relay.
        if (target.code.length == 0) revert TargetNotContract(target);

        emit Relayed(msg.sender, target, selector);

        (bool ok, bytes memory ret) = target.call(msg.data[0:msg.data.length - 20]);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        assembly {
            return(add(ret, 0x20), mload(ret))
        }
    }

    /// @notice Accept ERC-721 custody: the factory hands over each agent's identity NFT.
    /// @dev    The factory uses a non-callback `transferFrom` today; implementing the hook keeps
    ///         `_safeMint`/`safeTransferFrom` flows (e.g. registering directly) from bricking.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev M2. Blocks every path to a self-held role (constructor, `grantRole`, and any future
    ///      internal grant), which is what makes the relay's reentrancy analysis a guarantee
    ///      rather than an operational promise: a relayed call that bounces back into `fallback`
    ///      arrives with `msg.sender == address(this)`, which can never hold a role.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (account == address(this)) revert SelfRoleForbidden();
        return super._grantRole(role, account);
    }
}
