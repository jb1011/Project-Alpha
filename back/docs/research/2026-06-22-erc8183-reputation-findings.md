# ERC-8183 Job + ERC-8004 ReputationRegistry — Verified Findings

**Date:** 2026-06-22  
**Task:** Track C / Task 0.1  
**Probe script:** `backend/scripts/probe-erc8183.mts`  
**Network:** Arc Testnet (chainId 5042002)  
**Evidence:** live on-chain reads + verified source from `testnet.arcscan.app`

---

## Contract Addresses

| Contract | Proxy | Implementation |
|----------|-------|---------------|
| ERC-8183 Job (`AgenticCommerce`) | `0x0747EEf0706327138c69792bF28Cd525089e4583` | `0xa316fd02827242d537f84730f8a37d0ba5fd351a` |
| ERC-8004 ReputationRegistry (`ReputationRegistryUpgradeable`) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | — |
| USDC (Arc testnet) | `0x3600000000000000000000000000000000000000` | — |

**Impl addresses confirmed on-chain** by reading EIP-1967 slot `0x3608...bbc` from each proxy.

---

## Live State Snapshot (2026-06-22)

- `jobCounter()` = **132033** (contract is heavily used on testnet)
- `paymentToken()` = `0x3600...0000` — matches USDC in `addresses.arc-testnet.json` ✓
- `platformFeeBP()` = 0 (0%), `evaluatorFeeBP()` = 0 (0%) — fees not yet set on testnet instance
- `platformTreasury()` = `0xcBe5B97a069be3E4B5398663790731fb76aB620D`
- `ReputationRegistry.getVersion()` = `"2.0.0"`
- `ReputationRegistry.getIdentityRegistry()` = `0x8004A818BFB912233c491871b3d84c89A494BD9e` ✓

### Sample Job (jobId=1)
```json
{
  "id": "1",
  "client": "0xBCF83d3B112CBf43B19904e376dd8dee01fE2758",
  "provider": "0x17F6c38b9AC1176d84C03f610cecCa3f00A58Aa8",
  "evaluator": "0xBCF83d3B112CBf43B19904e376dd8dee01fE2758",
  "description": "Review a market brief on stablecoin payments in Asia.",
  "budget": "5000000",
  "expiredAt": "1774569593",
  "status": 3,
  "hook": "0x0000000000000000000000000000000000000000"
}
```
`status: 3` = `JobStatus.Completed`.

---

## Answer to the Five Brief Questions

### Q1: ReputationRegistry address + ABI + recording function + args + role

**CONFIRMED.**

- **Proxy:** `0x8004B663056A597Dffe9eCcC1965A193B7388713`
- **Implementation:** `0x16e0fa7f7c56b9a767e34b192b51f921be31da34`
- **Contract name:** `ReputationRegistryUpgradeable`
- **No special role required** — `giveFeedback` is permissionless (`external`, no role gate)
- **Self-feedback guard:** reverts if `msg.sender` is the owner or an authorized operator of `agentId` (checked via `IIdentityRegistry.isAuthorizedOrOwner`)

**Recording function signature (exact):**
```solidity
function giveFeedback(
    uint256 agentId,
    int128 value,
    uint8 valueDecimals,
    string calldata tag1,
    string calldata tag2,
    string calldata endpoint,
    string calldata feedbackURI,
    bytes32 feedbackHash
) external
```

**Event emitted:**
```solidity
event NewFeedback(
    uint256 indexed agentId,
    address indexed clientAddress,
    uint64 feedbackIndex,
    int128 value,
    uint8 valueDecimals,
    string indexed indexedTag1,
    string tag1,
    string tag2,
    string endpoint,
    string feedbackURI,
    bytes32 feedbackHash
);
```

**Key semantics:**
- `value` is a signed fixed-point score in the range `[-1e38, 1e38]` with `valueDecimals` decimal places (0–18).
- `tag1`/`tag2` are free-form category strings (e.g., `"quality"`, `"delivery"`).
- `feedbackURI` is a URI to off-chain evidence; `feedbackHash` is its `keccak256` digest.
- Feedback is indexed 1-based per `(agentId, clientAddress)` pair and can be revoked by the original caller via `revokeFeedback(agentId, feedbackIndex)`.
- The agent (or its operator) **cannot** give self-feedback — the IdentityRegistry guards against it.

### Q2: Does `fund` pull USDC via `transferFrom` or expect a prior transfer?

**CONFIRMED: `fund` uses `safeTransferFrom`.**

From verified source:
```solidity
function fund(uint256 jobId, bytes calldata optParams) external nonReentrant {
    // ...
    job.status = JobStatus.Funded;
    if (job.budget > 0) {
        paymentToken.safeTransferFrom(job.client, address(this), job.budget);
    }
    emit JobFunded(jobId, job.client, job.budget);
    // ...
}
```

**Consequence for clients (JobAdapter):** The client wallet MUST call `USDC.approve(JOB_PROXY, budget)` BEFORE calling `fund(jobId, optParams)`. The contract will revert if approval is insufficient.

