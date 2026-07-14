# Live-Registry Fork Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the CI fork-coverage gap (V2 roadmap Tier 1 #4): exercise the real register and wallet re-bind paths against the live canonical ERC-8004 IdentityRegistry on an Arc-testnet fork, so CI catches real-registry drift that the mocks cannot.

**Architecture:** One new test contract, `test/IdentityRegistryFork.t.sol`, forks Arc testnet at the latest block via `vm.createSelectFork`, deploys the current `LegalManager` + `LegalManagerFactory` from source against the live registry proxy (`0x8004A818BFB912233c491871b3d84c89A494BD9e`), and drives `createEntity` (register path) and `setAgentWallet` (re-bind path) end-to-end. Tests self-skip (`vm.skip`) when `ARC_TESTNET_RPC_URL` is unset, so the no-env local baseline is unchanged; CI sets the public RPC URL so the fork tests always run there. No contract source changes; ERC-8183 is out of scope (interface-only stubs, nothing wired to fork-test — see the roadmap audit note on Tier 1 #4).

**Tech Stack:** Foundry (forge-std v1.16.1: `vm.createSelectFork`, `vm.skip`, `vm.envOr`), Solidity ^0.8.24 via_ir, OpenZeppelin v5.1.0, Arc testnet (chain id 5042002, public RPC `https://rpc.testnet.arc.network`), GitHub Actions (`.github/workflows/ci.yml`).

**Reference spec:** `docs/Novi-Corpus-V2-Roadmap.html` Tier 1 #4 (recharacterized: "the genuine gap is CI fork coverage of the real paths"); mock-fidelity claims to pin live in `test/mocks/MockIdentityRegistry.sol:20-31` (deadline cap "deadline too far" beyond +300s, verified live 2026-06-16; EIP-712 domain name `ERC8004IdentityRegistry` version `1`, read live 2026-06-15; ERC-721 name `AgentIdentity` deliberately different) and `register` auto-binding the caller as agentWallet (`MockIdentityRegistry.sol:33-38`). Live domain re-verified 2026-07-13 by `cast call eip712Domain()`: fields `0x0f`, name `ERC8004IdentityRegistry`, version `1`, chainId `5042002`, verifyingContract = the proxy itself.

## Global Constraints

- **Test-only + CI-only changes.** Files touched: `test/IdentityRegistryFork.t.sol` (new), `.github/workflows/ci.yml` (one env line), this plan doc. Zero edits under `src/`. Contracts are Martin's area: the result is offered as a PR for his review, never merged solo.
- **Fork = local simulation.** `vm.createSelectFork` copies state lazily over RPC; nothing is broadcast, no gas or USDC is ever spent. Do NOT read or source `back/.env` (house rule); the tests read only `ARC_TESTNET_RPC_URL` via `vm.envOr`, and every command below passes the URL explicitly where needed.
- **Fork the latest block, not a pinned one.** Drift detection is the point: a pinned block would never see a registry proxy upgrade. Accepted cost: CI depends on the public RPC being up.
- **Baseline:** 162 forge tests green on `main` (re-verified 2026-07-13). After this plan: 162 + 9 = 171 pass with `ARC_TESTNET_RPC_URL` set; 162 pass + 9 skip without it.
- **Revert-string strictness calibrated to what was verified live:** assert the exact string only for `"deadline too far"` (verified against the live registry 2026-06-16). All other failure cases use a bare `vm.expectRevert()` — the property under test is "the live registry rejects this", not the exact message.
- **If any fork test fails against the live registry, STOP: that is a real mock-drift finding, not a test bug to paper over.** Diagnose via superpowers:systematic-debugging, and surface it in the PR body for Martin instead of loosening the assertion.
- **Worktree gotcha:** `back/lib` is gitignored (not a submodule) — copy it from the main checkout into any new worktree or `forge build` fails. Place the worktree under `~/Desktop/Solidity_Project_Files/arc-Circle/worktrees/` (NOT the session scratchpad, which wipes tracked files intermittently).
- **Commit style:** conventional commits matching repo history (`test(...)`, `ci: ...`), body explains rationale, trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Git identity is already set locally (Alex Nesta + GitHub noreply). Do not push; stop after the last commit and draft the PR text.

## File Structure

- Create: `back/test/IdentityRegistryFork.t.sol` — the entire feature: fork/skip harness, register-path tests, re-bind-path tests, EIP-712 signing helper against the live domain. Flat in `test/` matching every other suite.
- Modify: `.github/workflows/ci.yml` — add `ARC_TESTNET_RPC_URL` to the contracts job's Test step env (public URL, not a secret).
- Create: `back/docs/plans/2026-07-13-live-registry-fork-tests.md` — this plan (committed with the work, precedent PR #9).

---

## Task 1: Worktree, branch, plan doc, baseline

**Files:**
- Create: worktree at `~/Desktop/Solidity_Project_Files/arc-Circle/worktrees/novi-fork-tests`, branch `test/live-registry-fork-tests`
- Create: `back/docs/plans/2026-07-13-live-registry-fork-tests.md` (copy from the main checkout)

**Interfaces:**
- Consumes: `origin/main @ be64bf8` (or newer; `git fetch` first), `back/lib` from the main checkout.
- Produces: a buildable worktree with the plan committed, that Tasks 2-4 work inside. All later commands run from `<worktree>/back`.

- [ ] **Step 1: Create the worktree and branch**

```bash
cd ~/Desktop/Solidity_Project_Files/arc-Circle/Project-Alpha-monorepo
git fetch origin
mkdir -p ~/Desktop/Solidity_Project_Files/arc-Circle/worktrees
git worktree add ~/Desktop/Solidity_Project_Files/arc-Circle/worktrees/novi-fork-tests -b test/live-registry-fork-tests origin/main
cp -R back/lib ~/Desktop/Solidity_Project_Files/arc-Circle/worktrees/novi-fork-tests/back/lib
```

- [ ] **Step 2: Copy the plan doc into the worktree**

```bash
cp back/docs/plans/2026-07-13-live-registry-fork-tests.md \
   ~/Desktop/Solidity_Project_Files/arc-Circle/worktrees/novi-fork-tests/back/docs/plans/
```

- [ ] **Step 3: Confirm the worktree baseline is green**

Run: `cd ~/Desktop/Solidity_Project_Files/arc-Circle/worktrees/novi-fork-tests/back && forge test`
Expected: `162 tests passed, 0 failed, 0 skipped (162 total tests)`

- [ ] **Step 4: Commit the plan doc**

```bash
cd ~/Desktop/Solidity_Project_Files/arc-Circle/worktrees/novi-fork-tests
git add back/docs/plans/2026-07-13-live-registry-fork-tests.md
git commit -m "docs(plans): live-registry fork-test plan (roadmap Tier 1 #4)

Test-only pickup from the V2 roadmap while Martin is away: CI fork coverage
of the real register / re-bind paths against the canonical ERC-8004
IdentityRegistry on Arc testnet. No contract source changes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Fork harness + register-path tests

**Files:**
- Create: `back/test/IdentityRegistryFork.t.sol`

**Interfaces:**
- Consumes: `LegalManagerFactory.createEntity` (signature at `src/LegalManagerFactory.sol:73-83`), `IIdentityRegistry` (`src/interfaces/IIdentityRegistry.sol`), `MockUSDC` (`test/mocks/MockUSDC.sol`), `LegalManager.meta()` public getter returning `(string ein, uint64 formationDate, bytes32 oaHash, uint256 agentId)`.
- Produces: contract `IdentityRegistryForkTest` with the `onlyFork` skip harness, `_defaultTreasuryCfg()` and `_createEntity()` helpers, and constants (`LIVE_REGISTRY`, `ARC_TESTNET_CHAIN_ID`, `AGENT_WALLET_SET_TYPEHASH`) that Task 3's re-bind tests extend in the same file.

- [ ] **Step 1: Write the harness + the four register-path tests**

Create `back/test/IdentityRegistryFork.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev EIP-5267 subset — the live registry exposes its EIP-712 domain on-chain, so the
///      re-bind tests can sign against the real domain instead of hardcoding it.
interface IERC5267 {
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
}

/// @notice Fork tests of the REAL canonical ERC-8004 IdentityRegistry on Arc testnet
///         (V2 roadmap Tier 1 #4). Every other suite runs against MockIdentityRegistry;
///         these pin the mock's fidelity claims (deadline cap, EIP-712 domain, register
///         auto-bind) to the live contract so CI catches real-registry drift.
/// @dev    Runs only when ARC_TESTNET_RPC_URL is set (CI sets the public RPC; tests
///         self-skip locally without it). Forks the LATEST block deliberately: a pinned
///         block would never see a registry proxy upgrade. Pure local simulation — no
///         transaction is broadcast, nothing is spent.
contract IdentityRegistryForkTest is Test {
    /// @dev The live proxy, same address the deployed factory is wired to
    ///      (src/interfaces/IIdentityRegistry.sol:6, .env.example IDENTITY_REGISTRY).
    address internal constant LIVE_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    bytes32 internal constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    /// @dev Mirrors MockIdentityRegistry.MAX_DEADLINE_DELAY; the live value was verified
    ///      2026-06-16 and is re-pinned by test_rebindDeadlineCapMatchesMock.
    uint256 internal constant MAX_DEADLINE_DELAY = 5 minutes;

    IIdentityRegistry internal registry = IIdentityRegistry(LIVE_REGISTRY);
    LegalManagerFactory internal factory;
    bool internal forked;

    uint256 internal managerPk = 0xA11CE;
    address internal manager;
    address internal guardian = address(0x60A12D);
    address internal operator = address(0x0EEEA7);

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    function setUp() public {
        string memory url = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(url).length == 0) return; // every test self-skips via onlyFork
        vm.createSelectFork(url);
        forked = true;
        manager = vm.addr(managerPk);
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), LIVE_REGISTRY, makeAddr("beaconOwner"));
    }

    function _defaultTreasuryCfg() internal returns (LegalManagerFactory.TreasuryConfig memory) {
        // The treasury's token is incidental to the registry paths under test; a mock
        // USDC deployed onto the fork keeps the real Arc USDC out of the loop.
        MockUSDC usdc = new MockUSDC();
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc),
            payoutAddress: makeAddr("payout"),
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
    }

    function _createEntity() internal returns (uint256 agentId, address proxy, address treasury) {
        (agentId, proxy, treasury) = factory.createEntity(
            manager, guardian, operator, 2 days, "ipfs://fork-test", "EIN-FORK", 1, keccak256("oa"), _defaultTreasuryCfg()
        );
    }

    // ---------------------------------------------------------------- register path

    /// @notice The full register path against the live registry: _safeMint to the factory
    ///         (IERC721Receiver), monotonic agentId, registry writes, NFT hand-off to the
    ///         manager, and the proxy initialized with the live-minted id.
    function test_createEntityRegistersOnLiveRegistry() public onlyFork {
        (uint256 agentId, address proxy, address treasury) = _createEntity();

        assertEq(registry.ownerOf(agentId), manager);
        assertEq(factory.entityByAgentId(agentId), proxy);
        assertEq(factory.treasuryByAgentId(agentId), treasury);
        assertEq(factory.entitiesCount(), 1);
        (,,, uint256 storedId) = LegalManager(payable(proxy)).meta();
        assertEq(storedId, agentId);
    }

    /// @notice The live registry auto-binds register()'s caller — the factory — as the
    ///         agentWallet until the manager re-binds (mock fidelity claim,
    ///         MockIdentityRegistry.sol:33-38).
    function test_registerAutoBindsFactoryAsAgentWallet() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        assertEq(registry.getAgentWallet(agentId), address(factory));
    }

    /// @notice Two entities from one factory get distinct live agentIds and distinct records
    ///         (the AgentIdAlreadyUsed guard's "cannot happen" premise: live ids are monotonic).
    function test_secondEntityGetsDistinctLiveAgentId() public onlyFork {
        (uint256 firstId, address firstProxy,) = _createEntity();
        (uint256 secondId, address secondProxy,) = _createEntity();

        assertTrue(secondId != firstId);
        assertEq(factory.entityByAgentId(firstId), firstProxy);
        assertEq(factory.entityByAgentId(secondId), secondProxy);
        assertEq(factory.entitiesCount(), 2);
    }

    /// @notice Pins the live EIP-712 domain + ERC-721 name the mock claims to mirror
    ///         (MockIdentityRegistry.sol:29-31). If the registry proxy is upgraded and any
    ///         of these drift, this fails before the drift reaches production signing code.
    function test_liveDomainMatchesMockAssumptions() public onlyFork {
        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID);

        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IERC5267(LIVE_REGISTRY).eip712Domain();
        assertEq(uint8(fields), 0x0f); // name + version + chainId + verifyingContract
        assertEq(name, "ERC8004IdentityRegistry");
        assertEq(version, "1");
        assertEq(chainId, ARC_TESTNET_CHAIN_ID);
        assertEq(verifying, LIVE_REGISTRY);

        // ERC-721 name is deliberately different from the EIP-712 domain name.
        assertEq(IERC721Metadata(LIVE_REGISTRY).name(), "AgentIdentity");
    }
}
```

- [ ] **Step 2: Run without the env var — everything must skip, baseline untouched**

Run: `cd <worktree>/back && env -u ARC_TESTNET_RPC_URL forge test`
Expected: `162 tests passed, 0 failed, 4 skipped (166 total tests)` — the 4 new tests report `[SKIP]`, all pre-existing tests pass.
(Note: Foundry auto-loads `back/.env` if present; the worktree has none, but `env -u` makes the skip-path check explicit either way.)

- [ ] **Step 3: Run against the live fork — all four must pass**

Run: `cd <worktree>/back && ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network forge test --match-contract IdentityRegistryForkTest -vv`
Expected: `4 tests passed, 0 failed, 0 skipped`.
If any test FAILS here, stop (Global Constraints): it is a live-registry drift finding. Diagnose, do not weaken the assertion.

- [ ] **Step 4: Commit**

```bash
cd <worktree>
git add back/test/IdentityRegistryFork.t.sol
git commit -m "test(fork): register path against the live Arc ERC-8004 registry

