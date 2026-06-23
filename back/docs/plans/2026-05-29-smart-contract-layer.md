# Smart-Contract Layer Implementation Plan

> ⚠️ **HISTORICAL (2026-05-29) — partially SUPERSEDED.** This plan captures the original Phase-1
> build. The shipped contracts have since evolved; where this doc and the code disagree, the **code
> + the `docs/audit/` report are authoritative.** Known drift: `createEntity` now takes an `operator`
> + `TreasuryConfig` and deploys an immutable **`AgentTreasury`** alongside each `LegalManager` (see
> `docs/plans/2026-06-08-agent-treasury-vault.md`); the ERC-8004 interface uses `bytes` metadata and a
> signature-bearing `setAgentWallet` (binding is a separate manager-signed step, not done in the
> factory); dissolution is `initiate → timelock → sweep/sweepNative → finalize` (not
> `completeDissolution`); and sweeps are callable by either authorized role. Read this for intent, not
> current signatures.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy to Arc testnet the on-chain layer that gives an AI agent a "legal body": one custom per-agent `LegalManager` contract (Wyoming managing contract + operating-agreement binding + governance/dissolution) plus a Factory/Beacon/Registry, integrating Arc's live ERC-8004 identity and ERC-8183 job standards.

**Architecture:** Reuse Arc's live ERC-8004 (identity/reputation) and ERC-8183 (jobs) — we only write `LegalManager` (deployed per agent as an upgradeable **Beacon proxy**) and a thin `LegalManagerFactory` (registers the agent on ERC-8004, deploys the proxy, keeps a public registry). `LegalManager` holds the operating-agreement hash + legal metadata, links the ERC-8004 `agentId`, and enforces a delayed, guardian-vetoable amendment/dissolution process (inline timelock + `Pausable`).

**Tech Stack:** Solidity ^0.8.24 (compiled `evmVersion = "paris"`), Foundry (forge), OpenZeppelin Contracts + Contracts-Upgradeable, Arc testnet (chain id 5042002, USDC-as-gas).

**This is Plan 1 of 4** (smart-contract layer → backend → MCP+wizard → demo agent). It produces a fully tested, testnet-deployed contract suite on its own.

---

## ⚠️ Critical build constraints (apply throughout)

- **`evm_version = "paris"`** in `foundry.toml` — Arc rejects the `PUSH0` opcode (Solidity ≥0.8.20 defaults to Shanghai). Deploys fail with `Create2: Failed on deploy` otherwise.
- **USDC = 6 decimals**, address on Arc `0x3600000000000000000000000000000000000000`. Native gas is paid in USDC (18-dec native units) — but our contracts only ever touch the **ERC-20 USDC** (6 dec). Never hardcode addresses in logic; pass them in.
- **Single-block finality** on Arc — no multi-confirmation logic needed.
- ERC-8004 IdentityRegistry (Arc testnet): `0x8004A818BFB912233c491871b3d84c89A494BD9e`. ERC-8183 Job: `0x0747EEf0706327138c69792bF28Cd525089e4583`. (Confirm via Circle MCP at build time — `STACK_REFERENCE.md` §1.)

## File Structure

- `foundry.toml` — Foundry config (paris, remappings, Arc profile)
- `.env.example` — env template (RPC, keys — never commit real values)
- `src/interfaces/IIdentityRegistry.sol` — minimal ERC-8004 identity interface we consume
- `src/interfaces/IERC8183Job.sol` — minimal ERC-8183 job interface (for later layers; defined here for completeness)
- `src/LegalManager.sol` — the one custom contract (per-agent, upgradeable via beacon)
- `src/LegalManagerFactory.sol` — beacon + factory + registry
- `test/mocks/MockIdentityRegistry.sol` — test double for ERC-8004
- `test/mocks/MockUSDC.sol` — 6-decimal ERC-20 for dissolution sweep tests
- `test/LegalManager.t.sol` — unit tests for the manager
- `test/LegalManagerFactory.t.sol` — factory/registry/beacon tests
- `script/Deploy.s.sol` — deploy beacon + factory to Arc testnet

---

## Task 1: Foundry project scaffold + config