`optParams` is passed through to the hook's `beforeAction`/`afterAction` but is not used by the core `fund` logic itself — it is arbitrary bytes for hook extensibility.

`msg.sender` must equal `job.client` (set at `createJob` time).

### Q3: Does `complete` release escrow to `provider`? What does `reason` (bytes32) mean?

**CONFIRMED: `complete` releases net escrow to `provider`; `reason` is an opaque bytes32 tag.**

From verified source:
```solidity
function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
    // ...
    if (msg.sender != job.evaluator) revert Unauthorized();
    job.status = JobStatus.Completed;

    uint256 amount = job.budget;
    uint256 platformFee = (amount * platformFeeBP) / 10000;
    uint256 evalFee = (amount * evaluatorFeeBP) / 10000;
    uint256 net = amount - platformFee - evalFee;

    if (platformFee > 0) paymentToken.safeTransfer(platformTreasury, platformFee);
    if (evalFee > 0) paymentToken.safeTransfer(job.evaluator, evalFee);
    if (net > 0) paymentToken.safeTransfer(job.provider, net);

    emit JobCompleted(jobId, job.evaluator, reason);
    emit PaymentReleased(jobId, job.provider, net);
    // ...
}
```

**Key semantics:**
- Only `job.evaluator` can call `complete`.
- Releases `net = budget - platformFee - evalFee` USDC to `job.provider`.
- `reason` is an arbitrary `bytes32` passed through to the `JobCompleted` event — callers can use it as a short label (e.g., `bytes32("approved")`, a hash, or `bytes32(0)`). It has no on-chain logic effect.
- On testnet, fees are 0 so `net == budget` and 100% goes to provider.

### Q4: Does `submit` require `msg.sender == provider`?

**CONFIRMED: yes.**

From verified source:
```solidity
function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
    Job storage job = jobs[jobId];
    if (job.id == 0) revert InvalidJob();
    if (
        job.status != JobStatus.Funded &&
        (job.status != JobStatus.Open || job.budget > 0)
    ) revert WrongStatus();
    if (msg.sender != job.provider) revert Unauthorized();
    // ...
}
```

`msg.sender` must equal `job.provider`. The agent's wallet (the Turnkey key bound via `setAgentWallet`) must be the transaction signer.

**Status rules for submit:**
- If budget > 0: job must be `Funded` (normal path).
- If budget == 0: job can be `Open` or `Funded` (zero-budget jobs skip escrow).

**Signature:**
```solidity
function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external
```
`deliverable` is a `bytes32` (e.g., IPFS CID hash or work-product hash).

### Q5: `getJob`/`jobs(jobId)` return shape and `jobCounter()` getter

**CONFIRMED.**

**`getJob(uint256 jobId)` returns:**
```solidity
struct Job {
    uint256 id;
    address client;
    address provider;
    address evaluator;
    string  description;
    uint256 budget;      // in USDC base units (6 decimals)
    uint256 expiredAt;   // unix timestamp
    uint8   status;      // enum JobStatus { Open=0, Funded=1, Submitted=2, Completed=3, Rejected=4, Expired=5 }
    address hook;        // IACPHook address or address(0)
}
```

**`jobs(uint256)` (public mapping, flat tuple return):**
```
(uint256 id, address client, address provider, address evaluator, string description,
 uint256 budget, uint256 expiredAt, uint8 status, address hook)
```
Same fields, returned as a flat tuple rather than a named struct.

**`jobCounter()` getter:**
```solidity
function jobCounter() external view returns (uint256)
```
Returns the total number of jobs created (1-indexed; current job ids are 1..jobCounter). Confirmed live: `132033`.

*Note: The exact increment direction (`jobCounter++` vs `++jobCounter`) was not verified from source in this probe. Downstream code MUST read the jobId from the `createJob` event/return value rather than assuming the counter range.*

---

## Additional Findings

### Job Lifecycle (confirmed flow)

```
createJob(provider, evaluator, expiredAt, description, hook)
  → JobStatus.Open
setBudget(jobId, amount, optParams)         // called by provider
  → sets job.budget
fund(jobId, optParams)                      // called by client; requires USDC approve first
  → safeTransferFrom(client, contract, budget) → JobStatus.Funded
submit(jobId, deliverable, optParams)       // called by provider
  → JobStatus.Submitted
complete(jobId, reason, optParams)          // called by evaluator
  → releases USDC to provider → JobStatus.Completed
```

Alternative paths:
- `reject(jobId, reason, optParams)`: client rejects Open job; evaluator rejects Funded/Submitted → refunds to client
- `claimRefund(jobId)`: anyone can expire a Funded/Submitted job after `expiredAt` → refunds to client
- `setProvider(jobId, provider_)`: client can set provider post-creation if `job.provider == address(0)`

### Hook System

The `hook` field is an optional `IACPHook` contract address (whitelisted by admin). `hook == address(0)` disables hooks (most common case). Hooks receive `beforeAction`/`afterAction` calls for `createJob`, `setBudget`, `fund`, `submit`, `complete`, `reject`.