First fork tests in the suite (roadmap Tier 1 #4 — CI fork-coverage gap):
createEntity end-to-end against the canonical IdentityRegistry
(0x8004...BD9e) on an Arc-testnet fork, plus a domain-fidelity test pinning
the EIP-712 domain / ERC-721 name the mock claims to mirror. Tests self-skip
when ARC_TESTNET_RPC_URL is unset, so the no-env local run is unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Re-bind path tests

**Files:**
- Modify: `back/test/IdentityRegistryFork.t.sol` (append to the same contract)

**Interfaces:**
- Consumes: Task 2's harness (`onlyFork`, `_createEntity()`, `AGENT_WALLET_SET_TYPEHASH`, `MAX_DEADLINE_DELAY`, `IERC5267`), `IIdentityRegistry.setAgentWallet` / `getAgentWallet`.
- Produces: `_signWalletSet(uint256 walletPk, uint256 agentId, address newWallet, address owner_, uint256 deadline) returns (bytes memory)` — EIP-712 signature over the LIVE domain (read via `eip712Domain()`, never hardcoded); five re-bind tests.

- [ ] **Step 1: Append the signing helper and the five re-bind tests**

Add inside `IdentityRegistryForkTest`, below the register-path tests:

```solidity
    // ---------------------------------------------------------------- re-bind path

    /// @dev Signs AgentWalletSet over the registry's LIVE EIP-712 domain (read on-chain via
    ///      eip712Domain(), not hardcoded) with the key of the wallet being bound.
    function _signWalletSet(uint256 walletPk, uint256 agentId, address newWallet, address owner_, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IERC5267(LIVE_REGISTRY).eip712Domain();
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        bytes32 structHash = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner_, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice The canonical re-bind: the manager (NFT owner) binds a new wallet with that
    ///         wallet's EIP-712 signature — the step the factory deliberately does NOT do
    ///         on-chain (LegalManagerFactory.sol:17-20), here against the live verifier.
    function test_managerRebindsWalletOnLiveRegistry() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;

        bytes memory sig = _signWalletSet(walletPk, agentId, wallet, manager, deadline);
        vm.prank(manager);
        registry.setAgentWallet(agentId, wallet, deadline, sig);

        assertEq(registry.getAgentWallet(agentId), wallet);
    }

    /// @notice Binding is repeatable: a second re-bind to a different wallet overwrites the first.
    function test_rebindSecondTimeOverwritesFirst() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;

        vm.prank(manager);
        registry.setAgentWallet(agentId, vm.addr(0xBEEF), deadline, _signWalletSet(0xBEEF, agentId, vm.addr(0xBEEF), manager, deadline));
        vm.prank(manager);
        registry.setAgentWallet(agentId, vm.addr(0xCAFE), deadline, _signWalletSet(0xCAFE, agentId, vm.addr(0xCAFE), manager, deadline));

        assertEq(registry.getAgentWallet(agentId), vm.addr(0xCAFE));
    }

    /// @notice Pins the live 5-minute deadline cap the mock encodes (verified live 2026-06-16,
    ///         MockIdentityRegistry.sol:20-22): one second past the cap reverts with the exact
    ///         live string; exactly at the cap succeeds. The production signer relies on this
    ///         bound (registry caps at 300s — see the coverage-audit TODO).
    function test_rebindDeadlineCapMatchesMock() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 cap = block.timestamp + MAX_DEADLINE_DELAY;

        bytes memory sigPastCap = _signWalletSet(walletPk, agentId, wallet, manager, cap + 1);
        vm.prank(manager);
        vm.expectRevert(bytes("deadline too far"));
        registry.setAgentWallet(agentId, wallet, cap + 1, sigPastCap);

        bytes memory sigAtCap = _signWalletSet(walletPk, agentId, wallet, manager, cap);
        vm.prank(manager);
        registry.setAgentWallet(agentId, wallet, cap, sigAtCap);
        assertEq(registry.getAgentWallet(agentId), wallet);
    }

    /// @notice A caller who is not the NFT owner (nor approved) cannot re-bind, even with a
    ///         valid wallet signature. Bare expectRevert: the exact live revert string for
    ///         this case was never verified, and the property is the rejection itself.
    function test_rebindRevertsForNonOwnerCaller() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;
        bytes memory sig = _signWalletSet(walletPk, agentId, wallet, manager, deadline);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        registry.setAgentWallet(agentId, wallet, deadline, sig);
        assertEq(registry.getAgentWallet(agentId), address(factory)); // still the register()-time binding
    }

    /// @notice A signature from a key other than the wallet being bound is rejected (ECDSA
    ///         recovers a different address; the EOA has no ERC-1271 fallback). Bare
    ///         expectRevert for the same reason as above.
    function test_rebindRevertsForWrongSigner() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        address wallet = vm.addr(0xBEEF);
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;
        bytes memory sigFromWrongKey = _signWalletSet(0xD00D, agentId, wallet, manager, deadline);

        vm.prank(manager);
        vm.expectRevert();
        registry.setAgentWallet(agentId, wallet, deadline, sigFromWrongKey);
        assertEq(registry.getAgentWallet(agentId), address(factory));
    }
```

- [ ] **Step 2: Run against the live fork — all nine must pass**

Run: `cd <worktree>/back && ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network forge test --match-contract IdentityRegistryForkTest -vv`
Expected: `9 tests passed, 0 failed, 0 skipped`.
Same stop-rule as Task 2 Step 3 on any failure.

- [ ] **Step 3: Run the full suite both ways**

Run: `cd <worktree>/back && env -u ARC_TESTNET_RPC_URL forge test`
Expected: `162 tests passed, 0 failed, 9 skipped (171 total tests)`

Run: `cd <worktree>/back && ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network forge test`
Expected: `171 tests passed, 0 failed, 0 skipped (171 total tests)`

- [ ] **Step 4: Commit**

```bash
cd <worktree>
git add back/test/IdentityRegistryFork.t.sol
git commit -m "test(fork): wallet re-bind path against the live registry

setAgentWallet end-to-end with a signature over the registry's LIVE EIP-712
domain (read via eip712Domain(), not hardcoded): happy path, second re-bind,
the 5-minute deadline cap pinned to the exact live revert string, and
non-owner / wrong-signer rejections. Pins the fidelity claims
MockIdentityRegistry has carried as comments since 2026-06-16.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: CI wiring + final verification

**Files:**
- Modify: `.github/workflows/ci.yml` (contracts job, Test step env)

**Interfaces:**
- Consumes: the Test step at the end of the `contracts` job (currently env has only `FOUNDRY_FUZZ_RUNS` / `FOUNDRY_INVARIANT_RUNS`).
- Produces: CI runs the fork tests on every push/PR. The URL is the public RPC already published in `.env.example` — plain env, not a secret, so fork PRs work too.

- [ ] **Step 1: Add the RPC URL to the Test step**

In `.github/workflows/ci.yml`, change:

```yaml
      - name: Test
        run: forge test -vv
        env:
          # Reduced depth on routine PRs for fast feedback; full depth only when contracts change.
          FOUNDRY_FUZZ_RUNS: ${{ steps.changes.outputs.contracts == 'true' && '256' || '64' }}
          FOUNDRY_INVARIANT_RUNS: ${{ steps.changes.outputs.contracts == 'true' && '256' || '32' }}
```

to:

```yaml
      - name: Test
        run: forge test -vv
        env:
          # Reduced depth on routine PRs for fast feedback; full depth only when contracts change.
          FOUNDRY_FUZZ_RUNS: ${{ steps.changes.outputs.contracts == 'true' && '256' || '64' }}
          FOUNDRY_INVARIANT_RUNS: ${{ steps.changes.outputs.contracts == 'true' && '256' || '32' }}
          # Public Arc-testnet RPC (same URL as .env.example) so the live-registry fork tests
          # run in CI; without it they self-skip. Plain env, not a secret.
          ARC_TESTNET_RPC_URL: https://rpc.testnet.arc.network
```

- [ ] **Step 2: Sanity-check the workflow YAML parses**

Run: `cd <worktree> && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 3: Re-run the full suite once more exactly as CI will**

Run: `cd <worktree>/back && ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network forge test -vv 2>&1 | tail -3`
Expected: `171 tests passed, 0 failed, 0 skipped (171 total tests)`

- [ ] **Step 4: Commit**

```bash
cd <worktree>
git add .github/workflows/ci.yml
git commit -m "ci: run the live-registry fork tests via the public Arc RPC

ARC_TESTNET_RPC_URL on the forge test step (the public URL already in
.env.example — plain env, not a secret, so fork PRs run it too). Closes the
roadmap Tier 1 #4 CI fork-coverage gap; the tests self-skip anywhere the
variable is absent.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: STOP — do not push**

Draft the PR title + body (offer to Martin for review; note the fork-latest-vs-pinned tradeoff, the public-RPC CI dependency, and that ERC-8183 is out of scope per the roadmap audit note) and hand back for wording review before any `git push`.

---

## Self-Review

- **Spec coverage:** Tier 1 #4's recharacterized gap is "CI fork coverage of the real paths": register path (Task 2), re-bind path (Task 3), CI execution (Task 4). The external-audit half of the roadmap item is explicitly not a code task. ERC-8183 excluded with a reason recorded in the Architecture note.
- **Placeholder scan:** all steps carry complete code/commands and exact expected outputs; no TBDs.
- **Type consistency:** `_signWalletSet` is defined in Task 3 with the same signature its call sites use; Task 3 consumes Task 2's helpers by the exact names Task 2 produces; `meta()` destructuring matches `LegalMeta` field order (`src/LegalManager.sol:22-27`).
- **Known risks accepted:** public-RPC flakiness makes CI red rather than silently skipping (deliberate — a skip in CI would defeat the gap-closing); `payable(proxy)` cast needed because `LegalManager` has a `receive()`; if the live registry rejects any assumption (auto-bind, typehash, cap) the run stops and the drift is reported, per Global Constraints.
