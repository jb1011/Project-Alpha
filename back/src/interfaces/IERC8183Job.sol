// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal subset of the ERC-8183 Agentic-Commerce job contract.
/// Struct and read signatures verified against on-chain implementation
/// 0xa316fd02827242d537f84730f8a37d0ba5fd351a (Arc testnet, 2026-06-22).
interface IERC8183Job {
    /// @notice On-chain job record. Status enum: Open=0 Funded=1 Submitted=2 Completed=3 Rejected=4 Expired=5.
    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        uint8 status;
        address hook;
    }

    // ── Reads ────────────────────────────────────────────────────────────────
    function getJob(uint256 jobId) external view returns (Job memory);
    function jobCounter() external view returns (uint256);

    // ── Writes ───────────────────────────────────────────────────────────────
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    /// @dev Caller must be the provider (verified on-chain: msg.sender != job.provider → Unauthorized).
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}
