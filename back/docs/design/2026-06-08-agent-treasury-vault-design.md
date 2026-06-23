# Design: `AgentTreasury` vault

> **Status:** Approved design (2026-06-08), ready for implementation plan. Produced via the brainstorming skill.
> **Companion to:** `2026-06-08-wallet-and-treasury-architecture.md` (the architecture decision this implements), `LegalManager.sol`, `LegalManagerFactory.sol`.
> **Confidence:** Architecture inputs verified via deep-research runs `wqp1sm6g1` + `w6nrzmk2b` (2026-06-08). ⚠️ Arc = testnet only; mainnet unverified.

---

## 1. Purpose

Give each agent legal body a **non-custodial, on-chain treasury** that enforces the LLC operating
agreement's spending rules in code. The agent (a non-custodial **Turnkey EOA**) spends autonomously
**within a capped, governed envelope**; the human registrant holds **instant safety powers**; the
platform holds **no fund authority**. This is the **Tier-1 treasury** of the two-tier design — it holds
the bulk USDC and replenishes the agent's hot operating balance for x402/Gateway/nanopayments.

It is a **separate contract from `LegalManager`** (chosen for isolation): `LegalManager` stays the
legal identity + lifecycle + governance layer; `AgentTreasury` isolates the high-value, high-frequency
fund-movement logic so a bug there cannot touch the operating-agreement / dissolution machinery.

## 2. Roles (set once at construction)

| Role | Who | Powers |
|---|---|---|
| `operator` | agent's **Turnkey EOA** | capped `spend` / `fundOperator` only — no policy changes, no free withdraw |
| `guardian` | **human registrant** (same human as the `LegalManager` guardian) | **instant** (no timelock): `pause`, `setOperator` (rotate/revoke), `emergencyWithdraw`, allowlist edits; **veto** policy changes |
| `manager` | **platform** | *propose* policy changes (timelocked, guardian-vetoable). **No fund access whatsoever.** |
| `legalManager` | the agent's `LegalManager` contract | lifecycle authority — its `status` gates spending (dissolution lock) |

Only `operator` moves funds, and only within the cap. Only `guardian` can rescue funds, and only to the
fixed `payoutAddress`. The platform can never move funds.

## 3. Custody / trust model

