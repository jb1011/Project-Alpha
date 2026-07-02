# Contracts Security Pass — Static Analysis Report (2026-06-30)

Demo-sprint security and quality pass over the three production Solidity contracts. This document covers Phase 2-3 (static analysis with Slither and Aderyn, plus triage). The Phase 1 coverage work shipped separately in PR #9. Plan: `docs/plans/2026-06-30-contracts-security-pass-plan.md`.

This is a demo-sprint pass, not a pre-mainnet audit. It is not a substitute for a manual security review.

## Scope

In scope (source contracts only):

| Contract | nSLOC |
| --- | --- |
| `src/AgentTreasury.sol` | 206 |
| `src/LegalManager.sol` | 175 |
| `src/LegalManagerFactory.sol` | 100 |
| `src/interfaces/*` | 51 |

Out of scope: `lib/` (dependencies), `test/` (scaffolding), `backend/` (the TS brain). Mythril is excluded by design (slow, noisy, struggles with `via_ir`); note it as a pre-mainnet item only.

## Tools and versions

| Tool | Version | Notes |
| --- | --- | --- |
| Slither | 0.11.5 | run with `--foundry-compile-all` so compilation goes through `forge build` and honors `via_ir = true` |
| Aderyn | 0.6.8 | Cyfrin; own Rust parser, ingested 6 compiled files under solc 0.8.24 |
| solc | 0.8.24 | supplied by forge; pinned in `foundry.toml` |
| forge | 1.5.1 | `via_ir = true` |

Config: `back/slither.config.json` filters `lib/` and `test/` from findings and mirrors the Foundry OZ remappings. Raw outputs (`slither-report.json`, `slither-stdout.txt`, `aderyn-report.md`) are gitignored.

### Install note (for teammates reproducing this)

- **Slither:** install into a disposable venv, and use `pip install --prefer-binary slither-analyzer`. Without `--prefer-binary`, pip can pick a `cbor2` version that has no prebuilt wheel for the platform and tries to compile it from source, failing with "can't find Rust compiler". `--prefer-binary` selects a wheel-backed version instead. On very new Pythons (3.14) build the venv with `python3.13`.
- **Aderyn:** the `dev`-branch `cyfrinup` curl installer returned 404; `brew install cyfrin/tap/aderyn` worked.

## Triage

Each finding is classified into exactly one bucket: **real and actionable**, **already tracked** (matches `docs/V2_HARDENING_BACKLOG.md`), or **noise / false positive**. The two tools overlap on the reentrancy and loop findings, deduped below.

| # | Finding | Tool(s) | Severity | Bucket | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | State write after external call in `createEntity` | Slither (benign) + Aderyn H-1 | High (Aderyn) / benign (Slither) | Noise / false positive | See detail below. No exploit path. Confirmed benign by second reviewer (Martin) 2026-07-01. |
| 2 | `block.timestamp` comparisons (×4) | Slither | Low | Noise (by design) | Day-scale timelocks and spend windows; ~12s validator skew is irrelevant at this granularity. |
| 3 | External call in loop + `require` in loop (`sweep`) | Slither + Aderyn L-4 | Low | Noise (by design) | Admin supplies a bounded token list; revert-all-on-bad-token is the intended semantics. |
| 4 | Low-level `.call{value:}()` in `sweepNative` | Slither | Informational | Noise | This is the recommended pattern for forwarding native value, with the `ok` return checked. |
| 5 | Centralization risk (owner powers) | Aderyn L-1 | Low | Already tracked / intended | The managed-service design: `createEntity` is `onlyOwner` by spec. Governance hardening tracked as "beacon owner → multisig/timelock" in the backlog. |
| 6 | `PolicyUpdated` address param not indexed | Slither | Informational | Real, trivial → deferred | Source nit. Deferred to backlog. |
| 7 | Local var shadows state var (×4, `AgentTreasury`) | Aderyn L-2 | Low | Real, trivial → deferred | Source nit. Deferred to backlog. |
| 8 | `nonReentrant` not first modifier (×5) | Aderyn L-3 | Low | Noise / defensible | The access modifiers make no external calls, so no through-modifier reentrancy. Optional reorder deferred to backlog. |
| 9 | Unspecific pragma `^0.8.24` | Aderyn L-5 | Low | Real, trivial → deferred | Source nit. Deferred to backlog (pin before mainnet). |
| 10 | `available()` public, unused internally | Aderyn L-6 | Low | Real, trivial → deferred | Source nit. Deferred to backlog. |

### Detail — finding #1, `createEntity` reentrancy (Aderyn High, Slither benign)

Aderyn flags `LegalManagerFactory.createEntity` High for writing state (`entities.push`, `entityByAgentId`, `treasuryByAgentId`) after external calls (`identityRegistry.register`, the proxy deploy, `identityRegistry.transferFrom`). Reviewed against the source (`src/LegalManagerFactory.sol:73-109`):

- The function is `external onlyOwner`. Only the KYC'd platform owner (the controller-of-record) can call it, so there is no attacker entry point.
- The external-call targets are trusted: `identityRegistry` is set once in the constructor (the canonical ERC-8004 registry), not a per-call user-supplied address.
- Line 98 uses `transferFrom`, not `safeTransferFrom`, so it triggers no `onERC721Received` callback into `manager`. The `register` call's `_safeMint` lands on the factory's own `IERC721Receiver`, not attacker code.
- There is an explicit duplicate-id guard (`if (entityByAgentId[agentId] != address(0)) revert AgentIdAlreadyUsed`) before the writes.

