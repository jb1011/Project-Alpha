# Contracts Security Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a demo-sprint security and quality pass over the three Solidity contracts (close the one genuinely-uncovered branch, document the remaining `--ir-minimum` coverage artifacts, then run Slither + Aderyn static analysis), producing a triaged findings report and a new test.

**Architecture:** Three phases that ship as two independent PRs. Phase 1 investigated four candidate coverage gaps test-first: exactly one was a real, closeable branch (`LegalManager.sweepNative` unauthorized caller), and it ships as a small, test-only PR A (the guaranteed win, opened first so Martin gets a fast low-risk review). The other three candidates proved to be `--ir-minimum` instrumentation artifacts already exercised behaviorally by the existing suite; Phase 1 documents them rather than adding redundant tests. Phase 2 installs and runs Slither + Aderyn and triages every finding against the accepted items in `V2_HARDENING_BACKLOG.md`; Phase 3 consolidates the report (including the coverage-artifact analysis). Phases 2-3 ship together as PR B. Both PRs branch off `main` independently, so the coverage win and the open-ended static analysis can proceed in parallel without a git dependency. This is a demo-sprint pass, not a pre-mainnet audit.

**Tech Stack:** Foundry (forge 1.5.1, solc 0.8.24, `via_ir = true`), Slither (Python/pip3 + solc-select), Aderyn (Cyfrin), forge-std tests.

## Global Constraints

- **Repo (local checkout):** `~/Desktop/Solidity_Project_Files/arc-Circle/Project-Alpha-monorepo`, remote `jb1011/Project-Alpha`. Foundry root at `back/` (contracts in `back/src/`, tests in `back/test/`). The TS brain (`back/backend/`) is out of scope. `git fetch` and verify state against `origin/main` before relying on line numbers.
- **Demo-sprint scope.** Mythril is explicitly out of scope (slow, noisy, struggles with `via_ir`); note it as a pre-mainnet item only.
- **Coverage command.** Always `forge coverage --ir-minimum` (the project sets `via_ir = true`; plain coverage fails with "stack too deep"). Forge warns its source mappings are approximate under `--ir-minimum`; treat per-file numbers as indicative.
- **Do not re-flag accepted items.** Cross-reference every analyzer finding against `back/docs/V2_HARDENING_BACKLOG.md`. The contract-relevant accepted items are inlined verbatim in Task 2.3 so triage is self-contained. An accepted item is noted as "already tracked", not raised as new.
- **Contracts are Martin's area.** This pass is entry-point #1 explicitly offered to Alex, so analysis and test additions are in scope; any change to contract SOURCE (`back/src/*.sol`) is flagged for Martin's review and not merged without his OK. Test-only additions are low-risk but still go through a PR.
- **Em-dash rule.** Em-dashes are fine as a label/heading separator (e.g. `Phase 1 — Coverage`, `Gotchas — reminders`). Do NOT use them inside a full sentence (reads as AI-written); use a colon, comma, or period there. Applies to all committed copy (report, commit messages, PR body).
- **Git.** Branch off the latest `origin/main`. Commit author resolves to `Alex Nesta` from local config. Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; PR footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Conventional commits with a scope, e.g. `test(contracts): ...`, `chore(contracts): ...`.
- **Two branches:** `test/contracts-coverage-100` (PR A, Phase 1), `chore/contracts-security-pass` (PR B, Phases 2-3). Each phase below opens with its exact branch setup so it can be run as a self-contained session.

**Baseline coverage (captured 2026-06-27, targets re-verified against `main` 2026-06-29, source contracts only):**
- `src/LegalManagerFactory.sol`: 100% lines / 100% branches.
- `src/AgentTreasury.sol`: 100% lines, 97.06% branches (33/34).
- `src/LegalManager.sol`: 97.33% lines (73/75), 95.65% branches (22/23).

**Practical maxima under `--ir-minimum` (verified 2026-06-30):** only the `LegalManager` branch gap was real; Task 1.1 closes it (22/23 to 23/23). The other three shortfalls (`AgentTreasury.sol:88`; `LegalManager.sol:99` and `:114`) are `--ir-minimum` attribution artifacts, not missing tests, so AgentTreasury stays 33/34 branches and LegalManager 73/75 lines. Task 1.2 has the per-line breakdown; the Phase 3 report (Task 3.1) carries the full reasoning (why 100% is infeasible and the alternatives).