**Files:**
- Create: `foundry.toml`, `.env.example`, `.gitignore` (append)

- [ ] **Step 1: Initialize Foundry in the repo root (without overwriting existing files)**

Run:
```bash
forge init --no-git --no-commit --force
```
Then remove the sample contracts Foundry generates so they don't pollute the suite:
```bash
rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol
```

- [ ] **Step 2: Install OpenZeppelin dependencies**

Run:
```bash
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0 --no-git
```

- [ ] **Step 3: Write `foundry.toml`**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"
evm_version = "paris"            # REQUIRED: Arc rejects PUSH0 (Shanghai)
optimizer = true
optimizer_runs = 200
remappings = [
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
]

[rpc_endpoints]
arc_testnet = "${ARC_TESTNET_RPC_URL}"
```

- [ ] **Step 4: Write `.env.example`**

```bash
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
# Deployer key — for LOCAL/testnet only. Prefer `cast wallet import` for anything shared.
PRIVATE_KEY=
# ERC-8004 IdentityRegistry on Arc testnet (verify via Circle MCP before deploy)
IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
```

- [ ] **Step 5: Append Foundry artifacts to `.gitignore`**

Add these lines to `.gitignore` (the repo already ignores `.env`, `cache/`, `out/`):
```
# Foundry
/out/
/cache/
/broadcast/
```

- [ ] **Step 6: Verify the toolchain builds**

Run: `forge build`
Expected: compiles with **0 contracts** (empty `src/`) and no errors. Confirms remappings + solc + paris are valid.

- [ ] **Step 7: Commit**

```bash
git add foundry.toml .env.example .gitignore lib/ .gitmodules 2>/dev/null; git add -A
git commit -m "chore: scaffold Foundry project with Arc (paris) config + OpenZeppelin"
```

---

## Task 2: ERC-8004 / ERC-8183 interfaces

**Files:**
- Create: `src/interfaces/IIdentityRegistry.sol`, `src/interfaces/IERC8183Job.sol`

- [ ] **Step 1: Write the ERC-8004 identity interface (the subset we consume)**

Create `src/interfaces/IIdentityRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal subset of the ERC-8004 IdentityRegistry we interact with.
/// Verified function shapes from Arc's register-your-first-ai-agent tutorial.
interface IIdentityRegistry {
    /// @dev Mints an agent identity NFT and returns its agentId.
    function register(string calldata metadataURI) external returns (uint256 agentId);

    /// @dev Stores an on-chain key/value against an agent (e.g. EIN, OA hash).
    function setMetadata(uint256 agentId, string calldata key, string calldata value) external;

    function getMetadata(uint256 agentId, string calldata key) external view returns (string memory);

    /// @dev Binds a wallet to the agent identity.
    function setAgentWallet(uint256 agentId, address wallet) external;

    function ownerOf(uint256 agentId) external view returns (address);
}
```

- [ ] **Step 2: Write the ERC-8183 job interface (for later layers; lock the shape now)**

Create `src/interfaces/IERC8183Job.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal subset of the ERC-8183 Agentic-Commerce job contract.
interface IERC8183Job {
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `forge build`
Expected: compiles 2 interfaces, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/interfaces/
git commit -m "feat: add minimal ERC-8004 identity and ERC-8183 job interfaces"
```

---

## Task 3: LegalManager — storage + initialize

**Files:**
- Create: `src/LegalManager.sol`, `test/mocks/MockIdentityRegistry.sol`, `test/LegalManager.t.sol`

- [ ] **Step 1: Write the mock identity registry (test double)**

Create `test/mocks/MockIdentityRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

contract MockIdentityRegistry is IIdentityRegistry {
    uint256 public nextId = 1;
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public wallets;
    mapping(bytes32 => string) private _meta;

    function register(string calldata) external returns (uint256 agentId) {
        agentId = nextId++;
        owners[agentId] = msg.sender;
    }

    function setMetadata(uint256 agentId, string calldata key, string calldata value) external {
        _meta[keccak256(abi.encodePacked(agentId, key))] = value;
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (string memory) {
        return _meta[keccak256(abi.encodePacked(agentId, key))];
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        wallets[agentId] = wallet;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }
}
```

- [ ] **Step 2: Write the failing test for initialization**

Create `test/LegalManager.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegalManager} from "../src/LegalManager.sol";

contract LegalManagerInitTest is Test {
    LegalManager internal lm;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x6UARD);

