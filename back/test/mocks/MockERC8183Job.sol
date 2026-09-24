// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Note: `expiredAt` is enforced by `claimRefund` ONLY — no other entry point here reads the
// deadline, and `submit`/`complete` accept a job whose window has passed. The dispute paths the
// real contract carries beyond `reject` (hooks, provider reassignment) are still not implemented.

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
    event Rejected(uint256 indexed jobId, address indexed client, uint256 amount);
    event Expired(uint256 indexed jobId, address indexed client, uint256 amount);

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

    /// @dev The role decides WHICH statuses may be rejected (verified against the deployed
    ///      implementation's semantics): the client owns the Open job, the evaluator the funded
    ///      one. A reject after the money moved into escrow sends it back to the client.
    function reject(uint256 jobId, bytes32, bytes calldata) external {
        Job storage j = jobs[jobId];
        if (msg.sender == j.client) {
            require(j.status == 0, "client: not open"); // Open
        } else if (msg.sender == j.evaluator) {
            require(j.status == 1 || j.status == 2, "evaluator: not funded or submitted");
        } else {
            revert("not client or evaluator");
        }
        uint8 was = j.status;
        j.status = 4; // Rejected
        // Only a job whose budget actually reached escrow has something to give back.
        if (was == 1 || was == 2) {
            require(usdc.transfer(j.client, j.budget), "refund");
            emit Rejected(jobId, j.client, j.budget);
        } else {
            emit Rejected(jobId, j.client, 0);
        }
    }

    /// @dev Permissionless once the deadline has passed — the refund always goes to the CLIENT,
    ///      never to `msg.sender`, so a third party gains nothing by calling it.
    function claimRefund(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.status == 1 || j.status == 2, "not funded or submitted");
        require(block.timestamp > j.expiredAt, "not expired");
        j.status = 5; // Expired
        require(usdc.transfer(j.client, j.budget), "refund");
        emit Expired(jobId, j.client, j.budget);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