### ReputationRegistry vs Job Integration

The `AgenticCommerce` (Job) contract does **not** reference or call the `ReputationRegistry` directly — there is no on-chain coupling between job completion and reputation recording. The reputation recording (`giveFeedback`) is a separate permissionless transaction that the **client** (or any non-agent party) calls after a job is completed. The agent cannot call `giveFeedback` on itself due to the `isAuthorizedOrOwner` self-feedback guard.

This means our `ReputationAdapter` must:
1. Subscribe to `JobCompleted` events from the Job contract.
2. Allow the relevant client to then call `giveFeedback` on the ReputationRegistry.
3. The agent's own wallet MUST NOT be the signer for `giveFeedback` (would revert).

### Access Control on Job Contract

The `AgenticCommerce` uses OpenZeppelin `AccessControlUpgradeable`:
- `DEFAULT_ADMIN_ROLE` / `ADMIN_ROLE`: admin functions (`setPlatformFee`, `setEvaluatorFee`, `setHookWhitelist`, `upgradeToAndCall`)
- No role required for lifecycle functions — authorization is purely by address match: `client`, `provider`, `evaluator`.

---

## Exact Solidity Signatures for JobAdapter / ReputationAdapter

```solidity
// ── Job (proxy: 0x0747EEf0706327138c69792bF28Cd525089e4583) ──

function createJob(
    address provider,
    address evaluator,
    uint256 expiredAt,
    string calldata description,
    address hook
) external nonReentrant returns (uint256 jobId)

function setBudget(
    uint256 jobId,
    uint256 amount,
    bytes calldata optParams
) external nonReentrant

function fund(
    uint256 jobId,
    bytes calldata optParams
) external nonReentrant
// REQUIRES: USDC.approve(JOB_PROXY, budget) from client before calling

function submit(
    uint256 jobId,
    bytes32 deliverable,
    bytes calldata optParams
) external nonReentrant
// REQUIRES: msg.sender == job.provider

function complete(
    uint256 jobId,
    bytes32 reason,
    bytes calldata optParams
) external nonReentrant
// REQUIRES: msg.sender == job.evaluator
// EFFECT: releases USDC to provider (net of platform + evaluator fees)

function getJob(uint256 jobId) external view returns (Job memory)

function jobs(uint256 jobId) external view returns (
    uint256 id, address client, address provider, address evaluator,
    string memory description, uint256 budget, uint256 expiredAt,
    uint8 status, address hook
)

function jobCounter() external view returns (uint256)

// ── ReputationRegistry (proxy: 0x8004B663056A597Dffe9eCcC1965A193B7388713) ──

function giveFeedback(
    uint256 agentId,
    int128 value,
    uint8 valueDecimals,
    string calldata tag1,
    string calldata tag2,
    string calldata endpoint,
    string calldata feedbackURI,
    bytes32 feedbackHash
) external
// REQUIRES: msg.sender != agent owner/operator (no self-feedback)

function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external
// REQUIRES: msg.sender == original giveFeedback caller

function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
    external view returns (
        int128 value,
        uint8 valueDecimals,
        string memory tag1,
        string memory tag2,
        bool isRevoked
    )

function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)

function getSummary(
    uint256 agentId,
    address[] calldata clientAddresses,
    string calldata tag1,
    string calldata tag2
) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
```

---

## Concerns / Gotchas for Next Tasks

1. **Self-feedback guard blocks agent wallet from giving reputation**: The agent's own address (or any address that `isAuthorizedOrOwner` returns true for) cannot call `giveFeedback`. The `ReputationAdapter` must use a different signer (e.g., the client's EOA) or a trusted third-party oracle.

2. **No native Job→Reputation hook**: The Arc contracts have no on-chain coupling between `complete` and `giveFeedback`. Reputation recording is entirely off-chain-triggered. An event-driven backend listener on `JobCompleted` is required.

3. **USDC approve flow**: The `JobAdapter.fund()` call must first submit an ERC-20 `approve` tx (or use `permit`) and then call `fund`. If the agent is the client, the Turnkey signer must sign two transactions.

4. **`submit` requires provider signer**: The Turnkey key bound to the agent must be the provider address (`job.provider`). Verify the `agentWallet` field in the IdentityRegistry matches the Turnkey key used to sign `submit` transactions.

5. **`complete` is called by evaluator, not provider**: In a self-evaluating scenario (client == evaluator), the client wallet calls `complete`. The agent cannot self-complete a job it is the provider for if it is not also the evaluator.

6. **Testnet fees are 0**: `platformFeeBP` and `evaluatorFeeBP` are both 0 on the live testnet instance. In production this may differ; the `ReputationAdapter` / `JobAdapter` should not hardcode fee assumptions.

7. **`optParams` is pass-through**: The `optParams` bytes argument in `fund`/`submit`/`complete`/`setBudget` is forwarded to hooks only. Safe to pass `"0x"` (empty bytes) unless using a custom hook.