    function setUp() public {
        lm = new LegalManager();
        lm.initialize(manager, guardian, 2 days, 42, "EIN-99-1234567", 1748476800, keccak256("oa-v1"));
    }

    function test_initialStateIsActive() public view {
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
    }

    function test_storesManagerGuardianAndDelay() public view {
        assertEq(lm.manager(), manager);
        assertEq(lm.guardian(), guardian);
        assertEq(lm.amendmentDelay(), 2 days);
    }

    function test_storesLegalMetadata() public view {
        (string memory ein, uint64 formationDate, bytes32 oaHash, uint256 agentId) = lm.meta();
        assertEq(ein, "EIN-99-1234567");
        assertEq(formationDate, 1748476800);
        assertEq(oaHash, keccak256("oa-v1"));
        assertEq(agentId, 42);
    }

    function test_cannotInitializeTwice() public {
        vm.expectRevert();
        lm.initialize(manager, guardian, 1 days, 1, "x", 1, bytes32(0));
    }
}
```

> Note: `address(0x6UARD)` is invalid hex — replace with a valid literal. Use `address(0x60A12D)` for `guardian` in the test.

Fix that line before running:
```solidity
    address internal guardian = address(0x60A12D);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `forge test --match-contract LegalManagerInitTest -vvv`
Expected: FAIL — `LegalManager.sol` does not exist / does not compile.

- [ ] **Step 4: Write the minimal LegalManager (storage + initialize)**

Create `src/LegalManager.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/// @title LegalManager
/// @notice Per-agent on-chain "managing smart contract" for a Wyoming DAO LLC body.
///         Holds the operating-agreement binding + legal metadata, links the agent's
///         ERC-8004 agentId, and enforces a delayed, guardian-vetoable amendment and
///         dissolution process. Deployed per agent behind an UpgradeableBeacon proxy.
contract LegalManager is Initializable, PausableUpgradeable {
    enum Status { Active, WindingDown, Dissolved }

    struct LegalMeta {
        string ein;
        uint64 formationDate;
        bytes32 operatingAgreementHash;
        uint256 agentId;
    }

    address public manager;   // the agent's controller (e.g. the platform-held wallet)
    address public guardian;  // can veto scheduled amendments / trigger dissolution
    uint256 public amendmentDelay;
    Status public status;
    LegalMeta public meta;

    error NotManager();
    error NotGuardian();
    error NotActive();

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
        __Pausable_init();
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
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `forge test --match-contract LegalManagerInitTest -vvv`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/LegalManager.sol test/mocks/MockIdentityRegistry.sol test/LegalManager.t.sol
git commit -m "feat: LegalManager storage + initialize with legal metadata"
```

---

## Task 4: LegalManager — operating-agreement amendment (delay + guardian veto)

**Files:**
- Modify: `src/LegalManager.sol`
- Modify: `test/LegalManager.t.sol`

- [ ] **Step 1: Write failing tests for the amendment lifecycle**

Append to `test/LegalManager.t.sol`:
```solidity
contract LegalManagerAmendTest is Test {
    LegalManager internal lm;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);
    address internal stranger = address(0xBAD);

    function setUp() public {
        lm = new LegalManager();
        lm.initialize(manager, guardian, 2 days, 1, "EIN", 1, keccak256("oa-v1"));
    }

    function test_managerSchedulesAndExecutesAfterDelay() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);

        vm.warp(block.timestamp + 2 days);
        vm.prank(manager);
        lm.executeOperatingAgreementUpdate(newHash);

        (, , bytes32 oaHash, ) = lm.meta();
        assertEq(oaHash, newHash);
    }

    function test_cannotExecuteBeforeDelay() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);

        vm.prank(manager);
        vm.expectRevert(LegalManager.TooEarly.selector);
        lm.executeOperatingAgreementUpdate(newHash);
    }

    function test_guardianCanVeto() public {
        bytes32 newHash = keccak256("oa-v2");
        vm.prank(manager);
        lm.scheduleOperatingAgreementUpdate(newHash);

        vm.prank(guardian);
        lm.cancelOperatingAgreementUpdate(newHash);

        vm.warp(block.timestamp + 2 days);
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotScheduled.selector);
        lm.executeOperatingAgreementUpdate(newHash);
    }

    function test_strangerCannotSchedule() public {
        vm.prank(stranger);
        vm.expectRevert(LegalManager.NotManager.selector);
        lm.scheduleOperatingAgreementUpdate(keccak256("x"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract LegalManagerAmendTest -vvv`
