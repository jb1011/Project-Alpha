# AgentTreasury Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `AgentTreasury` — an immutable, per-agent, non-custodial on-chain USDC vault that enforces the LLC operating agreement's spending rules in code, and wire it into `LegalManagerFactory`.

**Architecture:** Immutable contract (constructor-initialized, no proxy). An `operator` (the agent's Turnkey EOA) spends within a rolling per-period cap; a `guardian` (human registrant) has instant pause / rotate / rescue-to-fixed-address powers and vetoes policy changes; a `manager` (platform) proposes policy changes through a timelock; spending is blocked once the agent's `LegalManager` leaves the `Active` status. Source spec: `docs/design/2026-06-08-agent-treasury-vault-design.md`.

**Tech Stack:** Solidity 0.8.24, Foundry (`forge`), OpenZeppelin (`SafeERC20`, `ReentrancyGuard`), `evm_version = "paris"` (Arc rejects `PUSH0`). USDC = 6 decimals.

---

## File Structure

- Create: `src/AgentTreasury.sol` — the immutable vault contract (the whole feature lives here).
- Create: `test/mocks/MockLegalManagerStatus.sol` — a minimal mock exposing a settable `status()` so tests can drive the dissolution lock without a full `LegalManager`.
- Create: `test/AgentTreasury.t.sol` — unit + branch tests.
- Create: `test/AgentTreasuryFuzz.t.sol` — fuzz the cap accounting.
- Modify: `src/LegalManagerFactory.sol` — add an `operator` param + `TreasuryConfig`, deploy the vault atomically, register it.
- Modify: `test/LegalManagerFactory.t.sol` — extend for the new param + treasury deployment.

Reused as-is: `test/mocks/MockUSDC.sol` (`mint(to,amount)`, 6 decimals).

Conventions to follow (from the existing suite): `forge-std/Test.sol`, custom errors, `vm.expectRevert(Contract.Error.selector)`, `vm.prank`, `vm.warp`, `vm.expectEmit`.

---

## Task 1: `AgentTreasury` skeleton — constructor, roles, immutable state, views

**Files:**
- Create: `src/AgentTreasury.sol`
- Create: `test/mocks/MockLegalManagerStatus.sol`
- Create: `test/AgentTreasury.t.sol`

- [ ] **Step 1: Write the status mock**

`test/mocks/MockLegalManagerStatus.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal stand-in for LegalManager.status() (0 = Active, 1 = WindingDown, 2 = Dissolved).
contract MockLegalManagerStatus {
    uint8 public status; // defaults to 0 (Active)
    function setStatus(uint8 s) external { status = s; }
}
```

- [ ] **Step 2: Write the failing init test**

`test/AgentTreasury.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockLegalManagerStatus} from "./mocks/MockLegalManagerStatus.sol";

abstract contract AgentTreasuryTestBase is Test {
    MockUSDC internal usdc;
    MockLegalManagerStatus internal legal;
    AgentTreasury internal vault;

    address internal manager  = makeAddr("manager");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal payout   = makeAddr("payout");

    uint256 internal constant CAP    = 500e6;   // 500 USDC
    uint256 internal constant PERIOD = 1 days;
    uint256 internal constant DELAY  = 2 days;

    function _deploy() internal returns (AgentTreasury) {
        return new AgentTreasury(
            address(usdc), address(legal), manager, guardian, operator, payout,
            CAP, PERIOD, DELAY, false
        );
    }

    function setUp() public virtual {
        usdc  = new MockUSDC();
        legal = new MockLegalManagerStatus();
        vault = _deploy();
        usdc.mint(address(vault), 10_000e6);
    }
}

contract AgentTreasuryInitTest is AgentTreasuryTestBase {
    function test_storesRolesAndConfig() public view {
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(vault.legalManager(), address(legal));
        assertEq(vault.manager(), manager);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.operator(), operator);
        assertEq(vault.payoutAddress(), payout);
        assertEq(vault.cap(), CAP);
        assertEq(vault.period(), PERIOD);
        assertEq(vault.policyDelay(), DELAY);
        assertEq(vault.allowlistEnabled(), false);
    }

    function test_initialWindowAndAvailable() public view {
        assertEq(vault.spentInWindow(), 0);
        assertEq(vault.available(), CAP);
        assertEq(vault.paused(), false);
    }
}
```

- [ ] **Step 3: Run the test to verify it fails (no contract yet)**

Run: `forge test --match-contract AgentTreasuryInitTest -vvv`
Expected: FAIL — `AgentTreasury` source not found / does not compile.

- [ ] **Step 4: Write the contract skeleton**

`src/AgentTreasury.sol`:

```solidity
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

    error ZeroAddress();
    error RolesMustDiffer();
    error DelayTooShort();
    error ZeroAmount();
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
        if (manager_ == guardian_ || manager_ == operator_ || guardian_ == operator_) revert RolesMustDiffer();
        if (policyDelay_ < MIN_POLICY_DELAY) revert DelayTooShort();
        if (period_ == 0) revert ZeroAmount();

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
}
```

- [ ] **Step 5: Run the init test to verify it passes**

Run: `forge test --match-contract AgentTreasuryInitTest -vvv`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/AgentTreasury.sol test/mocks/MockLegalManagerStatus.sol test/AgentTreasury.t.sol
git commit -m "feat(treasury): AgentTreasury skeleton — roles, immutable config, available() view"
```

---

## Task 2: Operator `spend()` with rolling-cap accounting

**Files:**
- Modify: `src/AgentTreasury.sol`
- Modify: `test/AgentTreasury.t.sol`

- [ ] **Step 1: Write failing tests**

Append to `test/AgentTreasury.t.sol`:

```solidity
contract AgentTreasurySpendTest is AgentTreasuryTestBase {
    address internal payee = makeAddr("payee");

    event Spent(address indexed to, uint256 amount);

    function test_operatorCanSpendWithinCap() public {
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit Spent(payee, 100e6);
        vault.spend(payee, 100e6);
        assertEq(usdc.balanceOf(payee), 100e6);
        assertEq(vault.spentInWindow(), 100e6);
        assertEq(vault.available(), CAP - 100e6);
    }

    function test_nonOperatorCannotSpend() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        vault.spend(payee, 1e6);
    }

    function test_spendRevertsOverCap() public {
        vm.prank(operator);
        vault.spend(payee, CAP); // uses the whole cap
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.CapExceeded.selector);
        vault.spend(payee, 1);
    }

    function test_capResetsAfterPeriod() public {
        vm.prank(operator);
        vault.spend(payee, CAP);
        vm.warp(block.timestamp + PERIOD); // new window
        assertEq(vault.available(), CAP);
        vm.prank(operator);
        vault.spend(payee, CAP);
        assertEq(usdc.balanceOf(payee), 2 * CAP);
    }

    function test_spendRejectsZeroAddressAndZeroAmount() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        vault.spend(address(0), 1e6);
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.ZeroAmount.selector);
        vault.spend(payee, 0);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract AgentTreasurySpendTest -vvv`
Expected: FAIL — `spend` not defined.

- [ ] **Step 3: Implement `spend` + internal cap/active helpers**

Add to `src/AgentTreasury.sol` (inside the contract, after `available()`):

```solidity
    event Spent(address indexed to, uint256 amount);

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

    /// @notice Capped on-chain USDC payment by the agent operator.
    function spend(address to, uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _requireSpendable(to);
        if (allowlistEnabled && !isAllowed[to]) revert NotAllowed();
        _useCap(amount);
        usdc.safeTransfer(to, amount);
        emit Spent(to, amount);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `forge test --match-contract AgentTreasurySpendTest -vvv`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add src/AgentTreasury.sol test/AgentTreasury.t.sol
git commit -m "feat(treasury): operator spend() with rolling per-period cap"
```

---

## Task 3: Operator `fundOperator()` (replenish the hot EOA)

**Files:**
- Modify: `src/AgentTreasury.sol`
- Modify: `test/AgentTreasury.t.sol`

- [ ] **Step 1: Write failing test**

Append to `test/AgentTreasury.t.sol`:

```solidity
contract AgentTreasuryFundOperatorTest is AgentTreasuryTestBase {
    event OperatorFunded(address indexed operator, uint256 amount);

    function test_fundOperatorTransfersToOperatorAndUsesCap() public {
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit OperatorFunded(operator, 200e6);
        vault.fundOperator(200e6);
        assertEq(usdc.balanceOf(operator), 200e6);
        assertEq(vault.available(), CAP - 200e6);
    }

    function test_fundOperatorShareSameCapAsSpend() public {
        vm.prank(operator);
        vault.fundOperator(CAP - 50e6);
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.CapExceeded.selector);
        vault.spend(makeAddr("p"), 51e6);
    }

    function test_onlyOperatorFunds() public {
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        vault.fundOperator(1e6);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract AgentTreasuryFundOperatorTest -vvv`
Expected: FAIL — `fundOperator` not defined.

- [ ] **Step 3: Implement `fundOperator`**

Add to `src/AgentTreasury.sol` (after `spend`):

```solidity
    event OperatorFunded(address indexed operator, uint256 amount);

    /// @notice Top up the operator's hot EOA (for x402/Gateway/nanopayments), within the same cap.
    function fundOperator(uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (paused) revert IsPaused();
        if (ILegalManagerStatus(legalManager).status() != 0) revert LegalNotActive();
        _useCap(amount);
        usdc.safeTransfer(operator, amount);
        emit OperatorFunded(operator, amount);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `forge test --match-contract AgentTreasuryFundOperatorTest -vvv`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add src/AgentTreasury.sol test/AgentTreasury.t.sol
git commit -m "feat(treasury): fundOperator() replenishes hot EOA within the cap"
```

---

## Task 4: Guardian pause/unpause + dissolution lock

**Files:**
- Modify: `src/AgentTreasury.sol`
- Modify: `test/AgentTreasury.t.sol`

- [ ] **Step 1: Write failing tests**

Append to `test/AgentTreasury.t.sol`:

```solidity
contract AgentTreasuryPauseLockTest is AgentTreasuryTestBase {
    address internal payee = makeAddr("payee2");

    function test_guardianPauseBlocksSpend() public {
        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.IsPaused.selector);
        vault.spend(payee, 1e6);
    }

    function test_guardianUnpauseRestoresSpend() public {
        vm.prank(guardian);
        vault.pause();
        vm.prank(guardian);
        vault.unpause();
        vm.prank(operator);
        vault.spend(payee, 1e6);
        assertEq(usdc.balanceOf(payee), 1e6);
    }

    function test_onlyGuardianPauses() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotGuardian.selector);
        vault.pause();
    }

    function test_dissolutionBlocksSpendAndFund() public {
        legal.setStatus(1); // WindingDown
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.LegalNotActive.selector);
        vault.spend(payee, 1e6);
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.LegalNotActive.selector);
        vault.fundOperator(1e6);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract AgentTreasuryPauseLockTest -vvv`
Expected: FAIL — `pause`/`unpause` not defined.

- [ ] **Step 3: Implement pause/unpause**

Add to `src/AgentTreasury.sol`:

```solidity
    event Paused();
    event Unpaused();

    function pause() external onlyGuardian { paused = true; emit Paused(); }
    function unpause() external onlyGuardian { paused = false; emit Unpaused(); }