## File Structure

- `back/test/LegalManagerSecurity.t.sol` — MODIFY. Add one test (Task 1.1, the sweepNative unauthorized-caller branch). This is the only source/test file PR A changes; `AgentTreasury.t.sol` is left untouched because its remaining gap is an artifact (Task 1.2).
- `back/slither.config.json` — CREATE. Slither config excluding deps/test scaffolding (Task 2.1). The only committed Phase-2 source file.
- `back/.gitignore` — MODIFY. Ignore the analyzer report outputs (Tasks 2.1, 2.2).
- `back/docs/plans/2026-06-30-contracts-security-pass-plan.md` — CREATE in **PR A** (Phase 1). This plan itself, committed to the repo alongside the team's other plans. PR B does NOT re-add it (already in `main` via PR A).
- `back/docs/audit/2026-06-30-contracts-security-pass.md` — CREATE in **PR B**. The triaged findings + coverage report (Tasks 2.3, 3.1). It lives in `docs/audit/` (a findings report), NOT flat `docs/`, next to the existing `docs/audit/2026-06-09-internal-security-audit.md`.
- Untracked outputs (gitignored, never committed): `back/slither-report.json`, `back/slither-stdout.txt`, `back/slither-findings.md`, `back/aderyn-report.md`, `back/lcov.info`.