Expected: FAIL — functions/errors not defined.

- [ ] **Step 3: Implement the amendment mechanism**

In `src/LegalManager.sol`, add the new errors next to the existing ones:
```solidity
    error TooEarly();
    error NotScheduled();
```
Add events after the structs/state:
```solidity
    event AmendmentScheduled(bytes32 indexed newHash, uint256 executableAt);
    event AmendmentCancelled(bytes32 indexed newHash);
    event OperatingAgreementUpdated(bytes32 indexed newHash);

    mapping(bytes32 => uint256) public scheduledAt; // newHash => earliest execution time
```
Add the functions before the closing brace:
```solidity
    function scheduleOperatingAgreementUpdate(bytes32 newHash) external onlyManager whenActive {
        uint256 executableAt = block.timestamp + amendmentDelay;
        scheduledAt[newHash] = executableAt;
        emit AmendmentScheduled(newHash, executableAt);
    }

    function cancelOperatingAgreementUpdate(bytes32 newHash) external onlyGuardian {
        delete scheduledAt[newHash];
        emit AmendmentCancelled(newHash);
    }

    function executeOperatingAgreementUpdate(bytes32 newHash) external onlyManager whenActive {
        uint256 t = scheduledAt[newHash];
        if (t == 0) revert NotScheduled();
        if (block.timestamp < t) revert TooEarly();
        delete scheduledAt[newHash];
        meta.operatingAgreementHash = newHash;
        emit OperatingAgreementUpdated(newHash);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `forge test --match-contract LegalManagerAmendTest -vvv`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/LegalManager.sol test/LegalManager.t.sol
git commit -m "feat: LegalManager delayed, guardian-vetoable OA amendments"
```

---

## Task 5: LegalManager — dissolution (pause + sweep + status)

**Files:**
- Modify: `src/LegalManager.sol`
- Create: `test/mocks/MockUSDC.sol`
- Modify: `test/LegalManager.t.sol`

- [ ] **Step 1: Write the 6-decimal mock USDC**

Create `test/mocks/MockUSDC.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
```

- [ ] **Step 2: Write failing dissolution tests**

Append to `test/LegalManager.t.sol`:
```solidity
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract LegalManagerDissolveTest is Test {
    LegalManager internal lm;
    MockUSDC internal usdc;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);
    address internal treasury = address(0x7EA);

    function setUp() public {
        lm = new LegalManager();
        lm.initialize(manager, guardian, 2 days, 1, "EIN", 1, keccak256("oa-v1"));
        usdc = new MockUSDC();
        usdc.mint(address(lm), 1_000_000); // 1.0 USDC (6 decimals)
    }

    function test_initiateDissolutionPausesAndWindsDown() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.WindingDown));
        assertTrue(lm.paused());
    }

    function test_amendmentsBlockedAfterWindingDown() public {
        vm.prank(guardian);
        lm.initiateDissolution();
        vm.prank(manager);
        vm.expectRevert(LegalManager.NotActive.selector);
        lm.scheduleOperatingAgreementUpdate(keccak256("x"));
    }

    function test_completeDissolutionSweepsAndMarksDissolved() public {
        vm.prank(guardian);
        lm.initiateDissolution();

        vm.prank(manager);
        lm.completeDissolution(address(usdc), treasury);

        assertEq(usdc.balanceOf(treasury), 1_000_000);
        assertEq(usdc.balanceOf(address(lm)), 0);
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Dissolved));
    }

    function test_strangerCannotInitiateDissolution() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.initiateDissolution();
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `forge test --match-contract LegalManagerDissolveTest -vvv`
Expected: FAIL — functions/errors not defined.

- [ ] **Step 4: Implement dissolution**

In `src/LegalManager.sol`, add the import at the top (after the OZ imports):
```solidity
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
```
Add errors:
```solidity
    error NotAuthorized();
    error NotWindingDown();
