// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test double for the ERC-8004 ReputationRegistry. The real contract blocks
// self-feedback (an agent rating itself); that guard is intentionally omitted
// here because our recorder is always the evaluator EOA (never the provider),
// so it is untestable via this double — the live test exercises the real guard.
contract MockReputationRegistry {
    event Feedback(uint256 indexed agentId, address indexed from, int128 value, bytes32 feedbackHash);

    mapping(uint256 => uint256) public count;

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        count[agentId]++;
        emit Feedback(agentId, msg.sender, value, feedbackHash);
    }
}
