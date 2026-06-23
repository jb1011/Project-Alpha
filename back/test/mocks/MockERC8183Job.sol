// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Note: expiry (expiredAt) and cancel/dispute paths are intentionally not enforced in this test double.

interface IERC20 { function transferFrom(address,address,uint256) external returns (bool); function transfer(address,uint256) external returns (bool); }

contract MockERC8183Job {
    /// @notice Mirrors the real on-chain Job struct (verified 2026-06-22).
    /// Status enum: Open=0, Funded=1, Submitted=2, Completed=3, Rejected=4, Expired=5.
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

    IERC20 public immutable usdc;
    uint256 public jobCounter;
    mapping(uint256 => Job) public jobs;
    /// @notice Submitted deliverable stored separately (not in Job struct).
    /// To read a deliverable, query the Submitted event log — this mapping is a convenience accessor.
    mapping(uint256 => bytes32) public deliverableOf;

    event JobCreated(uint256 indexed jobId, address indexed provider, address indexed evaluator);
    event Submitted(uint256 indexed jobId, bytes32 deliverable);
    event Completed(uint256 indexed jobId, address indexed provider, uint256 amount);

    constructor(address _usdc) { usdc = IERC20(_usdc); }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        jobId = jobCounter++;
        jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: 0, // Open
            hook: hook
        });
        emit JobCreated(jobId, provider, evaluator);
    }

    /// @dev Real contract enforces msg.sender == provider (verified on-chain).
    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        require(msg.sender == jobs[jobId].provider, "not provider");
        jobs[jobId].budget = amount;
    }

    function fund(uint256 jobId, bytes calldata) external {
        Job storage j = jobs[jobId];
        require(msg.sender == j.client, "not client");
        require(j.budget > 0, "budget not set");
        require(usdc.transferFrom(msg.sender, address(this), j.budget), "transferFrom");
        j.status = 1; // Funded
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        Job storage j = jobs[jobId];
        require(msg.sender == j.provider, "not provider");
        deliverableOf[jobId] = deliverable;
        j.status = 2; // Submitted
        emit Submitted(jobId, deliverable);
    }

    function complete(uint256 jobId, bytes32, bytes calldata) external {
        Job storage j = jobs[jobId];
        require(msg.sender == j.evaluator, "not evaluator");
        require(j.status == 2, "not submitted"); // Submitted
        j.status = 3; // Completed
        require(usdc.transfer(j.provider, j.budget), "payout");
        emit Completed(jobId, j.provider, j.budget);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