```
Add events:
```solidity
    event DissolutionInitiated();
    event Dissolved(address indexed token, address indexed payoutTo, uint256 amount);
```
Add functions:
```solidity
    function initiateDissolution() external whenActive {
        if (msg.sender != manager && msg.sender != guardian) revert NotAuthorized();
        status = Status.WindingDown;
        _pause();
        emit DissolutionInitiated();
    }

    function completeDissolution(address token, address payoutTo) external onlyManager {
        if (status != Status.WindingDown) revert NotWindingDown();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            // forge-lint: USDC returns true; revert on failure
            require(IERC20(token).transfer(payoutTo, bal), "sweep failed");
        }
        status = Status.Dissolved;
        emit Dissolved(token, payoutTo, bal);
    }
```

- [ ] **Step 5: Run to verify pass**

Run: `forge test --match-contract LegalManagerDissolveTest -vvv`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full suite**

Run: `forge test -vvv`
Expected: ALL pass (Init + Amend + Dissolve).

- [ ] **Step 7: Commit**

```bash
git add src/LegalManager.sol test/mocks/MockUSDC.sol test/LegalManager.t.sol
git commit -m "feat: LegalManager dissolution (pause + USDC sweep + status)"
```

---

## Task 6: LegalManagerFactory + Beacon + Registry

**Files:**
- Create: `src/LegalManagerFactory.sol`, `test/LegalManagerFactory.t.sol`

- [ ] **Step 1: Write failing factory tests**

Create `test/LegalManagerFactory.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract LegalManagerFactoryTest is Test {
    LegalManagerFactory internal factory;
    MockIdentityRegistry internal registry;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);

    function setUp() public {
        registry = new MockIdentityRegistry();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry));
    }

    function test_createEntityRegistersAgentAndDeploysProxy() public {
        (uint256 agentId, address proxy) = factory.createEntity(
            manager, guardian, 2 days, "ipfs://meta", "EIN-1", 1, keccak256("oa")
        );

        assertEq(agentId, 1);
        assertTrue(proxy != address(0));

        LegalManager lm = LegalManager(proxy);
        assertEq(lm.manager(), manager);
        (, , bytes32 oaHash, uint256 storedId) = lm.meta();
        assertEq(oaHash, keccak256("oa"));
        assertEq(storedId, 1);
    }

    function test_registryTracksEntities() public {
        factory.createEntity(manager, guardian, 1 days, "ipfs://a", "EIN-1", 1, keccak256("a"));
        factory.createEntity(manager, guardian, 1 days, "ipfs://b", "EIN-2", 2, keccak256("b"));

        assertEq(factory.entitiesCount(), 2);
        assertEq(factory.entityByAgentId(1) != address(0), true);
        assertEq(factory.entityByAgentId(2) != address(0), true);
    }

    function test_emitsEntityCreated() public {
        vm.recordLogs();
        (uint256 agentId, address proxy) = factory.createEntity(
            manager, guardian, 1 days, "ipfs://a", "EIN-1", 1, keccak256("a")
        );
        // EntityCreated(agentId, proxy, manager) must have been emitted
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("EntityCreated(uint256,address,address)")) {
                found = true;
                assertEq(uint256(logs[i].topics[1]), agentId);
            }
        }
        assertTrue(found);
        assertTrue(proxy != address(0));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract LegalManagerFactoryTest -vvv`
Expected: FAIL — `LegalManagerFactory.sol` does not exist.

- [ ] **Step 3: Implement the factory + beacon + registry**

Create `src/LegalManagerFactory.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {LegalManager} from "./LegalManager.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title LegalManagerFactory
/// @notice Registers an agent on ERC-8004, deploys a per-agent LegalManager beacon
///         proxy, and maintains a public registry of all created legal bodies.
///         The single UpgradeableBeacon lets every LegalManager proxy be upgraded
///         together (Wyoming requires the managing contract to be upgradeable).
contract LegalManagerFactory {
    UpgradeableBeacon public immutable beacon;
    IIdentityRegistry public immutable identityRegistry;

    address[] public entities;
    mapping(uint256 => address) public entityByAgentId; // agentId => proxy

    event EntityCreated(uint256 indexed agentId, address indexed proxy, address indexed manager);

    constructor(address implementation, address identityRegistry_) {
        // Beacon owner = deployer (in production: the platform governance address).
        beacon = new UpgradeableBeacon(implementation, msg.sender);
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    function createEntity(
        address manager,
        address guardian,
        uint256 amendmentDelay,
        string calldata metadataURI,
        string calldata ein,
        uint64 formationDate,
        bytes32 operatingAgreementHash
    ) external returns (uint256 agentId, address proxy) {
        // 1. Register the agent's on-chain identity (ERC-8004) and capture the agentId.
        agentId = identityRegistry.register(metadataURI);

        // 2. Deploy the per-agent LegalManager behind a beacon proxy, initialized atomically.
        bytes memory initData = abi.encodeWithSelector(
            LegalManager.initialize.selector,
            manager,
            guardian,
            amendmentDelay,
            agentId,
            ein,
            formationDate,
            operatingAgreementHash
        );
        proxy = address(new BeaconProxy(address(beacon), initData));

        // 3. Bind the legal body's manager wallet to the ERC-8004 identity + record it.
        identityRegistry.setAgentWallet(agentId, manager);
        entities.push(proxy);
        entityByAgentId[agentId] = proxy;

        emit EntityCreated(agentId, proxy, manager);
    }

    function entitiesCount() external view returns (uint256) {
        return entities.length;
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `forge test --match-contract LegalManagerFactoryTest -vvv`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/LegalManagerFactory.sol test/LegalManagerFactory.t.sol
git commit -m "feat: LegalManagerFactory with beacon + ERC-8004 registration + registry"
```

---

## Task 7: Beacon fleet-upgrade test

**Files:**
- Create: `test/BeaconUpgrade.t.sol`, `test/mocks/LegalManagerV2.sol`

- [ ] **Step 1: Write a V2 implementation that adds a function**

Create `test/mocks/LegalManagerV2.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegalManager} from "../../src/LegalManager.sol";

contract LegalManagerV2 is LegalManager {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
```

- [ ] **Step 2: Write the failing upgrade test**

Create `test/BeaconUpgrade.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {LegalManagerV2} from "./mocks/LegalManagerV2.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

contract BeaconUpgradeTest is Test {
    LegalManagerFactory internal factory;

    function setUp() public {
        MockIdentityRegistry registry = new MockIdentityRegistry();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry)); // beacon owner = this test
    }

    function test_upgradingBeaconUpgradesAllProxies() public {
        (, address proxyA) = factory.createEntity(address(1), address(2), 1 days, "a", "E1", 1, bytes32(0));
        (, address proxyB) = factory.createEntity(address(3), address(4), 1 days, "b", "E2", 2, bytes32(0));

        LegalManagerV2 v2 = new LegalManagerV2();
        UpgradeableBeacon beacon = factory.beacon();
        beacon.upgradeTo(address(v2)); // msg.sender == this == beacon owner

        // Both existing proxies now expose the new V2 behavior, with state intact.
        assertEq(LegalManagerV2(proxyA).version(), "v2");
        assertEq(LegalManagerV2(proxyB).version(), "v2");
        assertEq(LegalManager(proxyA).manager(), address(1));
    }
}
```

- [ ] **Step 3: Run to verify failure, then pass**

Run: `forge test --match-contract BeaconUpgradeTest -vvv`
Expected: initially FAIL if `version()` missing on the path; after adding the V2 mock it should PASS. (Both files are created in this task — run once; expected PASS.)

- [ ] **Step 4: Run the full suite**

Run: `forge test -vvv`
Expected: ALL tests pass across all contracts.

- [ ] **Step 5: Commit**

```bash
git add test/BeaconUpgrade.t.sol test/mocks/LegalManagerV2.sol
git commit -m "test: beacon upgrade propagates to all LegalManager proxies"
```

---

## Task 8: Arc testnet deploy script + dry run

**Files:**
- Create: `script/Deploy.s.sol`

- [ ] **Step 1: Write the deploy script**

Create `script/Deploy.s.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";

/// @notice Deploys the LegalManager implementation + Factory (which creates the beacon)
///         to Arc testnet, pointed at the live ERC-8004 IdentityRegistry.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");

        vm.startBroadcast(pk);
        LegalManager impl = new LegalManager();
        LegalManagerFactory factory = new LegalManagerFactory(address(impl), identityRegistry);
        vm.stopBroadcast();

        console2.log("LegalManager impl:", address(impl));
        console2.log("LegalManagerFactory:", address(factory));
        console2.log("Beacon:", address(factory.beacon()));
    }
}
```

- [ ] **Step 2: Build to confirm the script compiles**

Run: `forge build`
Expected: compiles, no errors.

- [ ] **Step 3: Dry-run the script locally (no broadcast)**

Set a throwaway env for the simulation:
```bash
PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e \
forge script script/Deploy.s.sol:Deploy
```
Expected: simulation succeeds and prints three addresses. (No on-chain broadcast without `--broadcast`.)

- [ ] **Step 4: Commit the script**

```bash
git add script/Deploy.s.sol
git commit -m "feat: Arc testnet deploy script for LegalManager impl + factory"
```

- [ ] **Step 5: (Manual, gated) Deploy to Arc testnet**

> Only when ready, with a funded testnet key. Fund the deployer from https://faucet.circle.com first.
```bash
cp .env.example .env   # fill PRIVATE_KEY with a funded Arc-testnet key
source .env
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$ARC_TESTNET_RPC_URL" \
  --broadcast