**Independent re-verification (2026-06-30).** The four mitigating facts were re-checked directly against source, not carried over from the detector output:
- `createEntity` is `external onlyOwner` (confirmed at `src/LegalManagerFactory.sol:83`).
- `identityRegistry` is assigned once, in the constructor (`:63`), so it is not a per-call user-supplied address.
- Line 98 is `transferFrom`, not `safeTransferFrom`, so no `onERC721Received` callback fires into `manager` (`:98`); the `register` call's `_safeMint` lands on the factory's own `IERC721Receiver`, not attacker code.
- The duplicate-id guard `if (entityByAgentId[agentId] != address(0)) revert AgentIdAlreadyUsed(agentId)` is present (`:102`).

Each external call in `createEntity` therefore targets either the owner-gated, constructor-set trusted registry or a freshly deployed contract, so no attacker-controlled callback is reachable. On that reading there is no reentrancy exploit path, and Slither's "benign" classification is the correct one. An optional checks-effects-interactions tidy-up (move the writes before the `transferFrom`) would silence the detector but changes no behavior; it is not required and touches source, so it is left to Martin's discretion.

> **Second-reviewer sign-off (2026-07-01) — CLOSED.** The analysis above points to a false positive, but a High-severity finding should not be downgraded on a single reviewer's read, so it was held OPEN for a second set of eyes. Martin independently re-verified it adversarially against source — including `LegalManager.initialize` (makes zero external calls), the `AgentTreasury` constructor (its only external touch is `EXTCODESIZE` on the fresh proxy, not a `CALL`), the `BeaconProxy` deploy, and the `Ownable2Step` re-entry gate (re-entering `createEntity` reverts at `onlyOwner`; ownership cannot be seized or renounced) — and confirmed the benign classification. `identityRegistry` is `immutable` and a duplicate `agentId` reverts atomically via the `AgentIdAlreadyUsed` guard, so nothing moves value to a caller-controlled address. **Finding closed as a confirmed false positive.**
>
> **Optional CEI hardening (follow-up).** Martin noted the checks-effects-interactions tidy-up (move the three writes + the `AgentIdAlreadyUsed` guard ahead of the `transferFrom` at `:98`) is worth doing not to silence the detector but to remove a latent foot-gun: if `:98` ever became `safeTransferFrom`, today's write-after-call ordering would become reentrancy-exploitable via a `manager` callback. It is mechanical and behavior-preserving, with no live bug today. Done as a follow-up hardening PR (#15), which also adds a reentrancy canary asserting the identity transfer fires no `manager` callback.

## Coverage (Phase 1, shipped in PR #9)

Phase 1 closed the last reachable coverage branch and documented the remainder as instrumentation artifacts. Numbers below are from PR #9 (`forge coverage --ir-minimum`); they are reproduced here so this report is a complete record of the pass, not re-derived in this PR.

| Contract | Branches | Lines | Notes |
| --- | --- | --- | --- |
| `LegalManagerFactory.sol` | 100% | 100% | unchanged |
| `LegalManager.sol` | 22/23 → **23/23** | 73/75 | `sweepNative` unauthorized-caller branch closed by a Phase-1 test |
| `AgentTreasury.sol` | 33/34 | 100% (99/99) | the uncovered `onlyGuardian` branch is an `--ir-minimum` attribution artifact |

Artifacts (not real gaps, already covered behaviorally, do not chase under `--ir-minimum`):
- `AgentTreasury.sol` `onlyGuardian` branch: four existing tests already assert `NotGuardian` reverts, yet the counter does not move under `--ir-minimum`.
- `LegalManager.sol` line 99 (`_disableInitializers`): already exercised by `test_implementationIsLockedAgainstInitialize`.
- `LegalManager.sol` line 114 (`__ReentrancyGuard_init`): inlined/optimized away under IR; neighboring init lines are covered.

## Verdict

Static analysis surfaced no new actionable security issues beyond the documented backlog. The one High-severity flag (createEntity reentrancy) is assessed as a false positive given the owner-gated entry, the trusted constructor-set registry, and the non-callback `transferFrom`; that assessment was independently re-verified against source and then **confirmed by a second reviewer (Martin) on 2026-07-01, closing the finding** (see the sign-off under finding #1). No items remain open. The remaining findings are either intended design (centralization, timestamp-gated timelocks, bounded admin loops, the recommended native-send pattern) or low/informational source-hygiene nits. The optional CEI hardening on `createEntity` is tracked as a follow-up PR.

The five hygiene nits (#6-10) are deferred as a batch to `docs/V2_HARDENING_BACKLOG.md` under "Static-analysis hygiene (Slither + Aderyn, 2026-06-30 security pass)". None is a security issue and all touch contract source, so they are Martin's call. No contract source was changed in this pass.

## Non-blocking follow-up (not implemented)

Slither and Aderyn could run as a non-blocking CI job mirroring the existing Contracts (forge) job in `.github/workflows/ci.yml`. Recorded here as an option, not implemented in this PR.