- **Immutable contract — no upgrade key.** No party can swap the code; therefore no party can drain the
  vault beyond the on-chain rules. (An upgradeable vault's upgrade key = de-facto custody — rejected.)
- **Provider holds nothing:** the key is a Turnkey enclave key; Turnkey/the platform cannot exceed the cap.
- **Human override is bounded:** the guardian can stop the agent and rescue funds, but *only to the
  pre-agreed `payoutAddress`* — they cannot redirect funds arbitrarily, so the human is a safety valve,
  not a custodian.

## 4. Interface

```solidity
interface IAgentTreasury {
    // ── views ──
    function operator() external view returns (address);
    function guardian() external view returns (address);
    function manager()  external view returns (address);
    function legalManager() external view returns (address);
    function usdc()     external view returns (address);
    function payoutAddress() external view returns (address); // fixed rescue destination
    function cap()      external view returns (uint256);  // max USDC per period
    function period()   external view returns (uint256);  // window length (seconds)
    function spentInWindow() external view returns (uint256);
    function windowStart()   external view returns (uint256);
    function available() external view returns (uint256); // remaining cap this window
    function allowlistEnabled() external view returns (bool);
    function isAllowed(address to) external view returns (bool);
    function paused() external view returns (bool);

    // ── operator: capped spending (onlyOperator, whenNotPaused, whenLegalActive, within cap) ──
    function spend(address to, uint256 amount) external;  // on-chain USDC payment
    function fundOperator(uint256 amount) external;       // top up hot EOA → x402/Gateway/nanopayments

    // ── guardian: instant safety (onlyGuardian, NO timelock) ──
    function pause() external;
    function unpause() external;
    function setOperator(address newOperator) external;   // rotate / revoke agent key
    function emergencyWithdraw() external;                 // sweep ALL USDC → payoutAddress
    function setAllowlistEntry(address to, bool allowed) external;

    // ── policy change: manager proposes → delay → guardian may veto → execute ──
    function schedulePolicyUpdate(uint256 newCap, uint256 newPeriod, bool allowlistOn, address newPayoutAddress)
        external returns (bytes32 policyId);              // onlyManager
    function vetoPolicyUpdate(bytes32 policyId) external;     // onlyGuardian (sticky veto — blocks until liftVeto)
    function liftVeto(bytes32 policyId) external;             // onlyGuardian (clears a veto so it can be re-proposed)
    function executePolicyUpdate(bytes32 policyId) external;  // onlyManager, after delay

    // ── events ──
    event Spent(address indexed to, uint256 amount);
    event OperatorFunded(address indexed operator, uint256 amount);
    event Paused(); event Unpaused();
    event OperatorRotated(address indexed previous, address indexed next);
    event EmergencyWithdrawn(address indexed payoutAddress, uint256 amount);
    event AllowlistUpdated(address indexed account, bool allowed);
    event PolicyUpdateScheduled(bytes32 indexed policyId, uint256 cap, uint256 period, bool allowlistOn, address payoutAddress, uint256 executableAt);
    event PolicyUpdateVetoed(bytes32 indexed policyId);
    event PolicyUpdated(uint256 cap, uint256 period, bool allowlistOn, address payoutAddress);
}
```

## 5. Key behaviors

1. **Rolling cap accounting** (Safe AllowanceModule-style). State: `spentInWindow`, `windowStart`. On any
   `spend`/`fundOperator`: if `block.timestamp >= windowStart + period`, reset `spentInWindow = 0` and
   `windowStart = block.timestamp`; then require `spentInWindow + amount <= cap`; then `spentInWindow += amount`.
   `spend` and `fundOperator` draw on the **same** cap. `available()` returns the live remaining amount.
2. **Spend paths.** `spend(to, amount)` = direct on-chain USDC transfer (SafeERC20). `fundOperator(amount)` =
   transfer to the `operator` EOA so the agent can sign x402/Gateway/nanopayments off the EOA (the confirmed
   ECDSA EIP-3009 path; no EIP-1271 dependency). If `allowlistEnabled`, `spend` requires `isAllowed(to)`;
   `fundOperator` always targets the operator EOA and is exempt from the allowlist.
3. **Emergency rescue to a fixed destination.** `emergencyWithdraw()` sends the entire USDC balance to the
   immutable-at-construction `payoutAddress` (changeable only via the policy timelock). Guardian cannot
   redirect funds elsewhere.
4. **Dissolution lock.** Reads `LegalManager.status()`. `spend`/`fundOperator` require `status == Active`.
   Once `WindingDown`/`Dissolved`, operator spending reverts; only `emergencyWithdraw` (to `payoutAddress`)
   works, so funds exit through the wind-down, not the agent.
5. **Policy changes are timelocked + guardian-vetoable**, mirroring `LegalManager`'s amendment flow:
   `manager` schedules (`executableAt = now + policyDelay`), `guardian` may veto (**sticky** — the policy
   is blocked until the guardian calls `liftVeto`, mirroring `LegalManager`), `manager` executes after the delay. This gives credible commitment that limits cannot
   change instantly. The policy tuple covers `cap`, `period`, `allowlistEnabled`, **and `payoutAddress`**
   — so even the rescue destination can only change slowly and under guardian veto. `policyDelay` is set at
   construction (reuse the `LegalManager` `amendmentDelay` value for consistency, with the same `MIN_*_DELAY`
   floor). (Adding/removing individual allowlist *entries* stays an instant guardian power — only toggling the
   allowlist on/off is part of the governed tuple.)
6. **Reentrancy + safety:** `spend`/`fundOperator`/`emergencyWithdraw` are `nonReentrant` and use SafeERC20.

## 6. Deployment & wiring

- **Immutable, one per agent.** The factory deploys a fresh `new AgentTreasury(...)` with all roles + policy
  set via the **constructor** (no initializer, no proxy, no beacon). The deployed bytecode is the entity's
  permanent treasury logic.
- **`LegalManagerFactory.createEntity` gains one new parameter: `operator`** (the agent's Turnkey EOA). In
  the same call it: registers the ERC-8004 identity, deploys the `LegalManager` beacon proxy (unchanged),
  deploys the immutable `AgentTreasury` wired to `{manager, guardian, operator, legalManager, usdc,
  payoutAddress, cap, period, policyDelay}`, and records both. `guardian` is shared with `LegalManager`.
- **`usdc` and `payoutAddress` are constructor params** — never hardcode addresses (Arc USDC =
  `0x3600…0000`, 6 decimals; confirm per chain via the Circle MCP / `use-arc`).
- **Build:** compile with `evmVersion = "paris"` (Arc rejects `PUSH0`) — same constraint as the rest of the suite.

## 7. Evolution without upgradeability

A bug or a needed feature is handled by **deploy-new + guardian-migrate**, opt-in per agent:
`pause()` → `emergencyWithdraw()` (funds → `payoutAddress`) → deploy a new `AgentTreasury` version →
move funds in. No forced global upgrade; each legal body's code is fixed unless its own guardian migrates.

## 8. MVP vs. later

- **MVP (demo):** single token (USDC), `allowlistEnabled = false` (cap-only), `spend` + `fundOperator`,
  guardian safety set, dissolution lock, timelocked policy changes. `operator` may equal the hot EOA directly.
- **Later:** turn the allowlist on per agent; multi-token; arbitrary `execute(target, data, value)` behind a
  (target, selector) allowlist (Zodiac Roles-style) for richer agent actions; treasury-direct payments via
  EIP-1271 (see §10).

## 9. Testing

Foundry, matching the suite's 100%-coverage bar. Cover: cap enforcement + window reset (boundary cases),
role gating (operator/guardian/manager separation), allowlist on/off, pause blocks spending, dissolution
lock blocks spending but allows rescue, `emergencyWithdraw` only to `payoutAddress`, policy timelock +
veto + re-propose, reentrancy guards, zero-address/zero-amount reverts. Fuzz the cap accounting.

## 10. Recorded future option — treasury-direct x402 (EIP-1271)

**Not in scope; deliberately deferred.** Today payments run through the operator EOA (ECDSA EIP-3009),
which is the confirmed-supported path. A future enhancement would let the **treasury contract itself**
sign x402/Gateway authorizations via **EIP-1271** (USDC supports contract signatures via **ERC-7598**).
Open question before adopting: whether the chosen **x402 facilitator / Circle Gateway accepts EIP-1271
contract signatures on Arc** — the x402 'exact' spec describes ECDSA recovery and does not mention
EIP-1271, so facilitator support is unconfirmed. Revisit if/when we want the vault to pay directly without
a hot EOA. (Full context: `2026-06-08-wallet-and-treasury-architecture.md` §7–8.)

## 11. Open items

- Confirm Turnkey **Delegated Access is truly indefinite** for the operator key (24/7, no session expiry).
- Decide the initial `cap`/`period`/`policyDelay` defaults (product decision).
- ⚠️ Arc **mainnet** availability + USDC/Turnkey mainnet support (all current confirmations are testnet-era).

### Before-mainnet checklist (from the final code review, 2026-06-08 — implementation is testnet-ready)
- **Re-audit bytecode under IR.** `via_ir = true` was enabled project-wide (to fix `createEntity` stack-too-deep); sources unchanged but codegen differs from the original test runs. Re-review compiled `AgentTreasury` + `LegalManager` bytecode before production.
- **Allowlist containment caveat:** even with `allowlistEnabled = true`, the operator can pull cap-bounded USDC via `fundOperator` (allowlist-exempt by design) and pay anyone off-contract. **The cap — not the allowlist — is the real bound.** Confirm the product/legal expectation before treating the allowlist as a payee whitelist.
- **Add a fuzz/invariant target that interleaves `executePolicyUpdate` with spending** (current fuzz covers cap-never-exceeded + reset-per-period only; the mid-window policy change is benign but unfuzzed).
- Confirm operational assumptions: guardian = KYC'd user-of-record; `payoutAddress` is a controlled/recoverable destination; beacon owner is a multisig/timelock.
