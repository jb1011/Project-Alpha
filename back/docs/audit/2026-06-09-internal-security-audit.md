# Internal Security Audit — Smart Contract Layer

**Date:** 2026-06-09
**Scope:** `src/AgentTreasury.sol`, `src/LegalManager.sol`, `src/LegalManagerFactory.sol`, `src/interfaces/*`
**Commit audited:** `80155c7` (pre-remediation) → remediated in `549bdcb`
**Toolchain:** solc 0.8.24, evm_version `paris` (no PUSH0, Arc-compatible), optimizer 200 runs, `via_ir = true`
**Method:** three independent per-contract reviews (one per domain), then line-by-line re-verification of every code-change-worthy finding against the source. Backed by a unit + fuzz + invariant + security test suite (149 tests, ≥95% coverage on every contract).

## Result

**Zero Critical, zero High.** No fund-drain path, no access-control bypass, no reentrancy hole, no proxy/storage-layout defect. The remaining findings were Low/Medium hardening and low-likelihood fund-stranding/griefing edges — **all remediated** (see below). The contracts are considered safe to build the backend against.

## Findings & remediation

| # | Severity | Contract | Finding | Status |
|---|----------|----------|---------|--------|
| 1 | Medium | LegalManager | `sweep`/`sweepNative` were gated `whenWindingDown` only, while `finalizeDissolution` is terminal and callable by either role, and `receive()` accepts native anytime → a guardian finalizing before the manager sweeps (or USDC arriving after `Dissolved`) permanently stranded those funds. | **Fixed** — new `whenDissolving` modifier allows sweeps in `WindingDown` **or** `Dissolved`; status stays terminal, only asset recovery is permitted post-dissolution. |
| 2 | Medium | AgentTreasury | No upper bound on policy `period`: a near-max value overflows `windowStart + period` (checked-math revert) bricking `available()`/`spend`; `cap = 0` freezes spending. Manager-griefing, mitigated by guardian veto. | **Fixed** — `MAX_POLICY_PERIOD = 365 days` enforced in constructor and `schedulePolicyUpdate`. |
| 3 | Low | AgentTreasury | Constructor accepted `payoutAddress == operator` (emergency-withdraw would return funds to the agent's hot key) and a non-contract `legalManager` (would revert every spend via `status()`). Both immutable. | **Fixed** — constructor rejects `payoutAddress == operator` (`RolesMustDiffer`) and `legalManager.code.length == 0` (`NotAContract`). |
| 4 | Low | LegalManagerFactory | `entityByAgentId`/`treasuryByAgentId` written unconditionally; a misbehaving/upgraded registry returning a non-monotonic `agentId` would silently orphan an existing entity. | **Fixed** — guard reverts `AgentIdAlreadyUsed(agentId)` before recording. |
| 5 | Low | both | `liftVeto` was unconditional, emitting `VetoLifted` for never-vetoed IDs. | **Fixed** — reverts `NotVetoed` unless the hash/tuple was actually vetoed. |

### Deliberate non-changes

- **Policy grace/expiry (AgentTreasury):** considered and **not** added. The guardian can already veto a pending policy at any point before execution, so the "stale policy executes later without fresh notice" concern is already mitigated; a grace window would add a new "approved-policy-silently-expired" failure mode for no net safety gain.
- **`agentWallet` points at the factory until the manager binds (Factory, Medium-operational):** cannot be fixed in-contract — canonical ERC-8004 `setAgentWallet` needs an EIP-712 signature from the wallet being bound, which a contract cannot produce on-chain. Already documented as "register-only." **Backend action:** treat `getAgentWallet(agentId)` as unreliable until the separate manager-signed binding step completes.

## Categories explicitly verified clean

Reentrancy (guards on all token-moving paths, CEI ordering), access control (every external fn), the cap/window invariant (no bypass under mid-window cap/period changes, fuzz+invariant backed), timelock + sticky-veto correctness, beacon-proxy upgradeability (ERC-7201 namespaced base storage — no collision, no `__gap` needed; V2 mock append-only), Arc native/USDC separation (no value conflation), interface signatures vs the verified canonical ERC-8004 ABI, atomicity of `createEntity`, and CREATE address determinism.

## Pre-mainnet reminders (carried from `foundry.toml`)

- Re-review the audited contracts at the **bytecode level under `via_ir`** (sources unchanged; IR codegen differs from pre-IR runs).
- All Arc confirmations to date are **testnet-era**; mainnet addresses/behavior unverified.
- `forge coverage` requires `--ir-minimum` here (because `via_ir = true`); the residual sub-100% lines/branches (`onlyGuardian` revert, `_disableInitializers`, `__ReentrancyGuard_init`) are IR source-map attribution artifacts — the code executes and is exercised by tests.
