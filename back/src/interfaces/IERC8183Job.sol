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

    // ── The two ways an escrow goes BACK to the client ───────────────────────────────────────
    //
    // Both selectors verified present in the deployed implementation's bytecode (2026-09-24):
    // reject(uint256,bytes32,bytes) = 0x41dd26f5, claimRefund(uint256) = 0x5b7baf64. The
    // `string`-reason overload of reject is NOT there, so this is the only shape that exists.

    /// @dev The CLIENT may reject an Open job; the EVALUATOR a Funded or Submitted one. A
    ///      Funded/Submitted reject refunds the client and sets status Rejected=4.
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @dev Permissionless: ANYONE may expire a Funded or Submitted job once `expiredAt` has
    ///      passed. The budget goes back to the CLIENT (never to the caller); status Expired=5.
    function claimRefund(uint256 jobId) external;
}