```

(The dissolution-lock assertions already pass via the `ILegalManagerStatus(...).status() != 0` checks added in Tasks 2–3.)

- [ ] **Step 4: Run to verify pass**

Run: `forge test --match-contract AgentTreasuryPauseLockTest -vvv`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/AgentTreasury.sol test/AgentTreasury.t.sol
git commit -m "feat(treasury): guardian pause/unpause + dissolution spend-lock"
```

---

## Task 5: Guardian `setOperator`, `setAllowlistEntry`, `emergencyWithdraw`

**Files:**
- Modify: `src/AgentTreasury.sol`
- Modify: `test/AgentTreasury.t.sol`

- [ ] **Step 1: Write failing tests**

Append to `test/AgentTreasury.t.sol`:

```solidity
contract AgentTreasuryGuardianPowersTest is AgentTreasuryTestBase {
    address internal newOp = makeAddr("newOperator");

    event OperatorRotated(address indexed previous, address indexed next);
    event EmergencyWithdrawn(address indexed payoutAddress, uint256 amount);

    function test_guardianRotatesOperator() public {
        vm.prank(guardian);
        vm.expectEmit(true, true, false, false);
        emit OperatorRotated(operator, newOp);
        vault.setOperator(newOp);
        assertEq(vault.operator(), newOp);
        // old operator can no longer spend
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        vault.spend(makeAddr("x"), 1e6);
    }

    function test_setOperatorRejectsZero() public {
        vm.prank(guardian);
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        vault.setOperator(address(0));
    }

    function test_emergencyWithdrawSweepsToPayout() public {
        uint256 bal = usdc.balanceOf(address(vault));
        vm.prank(guardian);
        vm.expectEmit(true, false, false, true);
        emit EmergencyWithdrawn(payout, bal);
        vault.emergencyWithdraw();
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(payout), bal);
    }

    function test_onlyGuardianEmergencyWithdraw() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotGuardian.selector);
        vault.emergencyWithdraw();
    }

    function test_guardianManagesAllowlist() public {
        address ok = makeAddr("ok");
        vm.prank(guardian);
        vault.setAllowlistEntry(ok, true);
        assertTrue(vault.isAllowed(ok));
        vm.prank(guardian);
        vault.setAllowlistEntry(ok, false);
        assertFalse(vault.isAllowed(ok));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract AgentTreasuryGuardianPowersTest -vvv`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the three guardian functions**