(No separate design doc for this pass: it is small and self-contained, so this plan is the only planning artifact. Martin's PRs cite both a `design/` and a `plans/` doc; ours cites just the plan.)

**Pick the right `docs/` subfolder.** `back/docs/` is foldered by document kind, so a new doc goes in the matching subfolder, not flat `docs/`: `plans/` for implementation plans, `audit/` for security/findings reports, `design/` for design docs, `research/` for research notes, `runbooks/` for ops procedures. Flat `docs/` is for repo-wide references (`SPEC.md`, `POSITIONING.md`, `V2_HARDENING_BACKLOG.md`). This pass produces a plan (→ `plans/`) and a findings report (→ `audit/`).

---

## Phase 1 — Coverage (PR A)

Four candidate gaps were located via `forge coverage --ir-minimum --report lcov` and investigated test-first (2026-06-30). The investigation is the deliverable: **exactly one was a real, closeable branch** (`LegalManager.sweepNative` unauthorized caller); the other three are `--ir-minimum` attribution artifacts already exercised by the existing suite. Task 1.1 adds the one real test; Task 1.2 records the artifact analysis for the report (no code). Test-only, so this whole phase is low-risk and ships as its own PR.

**Branch setup (run once at the start of this session):**

```bash
cd ~/Desktop/Solidity_Project_Files/arc-Circle/Project-Alpha-monorepo
git checkout main && git pull origin main
git checkout -b test/contracts-coverage-100
cd back && forge test 2>&1 | tail -5   # baseline: expect all green before touching anything
```

> **Execution note (2026-06-30):** Phase 1 was executed in a worktree at `~/Desktop/Solidity_Project_Files/arc-Circle/pa-worktrees/test-contracts-coverage-100` (branch `test/contracts-coverage-100`). Because `back/lib` is gitignored (forge-std + OZ are not submodules), a fresh worktree needs `cp -R <main-checkout>/back/lib back/lib` before `forge build`/`forge test` will resolve imports. The branch now holds a single commit (the Task 1.1 test) on top of `origin/main`.

### Task 1.1: LegalManager sweepNative unauthorized caller — the one real branch (`src/LegalManager.sol:220`)

**Files:**
- Modify: `back/test/LegalManagerSecurity.t.sol` (add one test to `LegalManagerSecurityTest`; no new import).

**Interfaces:**
- Consumes: `LegalManagerSecurityTest.setUp` (already dissolves + warps past the timelock, so an unauthorized caller reaches line 220), `lm` (the manager under test), `treasury` (sweep target), `LegalManager.NotAuthorized` selector (`src/LegalManager.sol:50`).
- Produces: `src/LegalManager.sol` branch at `:220` covered; branches 22/23 to 23/23 (100%).

- [ ] **Step 1: Write the test** — add inside `contract LegalManagerSecurityTest`:

```solidity
    // --- branch: sweepNative rejects a caller who is neither manager nor guardian ---
    function test_sweepNativeRevertsForUnauthorizedCaller() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        lm.sweepNative(treasury);
    }
```

- [ ] **Step 2: Run it** — `cd back && forge test --match-test test_sweepNativeRevertsForUnauthorizedCaller -vvv`
  Expected: PASS (reverts NotAuthorized). If it does not revert, that is a real finding for Task 3.1; stop.

- [ ] **Step 3: Confirm the branch closed** — `cd back && forge coverage --ir-minimum --summary 2>/dev/null | grep "src/LegalManager.sol"`
  Expected: branches now 100% (23/23). Lines stay 73/75 (the two uncovered lines are artifacts, see Task 1.2).

- [ ] **Step 4: Commit** — `git add back/test/LegalManagerSecurity.t.sol && git commit -m "test(contracts): cover sweepNative unauthorized-caller rejection"`

### Task 1.2: Document the three `--ir-minimum` coverage artifacts (no test code)

The other three candidate gaps were each investigated and proven to be instrumentation artifacts, not missing coverage: the code executes under existing tests, but `forge coverage --ir-minimum` does not credit the counter (forge warns its IR-minimum source mappings are approximate). Adding tests for these moves no number and only adds redundant, misleading "coverage" tests, so we document them instead. This analysis feeds the report's coverage section (Task 3.1).

**Files:** none (analysis only; recorded here and carried into Task 2.3 / 3.1).

**Interfaces:**
- Consumes: `lcov.info` from a `forge coverage --ir-minimum --report lcov` run; the existing test suite.
- Produces: a written artifact-vs-gap conclusion for each of the three, for the report.

- [ ] **Step 1: `AgentTreasury.sol:88` (`onlyGuardian` modifier) — artifact.** Four existing tests already assert the `NotGuardian` revert (`AgentTreasury.t.sol:167,240,535,543`), yet the branch counter stays 33/34. A fifth identical test (an earlier draft's `test_pauseRevertsForNonGuardian`) passed but moved nothing. Conclusion: artifact; 33/34 is the practical max. No test added.

- [ ] **Step 2: `LegalManager.sol:99` (`_disableInitializers()`, constructor) — artifact.** Already exercised by `test_implementationIsLockedAgainstInitialize` (`LegalManager.t.sol:69`), which deploys the implementation and asserts a direct `initialize` reverts. The line runs; the counter does not move. A duplicate `test_implementationCannotBeInitialized` was confirmed redundant. Conclusion: artifact. No test added.

- [ ] **Step 3: `LegalManager.sol:114` (`__ReentrancyGuard_init()`) — artifact.** Runs on every proxy deploy in `LegalManagerSecurityTest.setUp` (and elsewhere). Neighboring `initialize` lines are credited while 114 alone is not, the signature of an IR inlining/optimization artifact. Conclusion: artifact; with 99 it accounts for the 73/75 line max. No test added.

- [ ] **Step 4: Record.** These three conclusions go verbatim into the report's coverage section (Task 3.1). PR A's body states the one real branch closed and lists the three documented artifacts so the reviewer is not surprised that coverage is not a round 100%.

### Task 1.3: Commit this plan into the repo (PR A carries the docs)

Martin's PRs always cite their plan under `back/docs/plans/`. We do the same: this plan ships with PR A so the work and its plan land together. PR B will reference it as already-merged and not re-add it.

**Files:**
- Create: `back/docs/plans/2026-06-30-contracts-security-pass-plan.md` (copy of this plan).

**Interfaces:**
- Consumes: the vault copy of this plan.
- Produces: the plan doc in `main` (via PR A), referenced by both PR bodies.

- [ ] **Step 1: Copy the plan into the repo** (from the worktree root)

```bash
cd ~/Desktop/Solidity_Project_Files/arc-Circle/pa-worktrees/test-contracts-coverage-100
cp "/Users/xandev/Documents/My Obsidian Library/AI/Ideas and Projects/Agent Legal Body (ProjectAlpha)/Agent Legal Body - Contracts Security Pass Plan.md" \
   back/docs/plans/2026-06-30-contracts-security-pass-plan.md
```

- [ ] **Step 2: Commit it** — `git add back/docs/plans/2026-06-30-contracts-security-pass-plan.md && git commit -m "docs(contracts): add the security-pass plan"`

### Task 1.4: Ship PR A

**Files:** none changed; this task pushes and opens the PR.

**Interfaces:**
- Consumes: the commits from Tasks 1.1 and 1.3 (the one test + the plan doc).
- Produces: open PR A on `jb1011/Project-Alpha`; its number + coverage delta are referenced by PR B (Task 3.1).

- [ ] **Step 1: Full suite once** — `cd back && forge test 2>&1 | tail -5` (expect all green; baseline 160 + 1 new = 161).

- [ ] **Step 2: Push and open the PR with a Martin-style body**

```bash
cd ~/Desktop/Solidity_Project_Files/arc-Circle/pa-worktrees/test-contracts-coverage-100
git push -u origin test/contracts-coverage-100
cat > /tmp/pa_prA_body.md <<'EOF'
## Contracts coverage pass (security-pass Phase 1)

Closes the one genuinely-uncovered branch in the production contracts and documents the remaining coverage shortfalls as `--ir-minimum` instrumentation artifacts. Test-only. First of two PRs in the demo-sprint contracts security pass; PR B (Slither + Aderyn + findings report) follows off `main`.

- Plan: `back/docs/plans/2026-06-30-contracts-security-pass-plan.md` (added in this PR)

### What's new
- `test_sweepNativeRevertsForUnauthorizedCaller` covers the unauthorized-caller revert in `LegalManager.sweepNative` (`:220`), closing the one real open branch (22/23 to 23/23).

### Coverage notes (`forge coverage --ir-minimum`)
The other three candidate gaps proved to be `--ir-minimum` attribution artifacts (forge warns its IR-minimum source mappings are approximate); each is already exercised behaviorally, so no redundant tests were added:
- `AgentTreasury.sol:88` (`onlyGuardian`): already asserted by four existing tests; branch stays 33/34. Practical max.
- `LegalManager.sol:99` (`_disableInitializers`): already asserted by `test_implementationIsLockedAgainstInitialize`; line stays uncredited.
- `LegalManager.sol:114` (`__ReentrancyGuard_init`): runs on every proxy deploy in `setUp`; line stays uncredited. With `:99`, lines stay 73/75.

### Coverage delta
- `LegalManager.sol`: branches 22/23 to 23/23 (100%); lines unchanged at 73/75 (artifacts above).
- `AgentTreasury.sol`: unchanged at 33/34 branches (artifact above), 100% lines.
- `LegalManagerFactory.sol`: unchanged at 100%.

### Testing
- Full forge suite: 161 passed, 0 failed, 0 skipped.
- No contract source touched. One test added plus the plan doc.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
gh pr create --base main \
  --title "test(contracts): cover sweepNative branch + document coverage artifacts" \
  --body-file /tmp/pa_prA_body.md
```
Confirm the final suite/coverage numbers from the actual run before opening. Keep the em-dash rule (none inside sentences).

---

## Phase 2 — Static analysis (PR B)

Independent of Phase 1. Branch off `main` again (do not stack on the coverage branch, so the two PRs review cleanly). Tool installs can fail; that is fine, this phase is isolated from the coverage win.

**Branch setup (run once at the start of this session):**

```bash
cd ~/Desktop/Solidity_Project_Files/arc-Circle/Project-Alpha-monorepo
git checkout main && git pull origin main
git checkout -b chore/contracts-security-pass
```

### Task 2.1: Install and run Slither

**Files:**
- Create: `back/slither.config.json`.
- Modify: `back/.gitignore` (ignore `slither-report.json`, `slither-stdout.txt`).

**Interfaces:**
- Produces: `slither-report.json` + `slither-stdout.txt` (raw finding lists consumed by Task 2.3).

- [ ] **Step 1: Install Slither and a matching solc**

macOS Homebrew Python is externally managed (PEP 668), so a bare `pip3 install` fails with "externally-managed-environment". Use pipx (do NOT use `--break-system-packages`, it can corrupt Homebrew Python):

```bash
brew install pipx
pipx ensurepath          # adds ~/.local/bin to PATH
exec $SHELL -l           # reload shell so PATH takes effect
pipx install slither-analyzer
pipx install solc-select
solc-select install 0.8.24
solc-select use 0.8.24
slither --version        # confirm it resolves solc 0.8.24
```

Fallback (one shared venv, guarantees slither + solc on the same PATH; must `source` it each session):

```bash
python3 -m venv ~/.venvs/slither && source ~/.venvs/slither/bin/activate
pip install slither-analyzer solc-select
solc-select install 0.8.24 && solc-select use 0.8.24
slither --version
```

- [ ] **Step 2: Config that excludes deps and test scaffolding** — create `back/slither.config.json`:

```json
{
  "filter_paths": "lib/|test/",
  "exclude_informational": false,
  "exclude_low": false,
  "solc_remaps": [
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/"
  ]
}
```

- [ ] **Step 3: Run Slither** (from `back/`): `slither . --foundry-compile-all --json slither-report.json 2>&1 | tee slither-stdout.txt`
  Expected: Slither drives `forge build` (honors `via_ir`), then prints findings by severity. If crytic-compile cannot find solc, confirm `solc-select use 0.8.24` is active. Capture both the JSON and the human-readable stdout.

- [ ] **Step 4: Commit the config only** — `cd back && printf 'slither-report.json\nslither-stdout.txt\n' >> .gitignore && git add back/slither.config.json back/.gitignore && git commit -m "chore(contracts): add slither config for the security pass"`

### Task 2.2: Install and run Aderyn

**Files:**
- Modify: `back/.gitignore` (ignore `aderyn-report.md`).

**Interfaces:**
- Produces: `aderyn-report.md` (raw finding list consumed by Task 2.3).

- [ ] **Step 1: Install Aderyn** (no cargo present; use the Cyfrin installer)

```bash
curl -L https://raw.githubusercontent.com/Cyfrin/aderyn/dev/cyfrinup/install | bash
exec "$SHELL" -l
cyfrinup
aderyn --version
```
Fallback: `brew install cyfrin/tap/aderyn`.

- [ ] **Step 2: Run Aderyn** (from `back/`): `aderyn . --output aderyn-report.md`
  Expected: reads `foundry.toml` (remappings, src), parses the contracts, writes a Markdown High/Low report. Does not need solc.

- [ ] **Step 3: Gitignore the report** — `cd back && echo "aderyn-report.md" >> .gitignore && git add back/.gitignore && git commit -m "chore(contracts): ignore aderyn report output"`

### Task 2.3: Triage findings into a report skeleton

**Files:**
- Create: `back/docs/audit/2026-06-30-contracts-security-pass.md`.

**Interfaces:**
- Consumes: `slither-report.json` / `slither-stdout.txt` (Task 2.1), `aderyn-report.md` (Task 2.2), and the inlined accepted-items list below.
- Produces: the consolidated, triaged report that Task 3.1 finishes.

- [ ] **Step 1: Triage** — classify each Slither/Aderyn finding into exactly one bucket:
  1. **Real and actionable** (fix this pass) - genuine issue, clear low-risk fix.
  2. **Already tracked** - matches an item below; cite it. Do not re-raise.
  3. **Noise / false positive** - one sentence why (mock, known-safe pattern, detector misunderstands the design).

  **Accepted contract items already in `V2_HARDENING_BACKLOG.md` (do NOT re-raise; these are the likely Slither/Aderyn hits):**
  - 🔴 **policy nonce / signature replay** — the canonical ERC-8004 registry's `AgentWalletSet` typehash carries no nonce, so an authorized caller can replay within the deadline. Property of the canonical contract, not ours. Mitigation: short deadlines (<= registry cap), one-shot treatment. (Backlog: "On-chain binding" + "Phase-1 contracts: policy nonce".)
  - 🟠 **storage `__gap`** — reserve `__gap` slots in upgradeable contracts before adding state. (Backlog: "Phase-1 contracts: storage gap".)
  - 🟠 **beacon owner → multisig/timelock** — `beaconOwner == deployer` (a testnet key) today; move to multisig/timelock before production. It controls upgrades. (Backlog: "Deployment / ops".)
  - 🟠 **live `register()` fork-test** — exercise the real ERC-8004 register path on a fork. (Backlog: "Phase-1 contracts".)
  - 🟡 **`via_ir` bytecode re-review** — review IR-optimized bytecode before mainnet. (Backlog: "Phase-1 contracts".)
  - Centralization / owner-power flags (guardian pause, sweep, setOperator, manager timelock) are the intended governance design, not findings. Note once and move on.

- [ ] **Step 2: Report skeleton** — create `back/docs/audit/2026-06-30-contracts-security-pass.md` with: scope, tools + versions, the triage table (finding, tool, severity, bucket, note), and a "coverage" section left for Task 3.1. No em dashes inside sentences.

- [ ] **Step 3: Commit** — `git add back/docs/audit/2026-06-30-contracts-security-pass.md && git commit -m "docs(contracts): triaged static-analysis findings (slither + aderyn)"`

---

## Phase 3 — Synthesis and handoff (PR B)

### Task 3.1: Finalize the report and ship PR B

**Files:**
- Modify: `back/docs/audit/2026-06-30-contracts-security-pass.md`.

**Interfaces:**
- Consumes: the triage table (Task 2.3), the coverage delta from PR A (Phase 1), the Task 1.2 artifact conclusions.
- Produces: the finished report; open PR B.

- [ ] **Step 1: Fill the coverage section** — this section carries the full coverage-artifact reasoning (the plan's Practical maxima block is deliberately terse and points here). Write all of the following into `back/docs/audit/2026-06-30-contracts-security-pass.md`:

  **a. Before/after table** for the three source contracts:
  - `LegalManager.sol`: branches 22/23 to 23/23 (100%), closed by the Phase-1 `test_sweepNativeRevertsForUnauthorizedCaller` (PR A); lines unchanged at 73/75.
  - `AgentTreasury.sol`: branches unchanged at 33/34; lines 100% (99/99).
  - `LegalManagerFactory.sol`: unchanged at 100% / 100%.

  **b. What the number measures** (so the gap reads correctly): `forge coverage` injects markers into compiled bytecode and maps hits back to source lines via the compiler source map, so the percentage trusts that map. The project sets `via_ir = true`; plain `forge coverage` fails "stack too deep", which forces `--ir-minimum`, and forge warns its IR-minimum source maps are approximate. The three shortfalls are executed code the map fails to attribute, not untested paths.

  **c. Per-line artifact findings** (from Task 1.2), each with the existing test that already exercises it:
  - `AgentTreasury.sol:88` (`onlyGuardian`): asserted by `AgentTreasury.t.sol:167,240,535,543`. The modifier is inlined into each guarded function, so the revert-branch marker merges into the caller's mapping.
  - `LegalManager.sol:99` (`_disableInitializers`, constructor): asserted by `test_implementationIsLockedAgainstInitialize` (`LegalManager.t.sol:69`). Constructor-time internal call, inlined.
  - `LegalManager.sol:114` (`__ReentrancyGuard_init`): runs on every proxy deploy in `setUp`; neighboring `initialize` lines are credited, this line alone is not.
  - Evidence it is an artifact: tests written specifically for `:88` and `:99` during this pass passed but moved the counter by zero. Already-covered code cannot be covered more.

  **d. Why 100% is infeasible and why we did not chase it:** nothing is behaviorally untested, so no test can move these numbers. Only changing compiler output would, and every lever is worse than the shortfall: disabling `via_ir` does not compile (the reason `--ir-minimum` exists), refactoring audited contract source to satisfy a coverage tool is backwards and risky (contracts are Martin's area), and excluding or annotating the lines just fakes the number. Tests that pass but move no coverage are negative value: they read as "the gap we closed" while asserting nothing new, which is why the two redundant drafts (onlyGuardian, init-lock) were dropped.

  **e. Alternatives (legitimate):** (1) report the practical max honestly with this footnote (done here); (2) verify behaviorally by reading, since the tool cannot credit it (each artifact line has a named asserting test, listed above); (3) if a CI coverage gate is ever added, set the threshold at the practical max or explicitly exclude the documented artifact lines with rationale, rather than chase 100%; (4) for pre-mainnet assurance, mutation testing and the Slither/Aderyn pass plus a real audit are stronger signals than line coverage; (5) a future forge version may map these correctly with no test or source change.

  **f. Calibration:** the artifact conclusion is verified empirically (tests pass, counter unmoved, each line has an existing asserting test). The precise per-line compiler mechanism (inlining vs. map-merge) is a well-grounded explanation, not bytecode-disassembled; state it as such. Reference PR A for the test commit.

- [ ] **Step 2: Verdict** — for each "real and actionable" finding: fix now (test-first, separate task, any contract-source change flagged for Martin) or defer (append to `V2_HARDENING_BACKLOG.md` with severity, why-acceptable-for-v1, fix direction). If zero real findings, state it plainly with grant framing ("static analysis surfaced no new actionable issues beyond the documented backlog").

- [ ] **Step 3: Note the optional CI follow-up** — record (do not implement unless asked) that Slither + Aderyn could be a non-blocking CI job mirroring the existing `.github/workflows/ci.yml` Contracts (forge) job.

- [ ] **Step 4: Commit and run the full suite once** — `cd back && forge test 2>&1 | tail -5` (expect green), then `git add back/docs/audit/2026-06-30-contracts-security-pass.md && git commit -m "docs(contracts): finalize security-pass report (coverage + verdict)"`

- [ ] **Step 5: Push and open PR B with a Martin-style body**

```bash
cd ~/Desktop/Solidity_Project_Files/arc-Circle/Project-Alpha-monorepo
git push -u origin chore/contracts-security-pass
cat > /tmp/pa_prB_body.md <<'EOF'
## Contracts security pass — static analysis (Phase 2-3)

Slither + Aderyn static analysis over the three production contracts, with a triaged findings report. Second of two PRs in the demo-sprint security pass; the coverage work merged in PR A (#<A>).

- Report: `back/docs/audit/2026-06-30-contracts-security-pass.md` (added in this PR)
- Plan: `back/docs/plans/2026-06-30-contracts-security-pass-plan.md` (merged in PR A, not re-added here)

### What's new
- `back/slither.config.json`: Slither config (filters `lib/`+`test/`, OZ remappings).
- `back/docs/audit/2026-06-30-contracts-security-pass.md`: triaged findings + coverage report.
- `.gitignore`: analyzer outputs (Slither/Aderyn reports) ignored.

### Findings (triage)
- Real and actionable: <N> (<list, or "none">).
- Already tracked in `V2_HARDENING_BACKLOG.md`: <list the matched items>.
- Noise / false positive: <count>; reasons in the report.

<Verdict line, e.g.: "Static analysis surfaced no new actionable issues beyond the documented backlog.">

### Tools
- Slither <ver>, Aderyn <ver>, solc 0.8.24, forge 1.5.1. Mythril excluded (pre-mainnet only).

### Non-blocking follow-up
- Slither + Aderyn could run as a non-blocking CI job mirroring the existing Contracts (forge) job in `.github/workflows/ci.yml`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
gh pr create --base main \
  --title "chore(contracts): security pass (slither + aderyn)" \
  --body-file /tmp/pa_prB_body.md
```
Fill the `<...>` placeholders from the actual run. Any contract-source change is flagged inline for Martin. PR B adds the findings report but NOT the plan (it is already in `main` from PR A).

---

## Self-Review

**1. Spec coverage:** Phase 1 investigated all four `forge coverage` candidates by exact line (executed 2026-06-30): one real branch closed by a test (Task 1.1), three documented as `--ir-minimum` artifacts (Task 1.2). Phase 2 covers Slither + Aderyn; Mythril excluded per Global Constraints. Phase 3 produces the report and the Martin handoff. Two-PR split (coverage first) per the 2026-06-29 decision.

**2. Placeholder scan:** Task 1.1 carries exact test code and an exact line target. Task 1.2 carries the per-line artifact conclusions with the exact existing tests that already exercise each line. Phase 2 carries exact install/run commands and the inlined accepted-items list. The only intentionally-open items are findings-dependent (the nature of an audit), bounded by an explicit triage method (Task 2.3) and a decision step (Task 3.1).

**3. Type consistency:** the error selector used in the one Phase-1 test (`LegalManager.NotAuthorized` `src/LegalManager.sol:50`) matches source; the artifact-documentation selectors (`AgentTreasury.NotGuardian` `src/AgentTreasury.sol:62`, `Initializable.InvalidInitialization` OZ upgradeable) are referenced for the existing tests, not re-added. Test base names (`AgentTreasuryTestBase`, `LegalManagerSecurityTest`) match the existing files. The two branch names (`test/contracts-coverage-100`, `chore/contracts-security-pass`), the plan doc (`back/docs/plans/2026-06-30-contracts-security-pass-plan.md`, added in PR A only), and the report (`back/docs/audit/2026-06-30-contracts-security-pass.md`, added in PR B only) are used consistently across phases. Both PR bodies follow the house structure (title + context line, docs links, What's new, delta/findings, Testing/Tools, footer).

**Risk:** Phase 1 is test-only (low risk) and ships first; any contract-source fix from Phase 2 is gated on Martin. Tool installs (pip3, Cyfrin) are the main environment change, isolated to Phase 2 so they cannot block the coverage win.