```
Expected: three deployed addresses printed; verify the factory on https://testnet.arcscan.app. Record the addresses in `STACK_REFERENCE.md` (new "Deployed (our contracts)" subsection).

> ⚠️ Before broadcasting, re-confirm the live ERC-8004 IdentityRegistry address on Arc testnet via the Circle MCP server. If `register()` / `setAgentWallet()` signatures differ from `IIdentityRegistry`, update the interface + `MockIdentityRegistry` and re-run `forge test` before deploying.

---

## Self-Review (completed)

**Spec coverage (design §4.2):**
- ERC-8004 identity reuse → `IIdentityRegistry` consumed by Factory (Tasks 2, 6). ✅
- One custom `LegalManager` (OA hash, agentId link, amendments, dissolution) → Tasks 3–5. ✅
- Beacon-proxy upgradeability (Wyoming requirement) → Tasks 6, 7. ✅
- Factory + public registry ("N legal bodies") → Task 6. ✅
- ERC-8183 interface locked for the demo-agent layer → Task 2. ✅
- `evmVersion: "paris"` Arc gotcha → Task 1. ✅
- Deferred (correctly, to later plans): wallet creation, policy translation, doc generation, MCP/wizard, the live ERC-8183 proof-of-life run.

**Placeholder scan:** No TBD/TODO; all code complete. The one inline correction (`0x6UARD` → `0x60A12D`) is called out explicitly in Task 3.

**Type consistency:** `initialize(...)` signature is identical in `LegalManager`, the init tests, and the Factory's `abi.encodeWithSelector`. `meta` tuple destructuring order `(ein, formationDate, operatingAgreementHash, agentId)` matches the struct everywhere. `EntityCreated(uint256,address,address)` topic matches the event. Errors (`NotManager`, `NotGuardian`, `NotActive`, `TooEarly`, `NotScheduled`, `NotAuthorized`, `NotWindingDown`) are all defined in `LegalManager`.

**Remaining open items (from design §8), to settle in later plans:** guardian identity (settlor vs platform key) — here it's just a parameter; BYO-vs-template hero path — a backend concern; SCP-vs-Foundry deploy — this plan uses Foundry, the backend may additionally use SCP.