Add to `src/AgentTreasury.sol`:

```solidity
    event OperatorRotated(address indexed previous, address indexed next);
    event AllowlistUpdated(address indexed account, bool allowed);
    event EmergencyWithdrawn(address indexed payoutAddress, uint256 amount);

    function setOperator(address newOperator) external onlyGuardian {
        if (newOperator == address(0)) revert ZeroAddress();
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
```

- [ ] **Step 4: Run to verify pass**

Run: `forge test --match-contract AgentTreasuryGuardianPowersTest -vvv`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add src/AgentTreasury.sol test/AgentTreasury.t.sol
git commit -m "feat(treasury): guardian setOperator / allowlist / emergencyWithdraw"
```

---

## Task 6: Allowlist enforcement in `spend`

**Files:**
- Modify: `test/AgentTreasury.t.sol` (logic already present from Task 2 — this task proves it under `allowlistEnabled = true`)

- [ ] **Step 1: Write failing test (deploy with allowlist ON)**

Append to `test/AgentTreasury.t.sol`:

```solidity
contract AgentTreasuryAllowlistTest is AgentTreasuryTestBase {
    function setUp() public override {
        super.setUp();
        // redeploy with allowlist enabled
        vault = new AgentTreasury(
            address(usdc), address(legal), manager, guardian, operator, payout,
            CAP, PERIOD, DELAY, true
        );
        usdc.mint(address(vault), 10_000e6);
    }

    function test_spendBlockedForNonAllowlisted() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotAllowed.selector);
        vault.spend(makeAddr("stranger"), 1e6);
    }

    function test_spendAllowedAfterGuardianAllowlists() public {
        address ok = makeAddr("ok");
        vm.prank(guardian);
        vault.setAllowlistEntry(ok, true);
        vm.prank(operator);
        vault.spend(ok, 1e6);
        assertEq(usdc.balanceOf(ok), 1e6);
    }

    function test_fundOperatorExemptFromAllowlist() public {
        vm.prank(operator);
        vault.fundOperator(5e6); // operator not on allowlist, still allowed
        assertEq(usdc.balanceOf(operator), 5e6);
    }
}
```

- [ ] **Step 2: Run**

Run: `forge test --match-contract AgentTreasuryAllowlistTest -vvv`
Expected: PASS (all 3) — the `allowlistEnabled` branch in `spend` and the allowlist-exempt `fundOperator` were implemented in Tasks 2–3. If any fail, fix the corresponding branch in `spend`/`fundOperator`.

- [ ] **Step 3: Commit**

```bash
git add test/AgentTreasury.t.sol
git commit -m "test(treasury): allowlist-enabled spend + fundOperator exemption"
```

---

## Task 7: Timelocked policy updates (manager proposes → guardian veto → execute)

**Files:**
- Modify: `src/AgentTreasury.sol`
- Modify: `test/AgentTreasury.t.sol`

- [ ] **Step 1: Write failing tests**

Append to `test/AgentTreasury.t.sol`:

```solidity
contract AgentTreasuryPolicyTest is AgentTreasuryTestBase {
    address internal newPayout = makeAddr("newPayout");

    function _schedule() internal returns (bytes32) {
        vm.prank(manager);
        return vault.schedulePolicyUpdate(1000e6, 12 hours, true, newPayout);
    }

    function test_executeAfterDelayAppliesNewPolicy() public {
        bytes32 id = _schedule();
        vm.warp(block.timestamp + DELAY);
        vm.prank(manager);
        vault.executePolicyUpdate(id);
        assertEq(vault.cap(), 1000e6);
        assertEq(vault.period(), 12 hours);
        assertTrue(vault.allowlistEnabled());
        assertEq(vault.payoutAddress(), newPayout);
    }

    function test_executeBeforeDelayReverts() public {
        bytes32 id = _schedule();
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.TooEarly.selector);
        vault.executePolicyUpdate(id);
    }

    function test_guardianVetoBlocksExecute() public {
        bytes32 id = _schedule();
        vm.prank(guardian);
        vault.vetoPolicyUpdate(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.PolicyVetoed.selector);
        vault.executePolicyUpdate(id);
    }

    function test_onlyManagerSchedules() public {
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotManager.selector);
        vault.schedulePolicyUpdate(1, 1, false, newPayout);
    }

    function test_scheduleRejectsZeroPayoutAndZeroPeriod() public {
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.ZeroAddress.selector);
        vault.schedulePolicyUpdate(1, 1, false, address(0));
        vm.prank(manager);
        vm.expectRevert(AgentTreasury.ZeroAmount.selector);
        vault.schedulePolicyUpdate(1, 0, false, newPayout);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract AgentTreasuryPolicyTest -vvv`
Expected: FAIL — policy functions not defined.

- [ ] **Step 3: Implement the policy state + functions**

Add the struct + mapping to the state section of `src/AgentTreasury.sol` (next to `isAllowed`):

```solidity
    struct PendingPolicy {
        uint256 cap;
        uint256 period;
        address payoutAddress;
        bool    allowlistEnabled;
        uint256 executableAt;
        bool    exists;
        bool    vetoed;
    }
    mapping(bytes32 => PendingPolicy) public pendingPolicy;
```

Add the functions to the contract:

```solidity
    event PolicyUpdateScheduled(
        bytes32 indexed policyId, uint256 cap, uint256 period, bool allowlistOn, address payoutAddress, uint256 executableAt
    );
    event PolicyUpdateVetoed(bytes32 indexed policyId);
    event PolicyUpdated(uint256 cap, uint256 period, bool allowlistOn, address payoutAddress);

    function _policyId(uint256 c, uint256 p, bool a, address payout) internal pure returns (bytes32) {
        return keccak256(abi.encode(c, p, a, payout));
    }

    function schedulePolicyUpdate(uint256 newCap, uint256 newPeriod, bool allowlistOn, address newPayout)
        external onlyManager returns (bytes32 policyId)
    {
        if (newPayout == address(0)) revert ZeroAddress();
        if (newPeriod == 0) revert ZeroAmount();
        policyId = _policyId(newCap, newPeriod, allowlistOn, newPayout);
        PendingPolicy storage pp = pendingPolicy[policyId];
        if (pp.exists && !pp.vetoed) revert AlreadyScheduled();
        uint256 executableAt = block.timestamp + policyDelay;
        pendingPolicy[policyId] = PendingPolicy({
            cap: newCap,
            period: newPeriod,
            payoutAddress: newPayout,
            allowlistEnabled: allowlistOn,
            executableAt: executableAt,
            exists: true,
            vetoed: false
        });
        emit PolicyUpdateScheduled(policyId, newCap, newPeriod, allowlistOn, newPayout, executableAt);
    }

    function vetoPolicyUpdate(bytes32 policyId) external onlyGuardian {
        PendingPolicy storage pp = pendingPolicy[policyId];
        if (!pp.exists) revert NotScheduled();
        pp.vetoed = true;
        emit PolicyUpdateVetoed(policyId);
    }

    function executePolicyUpdate(bytes32 policyId) external onlyManager {
        PendingPolicy storage pp = pendingPolicy[policyId];
        if (!pp.exists) revert NotScheduled();
        if (pp.vetoed) revert PolicyVetoed();
        if (block.timestamp < pp.executableAt) revert TooEarly();
        cap = pp.cap;
        period = pp.period;
        allowlistEnabled = pp.allowlistEnabled;
        payoutAddress = pp.payoutAddress;
        delete pendingPolicy[policyId];
        emit PolicyUpdated(cap, period, allowlistEnabled, payoutAddress);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `forge test --match-contract AgentTreasuryPolicyTest -vvv`
Expected: PASS (all 5).

- [ ] **Step 5: Run the full AgentTreasury suite + commit**

Run: `forge test --match-path test/AgentTreasury.t.sol -vvv`
Expected: PASS (all contracts).

```bash
git add src/AgentTreasury.sol test/AgentTreasury.t.sol
git commit -m "feat(treasury): timelocked, guardian-vetoable policy updates"
```

---

## Task 8: Fuzz the cap accounting

**Files:**
- Create: `test/AgentTreasuryFuzz.t.sol`

- [ ] **Step 1: Write the fuzz test**

`test/AgentTreasuryFuzz.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockLegalManagerStatus} from "./mocks/MockLegalManagerStatus.sol";

contract AgentTreasuryFuzzTest is Test {
    MockUSDC internal usdc;
    MockLegalManagerStatus internal legal;
    AgentTreasury internal vault;
    address internal manager  = makeAddr("manager");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal payout   = makeAddr("payout");
    uint256 internal constant CAP = 500e6;
    uint256 internal constant PERIOD = 1 days;

    function setUp() public {
        usdc = new MockUSDC();
        legal = new MockLegalManagerStatus();
        vault = new AgentTreasury(address(usdc), address(legal), manager, guardian, operator, payout, CAP, PERIOD, 2 days, false);
        usdc.mint(address(vault), 1_000_000e6);
    }

    /// @notice Within a single window, total spent never exceeds the cap.
    function testFuzz_neverExceedsCapInWindow(uint256 a, uint256 b) public {
        a = bound(a, 1, CAP);
        b = bound(b, 1, CAP);
        address p = makeAddr("p");
        vm.prank(operator);
        vault.spend(p, a);
        if (a + b > CAP) {
            vm.prank(operator);
            vm.expectRevert(AgentTreasury.CapExceeded.selector);
            vault.spend(p, b);
        } else {
            vm.prank(operator);
            vault.spend(p, b);
            assertLe(vault.spentInWindow(), CAP);
        }
    }

    /// @notice After a full period elapses, the cap is fully available again.
    function testFuzz_capResetsEachPeriod(uint256 first) public {
        first = bound(first, 1, CAP);
        address p = makeAddr("p");
        vm.prank(operator);
        vault.spend(p, first);
        vm.warp(block.timestamp + PERIOD);
        assertEq(vault.available(), CAP);
        vm.prank(operator);
        vault.spend(p, CAP);
        assertEq(usdc.balanceOf(p), first + CAP);
    }
}
```

- [ ] **Step 2: Run**

Run: `forge test --match-contract AgentTreasuryFuzzTest -vvv`
Expected: PASS (fuzz runs, no counterexamples).

- [ ] **Step 3: Commit**

```bash
git add test/AgentTreasuryFuzz.t.sol
git commit -m "test(treasury): fuzz cap accounting (never exceeds cap; resets per period)"
```

---

## Task 9: Wire `AgentTreasury` into `LegalManagerFactory`

**Files:**
- Modify: `src/LegalManagerFactory.sol`
- Modify: `test/LegalManagerFactory.t.sol`

- [ ] **Step 1: Write failing test**

Append to `test/LegalManagerFactory.t.sol` (a new contract; reuse the file's existing imports/setup style — it already imports the factory, `MockIdentityRegistry`, and deploys a `LegalManager` implementation). Add at top of the file if missing: `import {AgentTreasury} from "../src/AgentTreasury.sol";` and `import {MockUSDC} from "./mocks/MockUSDC.sol";`.

```solidity
contract FactoryTreasuryWiringTest is Test {
    LegalManagerFactory internal factory;
    MockIdentityRegistry internal registry;
    MockUSDC internal usdc;

    address internal beaconOwner = makeAddr("beaconOwner");
    address internal manager  = makeAddr("manager");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal payout   = makeAddr("payout");

    function setUp() public {
        registry = new MockIdentityRegistry();
        usdc = new MockUSDC();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry), beaconOwner);
    }

    function test_createEntityDeploysWiredTreasury() public {
        LegalManagerFactory.TreasuryConfig memory cfg = LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc),
            payoutAddress: payout,
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
        (uint256 agentId, address proxy, address treasury) =
            factory.createEntity(manager, guardian, operator, 2 days, "ipfs://meta", "EIN-1", 1748476800, keccak256("oa"), cfg);

        assertEq(factory.treasuryByAgentId(agentId), treasury);
        AgentTreasury t = AgentTreasury(treasury);
        assertEq(t.manager(), manager);
        assertEq(t.guardian(), guardian);
        assertEq(t.operator(), operator);
        assertEq(t.legalManager(), proxy);
        assertEq(address(t.usdc()), address(usdc));
        assertEq(t.cap(), 500e6);
        assertEq(t.policyDelay(), 2 days); // reuses amendmentDelay
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract FactoryTreasuryWiringTest -vvv`
Expected: FAIL — `TreasuryConfig` / new `createEntity` signature / `treasuryByAgentId` not defined.

- [ ] **Step 3: Modify the factory**

In `src/LegalManagerFactory.sol`:

(a) Add the import after the existing imports:

```solidity
import {AgentTreasury} from "./AgentTreasury.sol";
```

(b) Add the config struct, registry mapping, and event near the existing state (`entities`, `entityByAgentId`, `EntityCreated`):

```solidity
    struct TreasuryConfig {
        address usdc;
        address payoutAddress;
        uint256 cap;
        uint256 period;
        bool    allowlistEnabled;
    }

    mapping(uint256 => address) public treasuryByAgentId; // agentId => AgentTreasury

    event TreasuryCreated(uint256 indexed agentId, address indexed treasury, address indexed operator);
```

(c) Replace the `createEntity` signature and body. New version (adds `operator` + `TreasuryConfig`, deploys the immutable vault, reuses `amendmentDelay` as the treasury `policyDelay`):

```solidity
    function createEntity(
        address manager,
        address guardian,
        address operator,
        uint256 amendmentDelay,
        string calldata metadataURI,
        string calldata ein,
        uint64 formationDate,
        bytes32 operatingAgreementHash,
        TreasuryConfig calldata tcfg
    ) external onlyOwner returns (uint256 agentId, address proxy, address treasury) {
        agentId = identityRegistry.register(metadataURI);

        bytes memory initData = abi.encodeCall(
            LegalManager.initialize,
            (manager, guardian, amendmentDelay, agentId, ein, formationDate, operatingAgreementHash)
        );
        proxy = address(new BeaconProxy(address(beacon), initData));

        treasury = address(new AgentTreasury(
            tcfg.usdc,
            proxy,
            manager,
            guardian,
            operator,
            tcfg.payoutAddress,
            tcfg.cap,
            tcfg.period,
            amendmentDelay,
            tcfg.allowlistEnabled
        ));

        identityRegistry.transferFrom(address(this), manager, agentId);

        entities.push(proxy);
        entityByAgentId[agentId] = proxy;
        treasuryByAgentId[agentId] = treasury;

        emit EntityCreated(agentId, proxy, manager);
        emit TreasuryCreated(agentId, treasury, operator);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `forge test --match-contract FactoryTreasuryWiringTest -vvv`
Expected: PASS.

- [ ] **Step 5: Run the full suite (existing factory tests use the OLD signature — update them)**

Run: `forge test -vvv`
Expected: the pre-existing `LegalManagerFactory.t.sol` tests that call `createEntity(...)` will now FAIL to compile (signature changed). Update each existing `createEntity(` call site in that file to the new signature, passing the four new role/treasury args. Minimal helper to add at the top of the existing test contract(s) and reuse:

```solidity
    function _defaultTreasuryCfg() internal returns (LegalManagerFactory.TreasuryConfig memory) {
        MockUSDC u = new MockUSDC();
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(u), payoutAddress: makeAddr("payout"), cap: 500e6, period: 1 days, allowlistEnabled: false
        });
    }
```

Then change each `factory.createEntity(manager, guardian, DELAY, uri, ein, date, oaHash)` call to
`factory.createEntity(manager, guardian, makeAddr("operator"), DELAY, uri, ein, date, oaHash, _defaultTreasuryCfg())`
and capture the now-three return values `(uint256 agentId, address proxy, address treasury)` (use `,` to ignore `treasury` where unused).

- [ ] **Step 6: Re-run the full suite**

Run: `forge test -vvv`
Expected: PASS (entire suite green).

- [ ] **Step 7: Commit**

```bash
git add src/LegalManagerFactory.sol test/LegalManagerFactory.t.sol
git commit -m "feat(factory): deploy + register a wired AgentTreasury per entity"
```

---

## Task 10: Coverage gate + build sanity

- [ ] **Step 1: Build with the Arc EVM target**

Run: `forge build`
Expected: compiles clean under `evm_version = "paris"` (no `PUSH0`).

- [ ] **Step 2: Coverage**

Run: `forge coverage --match-path 'src/AgentTreasury.sol'`
Expected: `AgentTreasury.sol` lines/statements at 100% (suite standard). If any line is uncovered, add a targeted test in `test/AgentTreasury.t.sol` and re-run.

- [ ] **Step 3: Full suite final pass**

Run: `forge test`
Expected: PASS.

- [ ] **Step 4: Commit any coverage-driven tests**

```bash
git add test/AgentTreasury.t.sol
git commit -m "test(treasury): close coverage gaps to 100%"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** roles (Task 1), spend/cap (2), fundOperator (3), pause + dissolution lock (4), setOperator/allowlist/emergencyWithdraw (5), allowlist enforcement (6), timelocked policy incl. `payoutAddress` (7), fuzz (8), factory wiring + new `operator` param (9), build/coverage (10). All §4–§9 spec behaviors mapped.
- **Type consistency:** `spend`, `fundOperator`, `pause/unpause`, `setOperator`, `setAllowlistEntry`, `emergencyWithdraw`, `schedulePolicyUpdate(uint256,uint256,bool,address)→bytes32`, `vetoPolicyUpdate(bytes32)`, `executePolicyUpdate(bytes32)` are consistent across tasks; events match the contract definitions.
- **Note vs spec:** `executePolicyUpdate` takes the `bytes32 policyId` (params stored in `PendingPolicy`), matching the spec interface; the spec's §10 EIP-1271 path remains deliberately out of scope.
- **Deferred (not in this plan, by design):** binding the agent identity NFT to the operator via ERC-8004 `setAgentWallet` (a backend EIP-712 step), and the Tier-2 hot-EOA topology in production — the contract supports both via `fundOperator`.
